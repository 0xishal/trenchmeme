// Telegram webhook: kirim CA (atau link dexscreener/pump.fun/gmgn) ke bot → bot balas laporan kelayakan.
import { analyzeToken, extractMint } from '../lib/analyze.js';
import { tg, allowedChats, webhookSecret, formatReport, keyboard, resolveMint, BOT_TOKEN } from '../lib/telegram.js';

const HELP = `<b>TrenchMeme Bot</b> 🪖
Kirim <b>CA token Solana</b> (atau link DexScreener / pump.fun / GMGN / Axiom) dan bot akan memeriksa:
• Mint & freeze authority, Token-2022, tax, metadata
• Top 10 holder, holder terbesar, fresh wallet, insider
• Bundle blok 0 & sniper (berapa yang masih dipegang)
• Dev: holding, sudah jual berapa, rekam jejak launch
• Likuiditas / bonding curve, buy-sell, volume, sosial, DEX paid

Perintah:
/cek &lt;CA&gt; — analisis token
/panduan — ringkasan cara memilih koin &lt;50k
/id — tampilkan chat ID

Scanner otomatis (GitHub Actions) akan mengirim 🚨 alert ke chat ini kalau ada token baru yang lolos filter.`;

const GUIDE = `<b>Checklist trench &lt;50k mcap</b>
1️⃣ <b>Kontrak bersih</b>: mint & freeze revoked, bukan Token-2022 berbahaya, tanpa tax.
2️⃣ <b>Distribusi</b>: top 10 (tanpa curve/LP) ≤20%, holder terbesar ≤4%, dev ≤5%, fresh wallet di top 10 ≤1.
3️⃣ <b>Bundle</b>: idealnya 0 wallet di blok 0; kalau ada, yang masih dipegang &lt;3%.
4️⃣ <b>Sniper</b>: yang masih pegang ≤5%. Banyak sniper sudah jual = supply lebih sehat.
5️⃣ <b>Dev</b>: wallet bukan fresh, punya rekam jejak (pernah graduate), tidak serial launcher 20+ koin tanpa hasil.
6️⃣ <b>Momentum</b>: buy/sell 1 jam &gt;1.1, volume 1 jam ≥50% MC, holder ≥100.
7️⃣ <b>Narasi</b>: X/TG aktif, bukan link tweet orang lain. DEX paid = dev keluar modal.
8️⃣ <b>Eksekusi</b>: size kecil, siapkan TP bertahap (2x ambil modal), cut kalau dev/bundle mulai dump.

Skor ≥75 tanpa ❌ kritis = 🟢 layak dipertimbangkan. Tetap DYOR.`;

async function runAnalysis(chatId, raw) {
  const sent = await tg('sendMessage', { chat_id: chatId, text: `⏳ Menganalisis <code>${raw}</code> …`, parse_mode: 'HTML' });
  const msgId = sent?.result?.message_id;
  try {
    const mint = await resolveMint(raw);
    const r = await analyzeToken(mint);
    const body = { chat_id: chatId, text: formatReport(r), parse_mode: 'HTML', reply_markup: keyboard(r), disable_web_page_preview: true };
    if (msgId) await tg('editMessageText', { ...body, message_id: msgId });
    else await tg('sendMessage', body);
  } catch (e) {
    const text = `❌ Gagal menganalisis: ${String(e.message || e).slice(0, 300)}`;
    if (msgId) await tg('editMessageText', { chat_id: chatId, message_id: msgId, text });
    else await tg('sendMessage', { chat_id: chatId, text });
  }
}

async function handle(u) {
  const allow = allowedChats();
  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = cq.message?.chat?.id;
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Refresh…' });
    if (!allow.includes(String(chatId))) return;
    const data = cq.data || '';
    if (data.startsWith('r:')) await runAnalysis(chatId, data.slice(2));
    return;
  }
  const msg = u.message || u.channel_post;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!allow.length) {
    await tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `Chat ID kamu: <code>${chatId}</code>\n\nIsi env <b>TELEGRAM_CHAT_ID</b> = ${chatId} di Vercel (lalu Redeploy) dan di GitHub Secrets. Setelah itu bot hanya melayani chat ini.`,
    });
    return;
  }
  if (!allow.includes(String(chatId))) return; // bot pribadi: abaikan chat lain

  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  if (cmd === '/start' || cmd === '/help') return tg('sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML' });
  if (cmd === '/id') return tg('sendMessage', { chat_id: chatId, text: `Chat ID: <code>${chatId}</code>`, parse_mode: 'HTML' });
  if (cmd === '/panduan') return tg('sendMessage', { chat_id: chatId, text: GUIDE, parse_mode: 'HTML' });

  const mint = extractMint(text);
  if (!mint) return tg('sendMessage', { chat_id: chatId, text: 'Kirim CA token Solana (32–44 karakter) atau link DexScreener/pump.fun.' });
  await runAnalysis(chatId, mint);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'trenchmeme telegram webhook', configured: !!BOT_TOKEN() });
  if (!BOT_TOKEN()) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN belum di-set' });
  if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) return res.status(401).json({ ok: false });
  try {
    await handle(req.body || {});
  } catch (e) {
    console.error('webhook error', e);
  }
  res.status(200).json({ ok: true });
}
