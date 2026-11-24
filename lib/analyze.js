// Core token analysis engine — Solana mainnet meme coins (pump.fun & DEX).
// Sources: Solana RPC, RugCheck, DexScreener, pump.fun. Every source is optional:
// if one fails, its indicators are marked "n/a" instead of breaking the report.

import {
  rpc, getJson, pmap, settle, num, sleep,
  SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, WSOL,
} from './util.js';

const PUMP_HEADERS = { origin: 'https://pump.fun', referer: 'https://pump.fun/' };
const PUMP_INITIAL_REAL_TOKENS = 793_100_000 * 1e6; // raw units, 6 decimals

export const CFG = {
  maxMcap: num(process.env.MAX_MCAP) ?? 50_000,
  sigPages: num(process.env.MAX_SIG_PAGES) ?? 5,
};

// ---------- data sources ----------
async function dexData(mint) {
  const j = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const pairs = (Array.isArray(j) ? j : j?.pairs || []).filter(Boolean);
  pairs.sort(
    (a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0) ||
      (b.volume?.h24 || 0) - (a.volume?.h24 || 0)
  );
  return { best: pairs[0] || null, pairs };
}

async function dexOrders(mint) {
  const j = await getJson(`https://api.dexscreener.com/orders/v1/solana/${mint}`);
  return Array.isArray(j) ? j : j?.orders || [];
}

async function rugReport(mint) {
  return getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeoutMs: 20000 });
}

async function pumpCoin(mint) {
  const j = await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`, { headers: PUMP_HEADERS });
  return j?.data || j;
}

async function pumpCreated(creator) {
  const j = await getJson(
    `https://frontend-api-v3.pump.fun/coins/user-created-coins/${creator}?offset=0&limit=50&includeNsfw=true`,
    { headers: PUMP_HEADERS }
  );
  return Array.isArray(j) ? j : j?.coins || j?.data || [];
}

async function mintInfo(mint) {
  const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const v = acc?.value;
  if (!v) throw new Error('Mint tidak ditemukan di mainnet');
  const info = v.data?.parsed?.info;
  if (!info || v.data?.parsed?.type !== 'mint') throw new Error('Alamat ini bukan token mint');
  return { program: v.owner, ...info, extensions: info.extensions || [] };
}

const pct = (part, whole) => {
  try {
    const p = BigInt(part), w = BigInt(whole);
    if (w === 0n) return 0;
    return Number((p * 1_000_000n) / w) / 10_000;
  } catch { return 0; }
};

async function holders(mint, supply) {
  const largest = await rpc('getTokenLargestAccounts', [mint]);
  const accs = largest?.value || [];
  if (!accs.length) return [];
  const parsed = await rpc('getMultipleAccounts', [accs.map((a) => a.address), { encoding: 'jsonParsed' }]);
  const byOwner = new Map();
  accs.forEach((a, i) => {
    const owner = parsed?.value?.[i]?.data?.parsed?.info?.owner || a.address;
    const prev = byOwner.get(owner) || 0n;
    byOwner.set(owner, prev + BigInt(a.amount));
  });
  const owners = [...byOwner.keys()];
  const oacc = await rpc('getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  return owners
    .map((o, i) => {
      const acc = oacc?.value?.[i];
      const isProgram = !!acc && acc.owner !== SYSTEM_PROGRAM;
      return { owner: o, amount: byOwner.get(o).toString(), pct: pct(byOwner.get(o), supply), isProgram, programOwner: acc?.owner || null };
    })
    .sort((a, b) => b.pct - a.pct);
}

async function tokenBalanceOf(wallet, mint) {
  const r = await rpc('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]);
  let sum = 0n;
  for (const a of r?.value || []) sum += BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || '0');
  return sum;
}

// Reads the very first transactions of the token: creation slot, dev buy, bundle and snipers.
async function launch(mint, supply) {
  let before = null, all = [], complete = false;
  for (let p = 0; p < CFG.sigPages; p++) {
    const page = await rpc('getSignaturesForAddress', [mint, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!page?.length) { complete = true; break; }
    all = all.concat(page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) { complete = true; break; }
  }
  if (!complete) return { complete: false, txSeen: all.length };
  const oldest = all.slice().reverse();
  const okSigs = oldest.filter((s) => !s.err);
  if (!okSigs.length) return { complete: true, txSeen: all.length, events: [] };
  const creationSlot = oldest[0].slot;
  const creationTime = oldest[0].blockTime;
  const firstSlots = okSigs.filter((s) => s.slot <= creationSlot + 3).length;
  const take = okSigs.slice(0, Math.min(40, Math.max(firstSlots, 25)));
  const txs = await pmap(take, 4, (s) =>
    rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
  );
  const events = [];
  let creationSigners = [];
  txs.forEach((tx, i) => {
    if (!tx || tx.__error || tx.meta?.err) return;
    const keys = tx.transaction?.message?.accountKeys || [];
    const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
    if (i === 0) creationSigners = signers;
    const delta = new Map();
    for (const b of tx.meta?.preTokenBalances || []) if (b.mint === mint && b.owner) delta.set(b.owner, (delta.get(b.owner) || 0n) - BigInt(b.uiTokenAmount.amount));
    for (const b of tx.meta?.postTokenBalances || []) if (b.mint === mint && b.owner) delta.set(b.owner, (delta.get(b.owner) || 0n) + BigInt(b.uiTokenAmount.amount));
    for (const w of signers) {
      const d = delta.get(w);
      if (!d || d === 0n) continue;
      const idx = keys.findIndex((k) => k.pubkey === w);
      const sol = idx >= 0 ? ((tx.meta.preBalances[idx] || 0) - (tx.meta.postBalances[idx] || 0)) / 1e9 : null;
      events.push({
        sig: take[i].signature, slot: tx.slot, offset: tx.slot - creationSlot, wallet: w,
        side: d > 0n ? 'buy' : 'sell', amount: (d > 0n ? d : -d).toString(), pct: pct(d > 0n ? d : -d, supply), sol,
      });
    }
  });
  return { complete: true, txSeen: all.length, creationSlot, creationTime, creationSigners, events };
}

async function walletProfile(wallet) {
  const [sigs, bal] = await Promise.all([
    rpc('getSignaturesForAddress', [wallet, { limit: 1000 }]),
    rpc('getBalance', [wallet]).catch(() => null),
  ]);
  const n = sigs?.length || 0;
  const oldestTime = n ? sigs[n - 1].blockTime : null;
  return { txCount: n, txCountCapped: n >= 1000, oldestTime, sol: bal?.value != null ? bal.value / 1e9 : null };
}

async function isFresh(wallet) {
  const sigs = await rpc('getSignaturesForAddress', [wallet, { limit: 50 }]);
  const n = sigs?.length || 0;
  const oldest = n ? sigs[n - 1].blockTime : null;
  const now = Date.now() / 1000;
  return n < 50 && oldest && now - oldest < 3 * 86400;
}

// ---------- main ----------
export async function analyzeToken(mint) {
  const t0 = Date.now();
  const [mi, dex, orders, rc, pump] = await Promise.all([
    settle(mintInfo(mint)), settle(dexData(mint)), settle(dexOrders(mint)), settle(rugReport(mint)), settle(pumpCoin(mint)),
  ]);
  if (!mi.ok) throw new Error(mi.e);
  const m = mi.v;
  const supply = m.supply;
  const R = rc.ok ? rc.v : null;
  const P = pump.ok && pump.v?.mint ? pump.v : null;
  const D = dex.ok ? dex.v.best : null;

  const creator = P?.creator || R?.creator || null;

  const [hold, lau] = await Promise.all([settle(holders(mint, supply)), settle(launch(mint, supply))]);
  const H = hold.ok ? hold.v : null;
  const L = lau.ok ? lau.v : null;
  const dev = creator || L?.creationSigners?.[0] || null;

  // Pool / curve labels
  const known = R?.knownAccounts || {};
  const poolSet = new Set([P?.bonding_curve, D?.pairAddress, ...(R?.markets || []).map((x) => x.pubkey)].filter(Boolean));
  if (H) for (const h of H) {
    h.isPool = h.isProgram || poolSet.has(h.owner);
    h.label = h.owner === dev ? 'DEV' : h.isPool ? known[h.owner]?.name || (h.owner === P?.bonding_curve ? 'Bonding Curve' : 'Pool/Program') : '';
  }

  // Launch: dev buy, bundle, snipers
  let devInitial = 0n;
  const bundle = new Map(), snipers = new Map(), earlySells = new Set();
  if (L?.events) {
    for (const e of L.events) {
      if (e.side === 'sell') { if (e.offset <= 3) earlySells.add(e.wallet); continue; }
      if (e.wallet === dev) { if (e.offset <= 3) devInitial += BigInt(e.amount); continue; }
      const map = e.offset === 0 ? bundle : e.offset <= 3 ? snipers : null;
      if (!map || (map === snipers && bundle.has(e.wallet))) continue;
      map.set(e.wallet, (map.get(e.wallet) || 0n) + BigInt(e.amount));
    }
  }
  const early = [...bundle.keys(), ...snipers.keys()].slice(0, 20);

  const [devBal, devProf, devCoins, earlyBals, fresh] = await Promise.all([
    dev ? settle(tokenBalanceOf(dev, mint)) : Promise.resolve({ ok: false }),
    dev ? settle(walletProfile(dev)) : Promise.resolve({ ok: false }),
    dev ? settle(pumpCreated(dev)) : Promise.resolve({ ok: false }),
    settle(pmap(early, 4, (w) => tokenBalanceOf(w, mint))),
    H ? settle(pmap(H.filter((h) => !h.isPool && h.owner !== dev).slice(0, 10), 4, (h) => isFresh(h.owner))) : Promise.resolve({ ok: false }),
  ]);

  const sumMap = (mp) => [...mp.values()].reduce((a, b) => a + b, 0n);
  const heldOf = (wallets) => {
    if (!earlyBals.ok) return null;
    let s = 0n;
    wallets.forEach((w) => { const i = early.indexOf(w); const v = earlyBals.v[i]; if (i >= 0 && typeof v === 'bigint') s += v; });
    return pct(s, supply);
  };

  const launchStats = L?.complete
    ? {
        bundleWallets: bundle.size, bundleBoughtPct: pct(sumMap(bundle), supply), bundleHeldPct: heldOf([...bundle.keys()]),
        sniperWallets: snipers.size, sniperBoughtPct: pct(sumMap(snipers), supply), sniperHeldPct: heldOf([...snipers.keys()]),
        earlySellers: earlySells.size, devInitialPct: pct(devInitial, supply),
        creationTime: L.creationTime, txSeen: L.txSeen,
        bundleList: [...bundle.entries()].map(([w, a]) => ({ wallet: w, pct: pct(a, supply) })).sort((a, b) => b.pct - a.pct),
      }
    : { incomplete: true, txSeen: L?.txSeen ?? null, error: lau.ok ? null : lau.e };

  const devHeldPct = devBal.ok ? pct(devBal.v, supply) : null;
  const devSoldPct = devBal.ok && devInitial > 0n ? Math.max(0, 100 - (Number((devBal.v * 10000n) / devInitial) / 100)) : null;
  let devTrack = null;
  if (devCoins.ok) {
    const others = devCoins.v.filter((c) => c.mint !== mint);
    devTrack = {
      launches: others.length, capped: devCoins.v.length >= 50,
      graduated: others.filter((c) => c.complete).length,
      best: others.sort((a, b) => (b.usd_market_cap || 0) - (a.usd_market_cap || 0)).slice(0, 3)
        .map((c) => ({ mint: c.mint, symbol: c.symbol, mcap: c.usd_market_cap, complete: c.complete })),
    };
  }

  // Market data
  const mcap = D?.marketCap ?? D?.fdv ?? P?.usd_market_cap ?? null;
  const createdMs = D?.pairCreatedAt || P?.created_timestamp || (L?.creationTime ? L.creationTime * 1000 : null);
  let curve = null;
  if (P && !P.complete && P.real_token_reserves != null) curve = Math.max(0, Math.min(100, 100 - (Number(P.real_token_reserves) * 100) / PUMP_INITIAL_REAL_TOKENS));
  const onCurve = !!(P && !P.complete);

  const socials = { twitter: null, telegram: null, website: null };
  for (const s of D?.info?.socials || []) { if (s.type === 'twitter') socials.twitter = s.url; if (s.type === 'telegram') socials.telegram = s.url; }
  if (D?.info?.websites?.[0]) socials.website = D.info.websites[0].url;
  socials.twitter ||= P?.twitter || null; socials.telegram ||= P?.telegram || null; socials.website ||= P?.website || null;
  const dexPaid = orders.ok ? orders.v.some((o) => o.status === 'approved') : null;

  const wallHolders = H ? H.filter((h) => !h.isPool) : null;
  const top10 = wallHolders ? wallHolders.slice(0, 10).reduce((a, h) => a + h.pct, 0) : null;
  const maxHolder = wallHolders ? wallHolders.filter((h) => h.owner !== dev)[0]?.pct ?? 0 : null;
  const freshCount = fresh.ok ? fresh.v.filter((x) => x === true).length : null;

  const report = {
    mint, chain: 'solana', analyzedAt: new Date().toISOString(), tookMs: 0,
    token: {
      name: D?.baseToken?.name || P?.name || R?.tokenMeta?.name || '?',
      symbol: D?.baseToken?.symbol || P?.symbol || R?.tokenMeta?.symbol || '?',
      image: D?.info?.imageUrl || P?.image_uri || null,
      program: m.program === TOKEN_2022_PROGRAM ? 'Token-2022' : 'SPL Token',
      decimals: m.decimals, supply,
      mintAuthority: m.mintAuthority || null, freezeAuthority: m.freezeAuthority || null,
      mutable: R?.tokenMeta?.mutable ?? null,
      extensions: m.extensions.map((e) => e.extension),
    },
    market: {
      mcap, priceUsd: num(D?.priceUsd), liquidityUsd: D?.liquidity?.usd ?? null, dex: D?.dexId || (onCurve ? 'pump.fun' : null),
      pairAddress: D?.pairAddress || null, url: D?.url || null,
      volume: D?.volume || null, txns: D?.txns || null, priceChange: D?.priceChange || null,
      createdMs, ageMin: createdMs ? Math.round((Date.now() - createdMs) / 60000) : null,
      onCurve, curveProgress: curve, graduated: P ? !!P.complete : null, replies: P?.reply_count ?? null,
    },
    holders: { total: R?.totalHolders ?? null, top10Pct: top10, maxHolderPct: maxHolder, freshInTop10: freshCount, freshChecked: fresh.ok ? fresh.v.length : null, list: H ? H.slice(0, 20) : null },
    dev: {
      wallet: dev, heldPct: devHeldPct, initialBuyPct: launchStats.devInitialPct ?? null, soldPct: devSoldPct,
      walletTxCount: devProf.ok ? devProf.v.txCount : null, walletTxCapped: devProf.ok ? devProf.v.txCountCapped : null,
      walletAgeDays: devProf.ok && devProf.v.oldestTime ? (Date.now() / 1000 - devProf.v.oldestTime) / 86400 : null,
      sol: devProf.ok ? devProf.v.sol : null, track: devTrack,
    },
    launch: launchStats,
    rugcheck: R ? {
      score: R.score_normalised ?? null, rugged: !!R.rugged,
      risks: (R.risks || []).map((r) => ({ name: r.name, level: r.level, value: r.value, description: r.description })),
      insidersDetected: R.graphInsidersDetected ?? null, insiderNetworks: (R.insiderNetworks || []).length,
      lpLockedPct: (R.markets || []).reduce((a, x) => Math.max(a, x.lp?.lpLockedPct || 0), 0) || null,
      transferFeePct: R.transferFee?.pct ?? null,
    } : null,
    socials, dexPaid,
    sources: { rpc: true, rugcheck: rc.ok, dexscreener: dex.ok, pumpfun: !!P, holders: hold.ok, launch: !!L?.complete },
    errors: Object.fromEntries(Object.entries({ rugcheck: rc, dexscreener: dex, holders: hold, launch: lau }).filter(([, v]) => !v.ok).map(([k, v]) => [k, v.e])),
  };
  const s = score(report);
  report.indicators = s.indicators;
  report.score = s.score;
  report.verdict = s.verdict;
  report.tookMs = Date.now() - t0;
  return report;
}

// ---------- scoring ----------
// status: good | warn | bad | na. Critical "bad" = langsung HINDARI.
function score(r) {
  const I = [];
  const add = (key, label, status, value, weight, critical = false, note = '') => I.push({ key, label, status, value, weight, critical, note });
  const f = (x, d = 1) => (x == null ? 'n/a' : `${x.toFixed(d)}%`);

  // Kontrak
  add('mint', 'Mint authority', r.token.mintAuthority ? 'bad' : 'good', r.token.mintAuthority ? 'AKTIF (bisa cetak token)' : 'Revoked', 3, true);
  add('freeze', 'Freeze authority', r.token.freezeAuthority ? 'bad' : 'good', r.token.freezeAuthority ? 'AKTIF (bisa bekukan wallet)' : 'Revoked', 3, true);
  const danger = r.token.extensions.filter((e) => ['permanentDelegate', 'transferHook', 'nonTransferable', 'defaultAccountState'].includes(e));
  if (r.token.program === 'Token-2022') add('ext', 'Ekstensi Token-2022', danger.length ? 'bad' : 'warn', danger.length ? danger.join(', ') : r.token.extensions.join(', ') || 'none', 2, danger.length > 0);
  const fee = r.rugcheck?.transferFeePct;
  if (fee) add('fee', 'Transfer tax', fee > 5 ? 'bad' : 'warn', `${fee}%`, 2, fee > 10);
  add('meta', 'Metadata', r.token.mutable == null ? 'na' : r.token.mutable ? 'warn' : 'good', r.token.mutable == null ? 'n/a' : r.token.mutable ? 'Mutable' : 'Immutable', 1);
  if (r.rugcheck) {
    add('rugged', 'Status rug', r.rugcheck.rugged ? 'bad' : 'good', r.rugcheck.rugged ? 'RUGGED' : 'Belum rug', 3, true);
    const dz = r.rugcheck.risks.filter((x) => x.level === 'danger');
    add('rcrisk', 'RugCheck risiko', dz.length ? 'bad' : r.rugcheck.risks.length ? 'warn' : 'good',
      dz.length ? dz.map((x) => x.name).join(', ') : `${r.rugcheck.risks.length} peringatan · skor ${r.rugcheck.score ?? '?'}`, 2);
  } else add('rcrisk', 'RugCheck', 'na', 'tidak tersedia', 2);

  // Likuiditas
  if (r.market.onCurve) add('lp', 'Likuiditas', 'good', `Bonding curve pump.fun ${r.market.curveProgress != null ? r.market.curveProgress.toFixed(0) + '%' : ''} (LP tidak bisa ditarik)`, 2);
  else if (r.market.liquidityUsd != null) {
    const lock = r.rugcheck?.lpLockedPct;
    const ratio = r.market.mcap ? (r.market.liquidityUsd / r.market.mcap) * 100 : null;
    const lockBad = lock != null && lock < 80 && !/pumpswap|pump/i.test(r.market.dex || '');
    add('lp', 'Likuiditas', lockBad || (ratio != null && ratio < 8) ? 'bad' : ratio != null && ratio < 15 ? 'warn' : 'good',
      `$${fmtK(r.market.liquidityUsd)} (${ratio != null ? ratio.toFixed(0) : '?'}% MC) · LP lock ${lock != null ? lock.toFixed(0) + '%' : 'n/a'}`, 2, lockBad);
  } else add('lp', 'Likuiditas', 'na', 'n/a', 2);

  // Market cap
  const mc = r.market.mcap;
  add('mcap', 'Market cap', mc == null ? 'na' : mc <= CFG.maxMcap ? 'good' : mc <= CFG.maxMcap * 2 ? 'warn' : 'warn', mc == null ? 'n/a' : `$${fmtK(mc)}${mc <= CFG.maxMcap ? ' (zona trench)' : ' (di atas target)'}`, 1);

  // Distribusi
  const t10 = r.holders.top10Pct;
  add('top10', 'Top 10 holder', t10 == null ? 'na' : t10 <= 20 ? 'good' : t10 <= 30 ? 'warn' : 'bad', f(t10), 3, t10 != null && t10 > 45);
  const mx = r.holders.maxHolderPct;
  add('maxh', 'Holder terbesar (non-dev)', mx == null ? 'na' : mx <= 4 ? 'good' : mx <= 8 ? 'warn' : 'bad', f(mx), 2, mx != null && mx > 15);
  const hc = r.holders.total;
  add('holders', 'Jumlah holder', hc == null ? 'na' : hc >= 100 ? 'good' : hc >= 40 ? 'warn' : 'bad', hc == null ? 'n/a' : String(hc), 2);
  const fr = r.holders.freshInTop10;
  add('fresh', 'Fresh wallet di top 10', fr == null ? 'na' : fr <= 1 ? 'good' : fr <= 3 ? 'warn' : 'bad', fr == null ? 'n/a' : `${fr}/${r.holders.freshChecked}`, 2);
  const ins = r.rugcheck?.insidersDetected;
  add('insider', 'Jaringan insider', ins == null ? 'na' : ins === 0 ? 'good' : ins <= 3 ? 'warn' : 'bad', ins == null ? 'n/a' : `${ins} wallet terhubung`, 2);

  // Bundle & sniper
  const L = r.launch;
  if (L.incomplete) add('bundle', 'Bundle (blok 0)', 'na', `tidak terbaca (${L.txSeen ?? '?'}+ tx)`, 3);
  else {
    const held = L.bundleHeldPct ?? L.bundleBoughtPct;
    add('bundle', 'Bundle (blok 0)', L.bundleWallets === 0 ? 'good' : held <= 3 ? 'warn' : 'bad',
      L.bundleWallets === 0 ? 'Tidak ada' : `${L.bundleWallets} wallet · beli ${f(L.bundleBoughtPct)} · masih pegang ${f(L.bundleHeldPct)}`, 3, held > 15);
    const sh = L.sniperHeldPct ?? L.sniperBoughtPct;
    add('snipers', 'Sniper (≤3 slot)', L.sniperWallets === 0 || sh <= 5 ? 'good' : sh <= 15 ? 'warn' : 'bad',
      `${L.sniperWallets} wallet · masih pegang ${f(L.sniperHeldPct)}`, 2);
  }

  // Dev
  const d = r.dev;
  const dh = d.heldPct;
  add('devhold', 'Dev holding', dh == null ? 'na' : dh <= 5 ? 'good' : dh <= 10 ? 'warn' : 'bad',
    dh == null ? 'n/a' : `${f(dh)}${d.soldPct != null ? ` · sudah jual ${d.soldPct.toFixed(0)}%` : ''}`, 3, dh != null && dh > 20);
  if (d.soldPct != null && d.initialBuyPct > 0.5 && d.soldPct >= 99) add('devexit', 'Dev exit', 'warn', 'Dev sudah jual semua (koin jadi milik komunitas / ditinggal)', 1);
  if (d.track) {
    const t = d.track;
    const st = t.launches === 0 ? 'warn' : t.graduated > 0 && t.graduated / t.launches >= 0.1 ? 'good' : t.launches >= 5 ? 'bad' : 'warn';
    add('devtrack', 'Rekam jejak dev', st, `${t.launches}${t.capped ? '+' : ''} koin lain · ${t.graduated} graduate${t.launches === 0 ? ' (dev baru)' : ''}`, 2, t.launches >= 20 && t.graduated === 0);
  } else add('devtrack', 'Rekam jejak dev', 'na', 'n/a', 2);
  if (d.walletAgeDays != null) {
    const young = d.walletAgeDays < 2 && !d.walletTxCapped;
    add('devage', 'Umur wallet dev', young ? 'warn' : 'good', `${d.walletTxCapped ? '>' : ''}${d.walletAgeDays.toFixed(1)} hari · ${d.walletTxCount}${d.walletTxCapped ? '+' : ''} tx`, 1);
  }

  // Momentum
  const tx = r.market.txns?.h1;
  if (tx) {
    const ratio = tx.sells ? tx.buys / tx.sells : tx.buys;
    add('flow', 'Buy/Sell 1 jam', ratio >= 1.1 ? 'good' : ratio >= 0.8 ? 'warn' : 'bad', `${tx.buys}/${tx.sells} (rasio ${ratio.toFixed(2)})`, 2);
  } else add('flow', 'Buy/Sell 1 jam', 'na', 'n/a', 2);
  const v1 = r.market.volume?.h1;
  if (v1 != null && mc) add('vol', 'Volume 1 jam', v1 >= mc * 0.5 ? 'good' : v1 >= mc * 0.15 ? 'warn' : 'bad', `$${fmtK(v1)} (${((v1 / mc) * 100).toFixed(0)}% MC)`, 1);
  if (r.market.ageMin != null) add('age', 'Umur token', r.market.ageMin < 5 ? 'warn' : 'good', fmtAge(r.market.ageMin), 1);

  // Sosial
  const s = r.socials;
  const nS = [s.twitter, s.telegram, s.website].filter(Boolean).length;
  add('social', 'Sosial media', nS >= 2 ? 'good' : nS === 1 ? 'warn' : 'bad', nS ? [s.twitter && 'X', s.telegram && 'TG', s.website && 'Web'].filter(Boolean).join(' · ') : 'Tidak ada', 1);
  add('dexpaid', 'DEX paid', r.dexPaid == null ? 'na' : r.dexPaid ? 'good' : 'warn', r.dexPaid == null ? 'n/a' : r.dexPaid ? 'Ya' : 'Belum', 1);

  const W = { good: 1, warn: 0.5, bad: 0 };
  let sw = 0, sc = 0;
  for (const i of I) if (i.status !== 'na') { sw += i.weight; sc += i.weight * W[i.status]; }
  const scoreVal = sw ? Math.round((sc / sw) * 100) : 0;
  const crit = I.filter((i) => i.critical && i.status === 'bad');
  const bads = I.filter((i) => i.status === 'bad' && i.weight >= 3);
  const naCore = I.filter((i) => ['top10', 'bundle', 'devhold'].includes(i.key) && i.status === 'na').length;
  let verdict;
  if (crit.length) verdict = { level: 'avoid', label: 'HINDARI', emoji: '🔴', reason: crit.map((c) => c.label).join(', ') };
  else if (scoreVal >= 75 && !bads.length && naCore === 0) verdict = { level: 'buy', label: 'LAYAK DIPERTIMBANGKAN', emoji: '🟢', reason: 'Lolos filter keamanan & distribusi' };
  else if (scoreVal >= 55) verdict = { level: 'caution', label: 'HATI-HATI', emoji: '🟡', reason: bads.length ? bads.map((b) => b.label).join(', ') : naCore ? 'Sebagian data inti tidak terbaca' : 'Skor menengah' };
  else verdict = { level: 'avoid', label: 'HINDARI', emoji: '🔴', reason: 'Skor rendah' };
  return { indicators: I, score: scoreVal, verdict };
}

export function fmtK(n) {
  if (n == null || !Number.isFinite(+n)) return '?';
  n = +n;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
export function fmtAge(min) {
  if (min == null) return '?';
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}j ${min % 60}m`;
  return `${Math.floor(min / 1440)}h ${Math.floor((min % 1440) / 60)}j`;
}

// Extract a Solana CA from free text or links (dexscreener, pump.fun, gmgn, axiom, etc.)
export function extractMint(text) {
  if (!text) return null;
  const m = String(text).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  if (!m) return null;
  return m.find((x) => x.endsWith('pump')) || m.sort((a, b) => b.length - a.length)[0];
}

export { sleep };
