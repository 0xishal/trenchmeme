// JSON API: /api/analyze?ca=<mint>  (dipakai halaman web & untuk debug)
import { analyzeToken, extractMint } from '../lib/analyze.js';
import { resolveMint } from '../lib/telegram.js';
import { checkAccess } from '../lib/util.js';

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  const raw = extractMint(req.query.ca || req.query.mint || '');
  if (!raw) return res.status(400).json({ error: 'Parameter ?ca= wajib berisi CA Solana' });
  try {
    const mint = await resolveMint(raw);
    const r = await analyzeToken(mint);
    res.setHeader('cache-control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json(r);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
