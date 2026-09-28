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
  '14842238611',    // 🔥 UGC Limited Codes
  '75387700043737', // My Avatar!
]);

// The client offers a "last 30 days" view, so in January we still need December's items.
const WINDOW_DAYS = 30;

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

// Thumbnail URLs look like .../150/150/NeckAccessory/Webp/noFilter — the asset type is free.
function assetType(thumb) {
  const m = /\/\d+\/\d+\/([A-Za-z]+)\//.exec(thumb || '');
  return m && m[1] !== 'UnavailableImage' ? m[1] : '';
}

function toRows(catalog, since) {
  const rows = [];
  for (const [id, v] of Object.entries(catalog)) {
    const [name, added, total, left, , thumb, games] = v;
    if (added < since) continue;
    if (!left || left <= 0) continue;
    // Items can be listed under several games; drop only the excluded ones, so an item that is
    // in both a code shop and a real game still shows up under the real game.
    const all = Array.isArray(games) ? games : [];
    const playable = all.filter((g) => !EXCLUDED_GAMES.has(String(g.game_id)));
    if (all.length && !playable.length) continue;
    const game = playable.find((g) => g.game_id) || null; // game_id 0 = "[TITLE UNAVAILABLE]"
    rows.push({
      i: id,
      n: name.trim(),
      a: added,
      r: left,
      t: Math.max(total || 0, left),
      g: game ? game.name.trim() : '',
      gi: game ? String(game.game_id) : '',
      gx: Math.max(0, playable.filter((g) => g.game_id).length - 1),
      ty: assetType(thumb),
      th: thumb || '',
    });
  }
  rows.sort((a, b) => b.a - a.a);
  return rows;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    const since = Math.floor(Math.min(yearStart, now - WINDOW_DAYS * 86400000) / 1000);
    const upstream = await fetch(SOURCE, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!upstream.ok) throw new Error(`Rolimon's returned HTTP ${upstream.status}`);

    const rows = toRows(parseCatalog(await upstream.text()), since);

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
