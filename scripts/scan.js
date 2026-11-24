// Scanner otomatis (dijalankan GitHub Actions tiap ~5 menit, loop di dalam job).
// Memantau token baru <MAX_MCAP, menganalisis, dan mengirim alert Telegram kalau lolos filter.
import fs from 'node:fs';
import path from 'node:path';
import { candidates } from '../lib/feed.js';
import { analyzeToken } from '../lib/analyze.js';
import { tg, allowedChats, formatReport, keyboard, BOT_TOKEN } from '../lib/telegram.js';
import { num, sleep } from '../lib/util.js';

const STATE_FILE = path.resolve(process.env.STATE_FILE || '.state/state.json');
const LOOP_SECONDS = num(process.env.SCAN_LOOP_SECONDS) ?? 270;
const CYCLE_SECONDS = num(process.env.SCAN_CYCLE_SECONDS) ?? 60;
const MAX_ANALYZE = num(process.env.SCAN_MAX_ANALYZE) ?? 6;
const RECHECK_MIN = num(process.env.RECHECK_MIN) ?? 20;
const ALERT_MIN_SCORE = num(process.env.ALERT_MIN_SCORE) ?? 75;
const ALERT_LEVEL = process.env.ALERT_LEVEL || 'buy'; // 'buy' atau 'caution' (ikut kirim 🟡)
let DRY = process.env.DRY_RUN === '1';

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { checked: {}, alerted: {} }; }
}
function save(s) {
  const cutoff = Date.now() - 48 * 3600e3;
  for (const k of ['checked', 'alerted']) for (const [m, t] of Object.entries(s[k] || {})) if ((t.at || t) < cutoff) delete s[k][m];
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}

async function cycle(state) {
  const feed = await candidates();
  const now = Date.now();
  const todo = feed.passed
    .filter((t) => !state.alerted[t.mint])
    .filter((t) => !state.checked[t.mint] || now - state.checked[t.mint].at > RECHECK_MIN * 60e3)
    .slice(0, MAX_ANALYZE);
  console.log(`[scan] sumber=${JSON.stringify(feed.status)} token=${feed.scanned} harga=${feed.priced} lolos-prefilter=${feed.passed.length} dianalisis=${todo.length}`);
  for (const t of todo) {
    try {
      const r = await analyzeToken(t.mint);
      state.checked[t.mint] = { at: Date.now(), score: r.score, level: r.verdict.level };
      console.log(`  ${r.verdict.emoji} ${r.token.symbol.padEnd(10)} skor=${r.score} mc=$${Math.round(r.market.mcap || 0)} ${r.verdict.reason}`);
      const ok = r.score >= ALERT_MIN_SCORE && (r.verdict.level === 'buy' || (ALERT_LEVEL === 'caution' && r.verdict.level === 'caution'));
      if (ok) {
        state.alerted[t.mint] = { at: Date.now(), score: r.score };
        if (!DRY) for (const chat of allowedChats())
          await tg('sendMessage', { chat_id: chat, text: formatReport(r, { alert: true }), parse_mode: 'HTML', reply_markup: keyboard(r), disable_web_page_preview: true });
      }
    } catch (e) {
      state.checked[t.mint] = { at: Date.now(), error: String(e.message || e) };
      console.log(`  ✖ ${t.mint} ${e.message}`);
    }
  }
}

async function main() {
  if (!DRY && (!BOT_TOKEN() || !allowedChats().length)) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum di-set di GitHub Secrets — scanner berjalan dalam DRY_RUN.');
    DRY = true;
  }
  const state = load();
  state.checked ||= {}; state.alerted ||= {};
  const end = Date.now() + LOOP_SECONDS * 1000;
  do {
    const start = Date.now();
    try { await cycle(state); } catch (e) { console.log('[scan] cycle error', e.message); }
    save(state);
    const wait = CYCLE_SECONDS * 1000 - (Date.now() - start);
    if (Date.now() + Math.max(wait, 0) >= end) break;
    if (wait > 0) await sleep(wait);
  } while (Date.now() < end);
  console.log('[scan] selesai');
}

main();
