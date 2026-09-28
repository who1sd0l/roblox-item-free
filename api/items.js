// JSON feed for the board. Scraping lives in _lib/rolimons.js, shared with the alert watcher.
import { SOURCE, EXCLUDED_GAMES, fetchItems } from './_lib/rolimons.js';

// The client offers a "last 30 days" view, so in January we still need December's items.
const WINDOW_DAYS = 30;

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    const since = Math.floor(Math.min(yearStart, now - WINDOW_DAYS * 86400000) / 1000);
    const rows = await fetchItems(since);

    // Rolimon's own numbers move slowly; 15 min of edge cache keeps us off their back.
    res.setHeader('cache-control', 's-maxage=900, stale-while-revalidate=3600');
    res.status(200).json({
      fetchedAt: new Date(now).toISOString(),
      source: SOURCE,
      excludedGames: [...EXCLUDED_GAMES],
      count: rows.length,
      items: rows,
    });
  } catch (err) {
    res.setHeader('cache-control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
}
