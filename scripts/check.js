// CLI: node scripts/check.js <CA>   → cetak laporan format Telegram ke terminal (tanpa kirim).
import { analyzeToken, extractMint } from '../lib/analyze.js';
import { formatReport, resolveMint } from '../lib/telegram.js';

const raw = extractMint(process.argv.slice(2).join(' '));
if (!raw) { console.log('Pakai: node scripts/check.js <CA>'); process.exit(1); }
const r = await analyzeToken(await resolveMint(raw));
console.log(formatReport(r).replace(/<[^>]+>/g, ''));
if (process.env.JSON) console.log(JSON.stringify(r, null, 2));
