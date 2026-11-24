// Shared helpers for TrenchMeme serverless functions (Solana mainnet).

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL = 'So11111111111111111111111111111111111111112';

const DEFAULT_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

export function rpcList() {
  const env = (process.env.RPC_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return env.length ? env : DEFAULT_RPCS;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isMint(s) {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export async function fetchT(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function getJson(url, { headers = {}, timeoutMs = 12000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchT(
        url,
        {
          headers: {
            accept: 'application/json',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
            ...headers,
          },
        },
        timeoutMs
      );
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`HTTP ${r.status} ${url}`);
        await sleep(600 * (i + 1));
        continue;
      }
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}`), { fatal: true });
      const txt = await r.text();
      if (!txt) return null;
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

let rpcCursor = 0;
export async function rpc(method, params, { retries = 4 } = {}) {
  const list = rpcList();
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const url = list[(rpcCursor + attempt) % list.length];
    let retryable = true;
    try {
      const r = await fetchT(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        },
        15000
      );
      if (r.status === 429 || r.status >= 500 || r.status === 403) {
        lastErr = new Error(`RPC ${method} HTTP ${r.status}`);
        rpcCursor++;
        await sleep(350 * (attempt + 1));
        continue;
      }
      const j = await r.json();
      if (j.error) {
        const msg = String(j.error.message || j.error.code);
        lastErr = new Error(`RPC ${method}: ${msg}`);
        retryable = /rate|limit|too many|timeout|unavailable|busy/i.test(msg);
        if (!retryable) break;
        rpcCursor++;
        await sleep(400 * (attempt + 1));
        continue;
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      rpcCursor++;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Simple concurrency-limited map.
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { __error: String(e?.message || e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function settle(p) {
  return p.then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e: String(e?.message || e) })
  );
}

export function checkAccess(req, res) {
  const key = process.env.ACCESS_KEY;
  if (!key) return true;
  const got = req.headers['x-access-key'] || req.query?.key;
  if (got === key) return true;
  res.status(401).json({ error: 'ACCESS_KEY salah atau belum diisi' });
  return false;
}

export function num(x) {
  if (x == null || (typeof x === 'string' && x.trim() === '')) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
