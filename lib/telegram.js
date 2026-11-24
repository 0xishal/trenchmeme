// Telegram helpers + message formatting (HTML parse mode).
import crypto from 'node:crypto';
import { fetchT, getJson, rpc } from './util.js';
import { fmtK, fmtAge } from './analyze.js';

export const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
export const allowedChats = () =>
  (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
export const webhookSecret = () =>
  crypto.createHash('sha256').update('trenchmeme:' + BOT_TOKEN()).digest('hex').slice(0, 48);

export async function tg(method, body) {
  const r = await fetchT(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 15000);
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('telegram', method, j.description);
  return j;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ICON = { good: '✅', warn: '⚠️', bad: '❌', na: '▫️' };

// Resolve a pair address (e.g. from a dexscreener link) to the token mint.
export async function resolveMint(addr) {
  try {
    const acc = await rpc('getAccountInfo', [addr, { encoding: 'jsonParsed' }]);
    if (acc?.value?.data?.parsed?.type === 'mint') return addr;
  } catch {}
  try {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${addr}`);
    const p = j?.pairs?.[0] || j?.pair;
    if (p?.baseToken?.address) return p.baseToken.address;
  } catch {}
  return addr;
}

export function links(r) {
  const m = r.mint;
  return {
    DexScreener: r.market.url || `https://dexscreener.com/solana/${m}`,
    'Pump.fun': `https://pump.fun/coin/${m}`,
    GMGN: `https://gmgn.ai/sol/token/${m}`,
    Axiom: `https://axiom.trade/meme/${r.market.pairAddress || m}`,
    RugCheck: `https://rugcheck.xyz/tokens/${m}`,
    Bubblemaps: `https://app.bubblemaps.io/sol/token/${m}`,
    Solscan: `https://solscan.io/token/${m}`,
    'X search': `https://x.com/search?q=${m}&f=live`,
  };
}

export function keyboard(r) {
  const L = links(r);
  const btn = (t) => ({ text: t, url: L[t] });
  return {
    inline_keyboard: [
      [btn('DexScreener'), btn('Pump.fun'), btn('GMGN')],
      [btn('Axiom'), btn('RugCheck'), btn('Bubblemaps')],
      [btn('Solscan'), btn('X search'), { text: '🔄 Refresh', callback_data: `r:${r.mint}` }],
    ],
  };
}

export function formatReport(r, { alert = false } = {}) {
  const v = r.verdict;
  const mk = r.market;
  const lines = [];
  if (alert) lines.push('🚨 <b>TRENCH ALERT — token lolos filter</b>');
  lines.push(`${v.emoji} <b>${esc(v.label)}</b> · Skor <b>${r.score}/100</b>`);
  lines.push(`<i>${esc(v.reason)}</i>`);
  lines.push('');
  lines.push(`<b>$${esc(r.token.symbol)}</b> — ${esc(r.token.name)}`);
  lines.push(`<code>${r.mint}</code>`);
  const tx = mk.txns?.h1;
  lines.push(`💰 MC <b>$${fmtK(mk.mcap)}</b> · ${mk.onCurve ? 'Liq: curve' : `Liq $${fmtK(mk.liquidityUsd)}`} · Umur ${fmtAge(mk.ageMin)} · Holder ${r.holders.total ?? '?'}`);
  lines.push(`📊 Vol 1j $${fmtK(mk.volume?.h1)} · B/S ${tx ? `${tx.buys}/${tx.sells}` : '?'} · 5m ${pc(mk.priceChange?.m5)} · 1j ${pc(mk.priceChange?.h1)}`);
  if (mk.onCurve) lines.push(`🎯 Bonding curve ${mk.curveProgress != null ? mk.curveProgress.toFixed(0) + '%' : '?'}`);
  else if (mk.dex) lines.push(`🏦 DEX: ${esc(mk.dex)}`);
  lines.push('');
  const groups = [
    ['🛡 Kontrak', ['mint', 'freeze', 'ext', 'fee', 'meta', 'rugged', 'rcrisk', 'lp']],
    ['👥 Distribusi', ['top10', 'maxh', 'holders', 'fresh', 'insider']],
    ['📦 Launch', ['bundle', 'snipers']],
    ['👤 Dev', ['devhold', 'devexit', 'devtrack', 'devage']],
    ['📈 Momentum & sosial', ['mcap', 'flow', 'vol', 'age', 'social', 'dexpaid']],
  ];
  const byKey = Object.fromEntries(r.indicators.map((i) => [i.key, i]));
  for (const [title, keys] of groups) {
    const items = keys.map((k) => byKey[k]).filter(Boolean);
    if (!items.length) continue;
    lines.push(`<b>${title}</b>`);
    for (const i of items) lines.push(`${ICON[i.status]} ${esc(i.label)}: ${esc(i.value)}`);
    lines.push('');
  }
  if (r.dev.wallet) lines.push(`Dev: <a href="https://solscan.io/account/${r.dev.wallet}">${r.dev.wallet.slice(0, 4)}…${r.dev.wallet.slice(-4)}</a>${r.dev.sol != null ? ` · ${r.dev.sol.toFixed(2)} SOL` : ''}`);
  const miss = Object.entries(r.sources).filter(([, ok]) => !ok).map(([k]) => k);
  if (miss.length) lines.push(`<i>Data tidak lengkap: ${esc(miss.join(', '))}</i>`);
  lines.push(`<i>Bukan nasihat keuangan. Cek chart & X sebelum entry.</i>`);
  let text = lines.join('\n');
  if (text.length > 4000) text = text.slice(0, 3990) + '…';
  return text;
}

const pc = (x) => (x == null ? '?' : `${x > 0 ? '+' : ''}${Number(x).toFixed(0)}%`);
