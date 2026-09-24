// Serverless scraper for Rolimon's free UGC limiteds.
// The page ships its whole catalog as `var item_details = {...};` inside the HTML,
// so we pull that blob out server-side (a browser can't: no CORS headers on rolimons.com).

const SOURCE = 'https://www.rolimons.com/free-roblox-limiteds';
const MARKER = 'var item_details = ';
const TERMINATOR = ';</script>';

// Games whose "free" items need a creator-supplied code, so the stock count is fiction.
// Add a game id here to drop it from the feed.
const EXCLUDED_GAMES = new Set([
  '15108736400',    // Flex UGC Codes
  '75387700043737', // My Avatar!
]);

// item_details values are positional:
// [ name, addedUnix, totalCopies, copiesLeft, unused, thumbnailUrl, [{name, game_id}] ]
function parseCatalog(html) {
  const start = html.indexOf(MARKER);
  if (start === -1) throw new Error('item_details blob not found — Rolimon\'s page layout changed');
  const from = start + MARKER.length;
  const end = html.indexOf(TERMINATOR, from);
  if (end === -1) throw new Error('could not find the end of the item_details blob');
  return JSON.parse(html.slice(from, end));
}

function toRows(catalog, since) {
  const rows = [];
  for (const [id, v] of Object.entries(catalog)) {
    const [name, added, total, left, , thumb, games] = v;
    if (added < since) continue;
    if (!left || left <= 0) continue;
    const game = games && games.length ? games[0] : null;
    const gameId = game ? String(game.game_id) : '';
    if (EXCLUDED_GAMES.has(gameId)) continue;
    rows.push({
      i: id,
      n: name,
      d: new Date(added * 1000).toISOString().slice(0, 10),
      r: left,
      t: total,
      g: game ? game.name : '',
      gi: gameId,
      th: thumb || '',
    });
  }
  rows.sort((a, b) => b.r - a.r);
  return rows;
}

export default async function handler(req, res) {
  try {
    const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
    const upstream = await fetch(SOURCE, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!upstream.ok) throw new Error(`Rolimon's returned HTTP ${upstream.status}`);

    const rows = toRows(parseCatalog(await upstream.text()), yearStart);

    // Rolimon's own numbers move slowly; 15 min of edge cache keeps us off their back.
    res.setHeader('cache-control', 's-maxage=900, stale-while-revalidate=3600');
    res.status(200).json({
      fetchedAt: new Date().toISOString(),
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
