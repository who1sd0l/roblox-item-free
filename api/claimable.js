// Items the watcher has actually seen being claimed on Roblox recently, for the board's
// "Still claimable" tab. Reads the watcher's saved state; never calls Roblox or Rolimon's itself.
import { redis, STATE_KEY, META_KEY } from './_lib/redis.js';

const WINDOW_HOURS = 24;

export default async function handler(req, res) {
  try {
    const [rawState, rawMeta] = await redis(['MGET', STATE_KEY, META_KEY]);
    if (!rawState || !rawMeta) throw new Error('The watcher has not run yet');
    const state = JSON.parse(rawState);
    const meta = JSON.parse(rawMeta);
    const since = state.ts - WINDOW_HOURS * 3600;

    const items = [];
    for (const [id, s] of Object.entries(state.items)) {
      const m = meta.items[id];
      if (!m || !s.s || s.s < since) continue;
      items.push({
        ...m,
        r: s.r,
        t: Math.max(m.t, s.r),
        seen: s.s,                               // last time a claim was observed
        hour: Math.max(0, (s.q ? s.q[0] : s.r) - s.r), // claims in roughly the last hour
      });
    }
    items.sort((a, b) => b.hour - a.hour || b.seen - a.seen);

    // The watcher runs every minute; a minute of edge cache keeps Redis reads low.
    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      updatedAt: new Date(state.ts * 1000).toISOString(),
      source: state.src,
      windowHours: WINDOW_HOURS,
      count: items.length,
      items,
    });
  } catch (err) {
    res.setHeader('cache-control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
}
