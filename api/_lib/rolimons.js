// Shared Rolimon's scraper. Files under api/_lib are not deployed as endpoints.
// The page ships its whole catalog as `var item_details = {...};` inside the HTML,
// so we pull that blob out server-side (a browser can't: no CORS headers on rolimons.com).

export const SOURCE = 'https://www.rolimons.com/free-roblox-limiteds';
const MARKER = 'var item_details = ';
const TERMINATOR = ';</script>';

// Games whose "free" items need a creator-supplied code, so the stock count is fiction.
// Add a game id here to drop it from the feed.
export const EXCLUDED_GAMES = new Set([
  '15108736400',    // Flex UGC Codes
  '14842238611',    // 🔥 UGC Limited Codes
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

// In-stock, non-excluded items added since `since` (unix seconds), newest first.
export async function fetchItems(since) {
  const upstream = await fetch(SOURCE, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!upstream.ok) throw new Error(`Rolimon's returned HTTP ${upstream.status}`);
  return toRows(parseCatalog(await upstream.text()), since);
}
