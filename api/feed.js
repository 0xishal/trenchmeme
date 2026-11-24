// JSON API: kandidat token baru yang lolos prefilter (<MAX_MCAP), untuk halaman web.
import { candidates } from '../lib/feed.js';
import { checkAccess } from '../lib/util.js';

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  try {
    const r = await candidates();
    res.setHeader('cache-control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(r);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
