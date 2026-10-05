// Live stock straight from Roblox's catalog API. No login needed: the endpoint only wants a CSRF
// token, which it hands out (and rotates every few minutes) on a 403 response.

const DETAILS = 'https://catalog.roblox.com/v1/catalog/items/details';
const BATCH = 120; // Roblox rejects more than 120 items per request with "Invalid count"

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Map of assetId -> { r: copiesLeft, t: totalCopies, off: isOffSale }. Items Roblox doesn't
// return are simply missing from the map.
export async function fetchStock(ids) {
  const out = new Map();
  let token = '';
  for (let i = 0; i < ids.length; i += BATCH) {
    const body = JSON.stringify({ items: ids.slice(i, i + BATCH).map((id) => ({ itemType: 'Asset', id: Number(id) })) });
    let data = null;
    for (let attempt = 0; attempt < 4 && !data; attempt++) {
      const r = await fetch(DETAILS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body,
      });
      if (r.status === 403 && r.headers.get('x-csrf-token')) {
        token = r.headers.get('x-csrf-token');
        continue;
      }
      if (r.status === 429) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error(`Roblox returned HTTP ${r.status}`);
      data = (await r.json()).data || [];
    }
    if (!data) throw new Error('Roblox kept refusing the request (rate limited)');
    for (const d of data) {
      if (typeof d.unitsAvailableForConsumption !== 'number') continue;
      out.set(String(d.id), {
        r: d.unitsAvailableForConsumption,
        t: d.totalQuantity || 0,
        off: d.priceStatus === 'Off Sale',
      });
    }
  }
  return out;
}
