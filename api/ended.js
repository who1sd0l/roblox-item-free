// Items the watcher recently saw sell out or go off sale. The archive is intentionally short:
// it explains why something disappeared without turning the live board into a permanent catalog.
import { redis, ARCHIVE_KEY } from './_lib/redis.js';

export default async function handler(req, res) {
  try {
    const raw = await redis(['GET', ARCHIVE_KEY]);
    const archive = raw ? JSON.parse(raw) : { ts: Math.floor(Date.now() / 1000), items: {} };
    const since = Math.floor(Date.now() / 1000) - 72 * 3600;
    const items = Object.values(archive.items || {})
      .filter((item) => item.endedAt >= since)
      .sort((a, b) => b.endedAt - a.endedAt);

    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      ready: !!raw,
      updatedAt: raw ? new Date(archive.ts * 1000).toISOString() : null,
      windowHours: 72,
      count: items.length,
      items,
    });
  } catch (err) {
    res.setHeader('cache-control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
}
