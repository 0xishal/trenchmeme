// Buka https://<domain-vercel>/api/setup sekali setelah TELEGRAM_BOT_TOKEN di-set untuk mendaftarkan webhook bot.
import { tg, webhookSecret, BOT_TOKEN, allowedChats } from '../lib/telegram.js';

export default async function handler(req, res) {
  if (!BOT_TOKEN()) {
    return res.status(200).json({ ok: false, step: 1, message: 'Set env TELEGRAM_BOT_TOKEN di Vercel (Settings → Environment Variables), Redeploy, lalu buka /api/setup lagi.' });
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `https://${host}/api/telegram`;
  const set = await tg('setWebhook', {
    url, secret_token: webhookSecret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true, max_connections: 10,
  });
  await tg('setMyCommands', {
    commands: [
      { command: 'cek', description: 'Analisis CA token' },
      { command: 'panduan', description: 'Checklist memilih koin <50k' },
      { command: 'id', description: 'Tampilkan chat ID' },
      { command: 'help', description: 'Bantuan' },
    ],
  });
  const me = await tg('getMe', {});
  const chats = allowedChats();
  res.status(200).json({
    ok: !!set.ok, webhook: url, bot: me?.result?.username ? '@' + me.result.username : null,
    telegram: set.description,
    next: chats.length
      ? `Siap. Kirim CA ke @${me?.result?.username} untuk dianalisis.`
      : `Kirim /start ke @${me?.result?.username} — bot akan membalas chat ID kamu. Isi TELEGRAM_CHAT_ID di Vercel & GitHub Secrets, lalu Redeploy.`,
  });
}
