// Live stock straight from Roblox's catalog API. No login needed: the endpoint only wants a CSRF
// token, which it hands out (and rotates every few minutes) on a 403 response.

const DETAILS = 'https://catalog.roblox.com/v1/catalog/items/details';
const BATCH = 120; // Roblox rejects more than 120 items per request with "Invalid count"

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Map of assetId -> normalized public catalog details. Items Roblox doesn't return are missing.
export async function fetchCatalogDetails(ids) {
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
    for (const d of data) out.set(String(d.id), {
      n: d.name || '',
      r: typeof d.unitsAvailableForConsumption === 'number' ? d.unitsAvailableForConsumption : null,
      t: typeof d.totalQuantity === 'number' ? d.totalQuantity : 0,
      off: d.priceStatus === 'Off Sale',
      // lowestPrice is often a reseller's price for an originally free limited, so it must not
      // be used to decide whether the announced drop itself costs Robux.
      price: typeof d.price === 'number' ? d.price : null,
    });
  }
  return out;
}

// Stock watcher compatibility: only return collectible items with a numeric remaining count.
export async function fetchStock(ids) {
  const details = await fetchCatalogDetails(ids);
  return new Map([...details].filter(([, item]) => typeof item.r === 'number'));
}
