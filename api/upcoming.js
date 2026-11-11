// Public, read-only schedule inferred from trusted X posts and verified against Roblox when possible.

import { redis, X_SCHEDULE_KEY } from './_lib/redis.js';

const publicItem = (item) => ({
  id: item.id,
  itemId: item.itemId || null,
  title: item.title || 'Free UGC announcement',
  username: item.username,
  sourceUrl: item.sourceUrl,
  createdAt: item.createdAt,
  scheduledAt: item.scheduledAt || null,
  timezone: item.timezone || null,
  text: item.text || '',
  image: item.image || null,
  itemUrl: item.itemUrl || null,
  gameUrls: Array.isArray(item.gameUrls) ? item.gameUrls.slice(0, 4) : [],
  method: item.method || 'Unknown',
  expectedStock: item.expectedStock ?? null,
  limitPerUser: item.limitPerUser ?? null,
  code: item.code || null,
  region: item.region || null,
  isRestock: Boolean(item.isRestock),
  verified: Boolean(item.verified),
  currentStock: item.currentStock ?? null,
  totalStock: item.totalStock ?? null,
  offSale: item.offSale ?? null,
  status: item.status || 'announced',
  checkedAt: item.checkedAt || null,
});

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const raw = await redis(['GET', X_SCHEDULE_KEY]);
    res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
    if (!raw) return res.status(200).json({ ready: false, items: [], counts: {}, updatedAt: null });
    const schedule = JSON.parse(raw);
    const items = (schedule.items || []).filter((item) => !item.isPaid).slice(0, 100).map(publicItem);
    const counts = items.reduce((out, item) => {
      out[item.status] = (out[item.status] || 0) + 1;
      return out;
    }, {});
    return res.status(200).json({ ready: true, items, counts, updatedAt: schedule.updatedAt || null });
  } catch (error) {
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json({ error: error.message || 'Upcoming feed unavailable' });
  }
}
