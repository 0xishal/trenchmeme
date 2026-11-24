// Watchlist KOL & smart wallet + deteksi siapa yang membeli / memegang sebuah token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, rpc, pmap } from './util.js';
import { ata } from './solana.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = 'https://raw.githubusercontent.com/nirholas/kol-quest/main/site/data';
const DEFAULT_SOURCES = [`${RAW}/kolscan-leaderboard.json`, `${RAW}/solwallets.json`];
const SMART_TAGS = { smart_degen: 'smart', launchpad_smart: 'smart', top_followed: 'smart', snipe_bot: 'sniper-bot' };
const TTL = 6 * 3600e3;

let cache = null;

function sources() {
  const env = (process.env.WATCHLIST_SOURCES || '').trim();
  if (env.toLowerCase() === 'none') return [];
  return env ? env.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SOURCES;
}

const isAddr = (a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

// Ubah format apa pun (kolscan / gmgn / daftar sendiri) jadi entri {address,name,type,twitter}.
function normalize(data, out) {
  const put = (address, e) => {
    if (!isAddr(address)) return;
    const prev = out.get(address);
    if (prev?.priority > (e.priority || 0)) return;
    // gabungkan info: nama/twitter yang sudah ada dipertahankan kalau yang baru kosong
    out.set(address, {
      address,
      name: e.name || prev?.name || null,
      twitter: e.twitter || prev?.twitter || null,
      type: prev?.type === 'kol' ? 'kol' : e.type || prev?.type || 'smart',
      source: e.source || prev?.source,
      priority: Math.max(e.priority || 0, prev?.priority || 0),
    });
  };
  const tw = (x) => (!x ? null : String(x).startsWith('http') ? x : `https://x.com/${String(x).replace(/^@/, '')}`);

  if (Array.isArray(data)) {
    for (const x of data) {
      const a = x.wallet_address || x.address || x.wallet;
      put(a, { name: x.name || x.nickname || x.twitter_name, twitter: tw(x.twitter || x.twitter_username), type: x.type || 'kol', source: x.source || 'kolscan' });
    }
    return;
  }
  if (Array.isArray(data?.wallets)) {
    // daftar pribadi data/wallets.json
    for (const x of data.wallets) put(x.address || x.wallet, { name: x.name, twitter: tw(x.twitter), type: x.type || 'custom', source: 'pribadi', priority: 9 });
    return;
  }
  if (data?.kol?.wallets) {
    for (const x of data.kol.wallets) put(x.wallet_address || x.address, { name: x.nickname || x.twitter_name || x.twitter_username, twitter: tw(x.twitter_username), type: 'kol', source: 'gmgn' });
  }
  const sm = data?.smartMoney?.wallets;
  if (sm && typeof sm === 'object') {
    for (const [tag, list] of Object.entries(sm)) {
      const type = SMART_TAGS[tag];
      if (!type || !Array.isArray(list)) continue;
      for (const x of list) put(x.wallet_address || x.address, { name: x.nickname || x.twitter_username || null, twitter: tw(x.twitter_username), type, source: `gmgn:${tag}` });
    }
  }
}

export async function loadWatchlist() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const out = new Map();
  const status = {};
  const res = await pmap(sources(), 3, (u) => getJson(u, { timeoutMs: 25000 }));
  sources().forEach((u, i) => {
    const r = res[i];
    if (!r || r.__error) { status[u.split('/').pop()] = false; return; }
    normalize(r, out);
    status[u.split('/').pop()] = true;
  });
  // daftar pribadi + env EXTRA_WALLETS="addr:Nama,addr2:Nama2"
  try { normalize(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'wallets.json'), 'utf8')), out); status['wallets.json'] = true; } catch { status['wallets.json'] = false; }
  const extra = (process.env.EXTRA_WALLETS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.length) normalize({ wallets: extra.map((s) => { const [address, name] = s.split(':'); return { address, name, type: 'custom' }; }) }, out);
  const list = [...out.values()];
  // Jangan cache daftar kosong (mis. sumber sedang down) supaya dicoba lagi request berikutnya.
  if (list.length) cache = { at: Date.now(), list, status };
  return { at: Date.now(), list, status };
}

// Cari wallet watchlist yang punya token account untuk mint ini.
// held > 0 = masih pegang; held = 0 = pernah beli lalu jual (akun belum ditutup).
export async function watchlistHolders(mint, tokenProgram, supply, extraBuyers = []) {
  const wl = await loadWatchlist();
  if (!wl.list.length) return { checked: 0, hits: [], status: wl.status };
  const entries = wl.list.map((w) => ({ ...w, ata: ata(w.address, mint, tokenProgram) }));
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100) chunks.push(entries.slice(i, i + 100));
  const res = await pmap(chunks, 3, (c) => rpc('getMultipleAccounts', [c.map((e) => e.ata), { encoding: 'jsonParsed' }]));
  const hits = [];
  let failed = 0;
  chunks.forEach((c, ci) => {
    const r = res[ci];
    if (!r || r.__error) { failed += c.length; return; }
    r.value.forEach((acc, i) => {
      if (!acc) return;
      const amt = acc.data?.parsed?.info?.tokenAmount?.amount;
      if (amt == null) return;
      const e = c[i];
      const held = BigInt(amt);
      hits.push({ address: e.address, name: e.name, twitter: e.twitter, type: e.type, source: e.source, amount: held.toString(), pct: pctOf(held, supply), status: held > 0n ? 'holding' : 'sold' });
    });
  });
  // Pembeli awal (blok 0–3) yang ada di watchlist tapi akunnya sudah ditutup → sudah jual semua.
  const byAddr = new Map(wl.list.map((w) => [w.address, w]));
  for (const b of extraBuyers) {
    if (hits.some((h) => h.address === b)) continue;
    const e = byAddr.get(b);
    if (e) hits.push({ address: e.address, name: e.name, twitter: e.twitter, type: e.type, source: e.source, amount: '0', pct: 0, status: 'sold', early: true });
  }
  const rank = { kol: 0, smart: 1, custom: 2, whale: 2, 'sniper-bot': 3 };
  hits.sort((a, b) => (a.status === b.status ? 0 : a.status === 'holding' ? -1 : 1) || (rank[a.type] ?? 4) - (rank[b.type] ?? 4) || b.pct - a.pct);
  return { checked: entries.length - failed, total: entries.length, hits, status: wl.status };
}

function pctOf(part, whole) {
  try { const w = BigInt(whole); return w === 0n ? 0 : Number((BigInt(part) * 1_000_000n) / w) / 10_000; } catch { return 0; }
}
