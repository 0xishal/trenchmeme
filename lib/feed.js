// Kandidat token baru dari beberapa sumber publik, diseragamkan lewat DexScreener.
import { getJson, settle, pmap, num } from './util.js';

const PUMP_HEADERS = { origin: 'https://pump.fun', referer: 'https://pump.fun/' };

export const FEED_CFG = {
  minMcap: num(process.env.MIN_MCAP) ?? 7_000,
  maxMcap: num(process.env.MAX_MCAP) ?? 50_000,
  minAgeMin: num(process.env.MIN_AGE_MIN) ?? 3,
  maxAgeHours: num(process.env.MAX_AGE_HOURS) ?? 24,
  minBuys1h: num(process.env.MIN_BUYS_1H) ?? 15,
  minVol1h: num(process.env.MIN_VOL_1H) ?? 3_000,
};

async function sourceMints() {
  const [prof, boost, gt1, gt2, pumpLast, pumpNew] = await Promise.all([
    settle(getJson('https://api.dexscreener.com/token-profiles/latest/v1')),
    settle(getJson('https://api.dexscreener.com/token-boosts/latest/v1')),
    settle(getJson('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1')),
    settle(getJson('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=2')),
    settle(getJson('https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { headers: PUMP_HEADERS })),
    settle(getJson('https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false&complete=false', { headers: PUMP_HEADERS })),
  ]);
  const out = new Map();
  const add = (mint, src) => { if (mint && !out.has(mint)) out.set(mint, src); };
  for (const [r, src] of [[prof, 'dex-profile'], [boost, 'dex-boost']])
    if (r.ok) for (const t of (Array.isArray(r.v) ? r.v : [])) if (t.chainId === 'solana') add(t.tokenAddress, src);
  for (const r of [gt1, gt2])
    if (r.ok) for (const p of r.v?.data || []) {
      const id = p.relationships?.base_token?.data?.id || '';
      const mint = id.replace(/^solana_/, '');
      if (mint && mint !== 'So11111111111111111111111111111111111111112') add(mint, 'gecko-new');
    }
  for (const r of [pumpLast, pumpNew]) {
    const arr = r.ok ? (Array.isArray(r.v) ? r.v : r.v?.coins || []) : [];
    for (const c of arr) add(c.mint, 'pump');
  }
  const status = { dexProfiles: prof.ok, dexBoosts: boost.ok, gecko: gt1.ok, pump: pumpLast.ok || pumpNew.ok };
  return { mints: [...out.entries()].map(([mint, src]) => ({ mint, src })), status };
}

export async function candidates() {
  const { mints, status } = await sourceMints();
  const chunks = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  const res = await pmap(chunks, 3, (c) => getJson(`https://api.dexscreener.com/tokens/v1/solana/${c.map((x) => x.mint).join(',')}`));
  const best = new Map();
  for (const arr of res) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const m = p.baseToken?.address;
      if (!m) continue;
      const prev = best.get(m);
      if (!prev || (p.liquidity?.usd || 0) + (p.volume?.h1 || 0) > (prev.liquidity?.usd || 0) + (prev.volume?.h1 || 0)) best.set(m, p);
    }
  }
  const src = Object.fromEntries(mints.map((x) => [x.mint, x.src]));
  const now = Date.now();
  const C = FEED_CFG;
  const all = [...best.entries()].map(([mint, p]) => ({
    mint, src: src[mint], symbol: p.baseToken?.symbol, name: p.baseToken?.name, dex: p.dexId,
    mcap: p.marketCap ?? p.fdv ?? null, liq: p.liquidity?.usd ?? null, vol1h: p.volume?.h1 ?? 0,
    buys1h: p.txns?.h1?.buys ?? 0, sells1h: p.txns?.h1?.sells ?? 0, chg1h: p.priceChange?.h1 ?? null,
    ageMin: p.pairCreatedAt ? Math.round((now - p.pairCreatedAt) / 60000) : null, url: p.url,
  }));
  const passed = all.filter((t) =>
    t.mcap != null && t.mcap >= C.minMcap && t.mcap <= C.maxMcap &&
    t.ageMin != null && t.ageMin >= C.minAgeMin && t.ageMin <= C.maxAgeHours * 60 &&
    t.buys1h >= C.minBuys1h && t.vol1h >= C.minVol1h && t.buys1h >= t.sells1h * 0.8
  ).sort((a, b) => b.vol1h - a.vol1h);
  return { scanned: mints.length, priced: all.length, passed, status };
}
