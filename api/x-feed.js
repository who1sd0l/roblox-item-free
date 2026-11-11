// Public, read-only feed of the posts already captured by /api/x-watch.
// It never calls X and never exposes watcher secrets, webhook URLs, or Redis credentials.

import { redis, X_STATE_KEY } from './_lib/redis.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const raw = await redis(['GET', X_STATE_KEY]);
    res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
    if (!raw) return res.status(200).json({ ready: false, items: [], accounts: [], updatedAt: null });

    const state = JSON.parse(raw);
    const items = [];
    const accounts = [];
    const used = new Set();
    for (const [username, account] of Object.entries(state.accounts || {})) {
      const posts = Array.isArray(account.posts) ? account.posts : [];
      accounts.push({ username, count: posts.length });
      for (const post of posts) {
        const key = post.key || (post.id ? `id:${post.id}` : '');
        const accountKey = `${username}:${key}`;
        if (!key || used.has(accountKey)) continue;
        used.add(accountKey);
        items.push({
          id: post.id || null,
          key,
          username: post.username || username,
          creator: post.creator || username,
          name: post.name || username,
          text: post.text || '',
          createdAt: post.createdAt || null,
          url: post.url || `https://x.com/${encodeURIComponent(username)}`,
          avatar: post.avatar || null,
          image: post.image || null,
          links: Array.isArray(post.links) ? post.links.slice(0, 12) : [],
          repost: Boolean(post.repost),
          reply: Boolean(post.reply),
        });
      }
    }

    items.sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (at !== bt) return bt - at;
      if (/^\d+$/.test(a.id || '') && /^\d+$/.test(b.id || '')) {
        return BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0;
      }
      return a.username.localeCompare(b.username);
    });
    accounts.sort((a, b) => a.username.localeCompare(b.username));

    return res.status(200).json({
      ready: items.length > 0,
      items: items.slice(0, 60),
      accounts,
      updatedAt: state.ts ? new Date(state.ts * 1000).toISOString() : null,
    });
  } catch (error) {
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json({ error: error.message || 'X feed unavailable' });
  }
}
