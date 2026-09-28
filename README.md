# Free Limiteds Board

A live board of free Roblox UGC limiteds that still have copies left, scraped from
[Rolimon's](https://www.rolimons.com/free-roblox-limiteds), newest drops first.

The board auto-checks every 5 minutes while open, badges items that dropped since your last
visit, pops a toast (and a `(3)` tab-title count) when new items land, and keeps its filters
in the URL hash so a filtered view can be shared or bookmarked.

The Rolimon's page renders from a JSON blob embedded in its HTML (`var item_details = {...}`)
and serves no CORS headers, so the scrape runs server-side in a Vercel function; the browser
only ever talks to `/api/items` on your own domain.

## Layout

```
api/items.js       serverless scraper -> JSON feed
public/index.html  the board (static, fetches /api/items on open)
vercel.json        function memory / timeout
```

## Deploy to Vercel

**Option A - dashboard (no Node needed locally).** Push this folder to a GitHub repo, then at
[vercel.com/new](https://vercel.com/new) import it. Framework preset: **Other**. Leave build and
output settings empty — Vercel serves `public/` statically and turns `api/items.js` into a
function automatically. Deploy.

**Option B - CLI.** Install [Node.js](https://nodejs.org) (this machine doesn't have it yet), then:

```
npm i -g vercel
cd "%USERPROFILE%\Desktop\free-limiteds"
vercel          # preview deploy, links the project
vercel --prod   # production URL
```

Run `vercel dev` for a local server at http://localhost:3000 with the API working.

## Tuning

- **Which shops to hide** — `EXCLUDED_GAMES` in `api/items.js`. Ships with `Flex UGC Codes` and
  `🔥 UGC Limited Codes` (code-gated, 1-3 copies each, not actually claimable) and `My Avatar!`.
  Add any game id to hide it. An item listed under several games is only dropped when *every*
  one of its games is excluded.
- **How fresh the data is** — the `cache-control` header in `api/items.js`. It's `s-maxage=900`
  (15 min at Vercel's edge) with `stale-while-revalidate=3600`. The Refresh button in the UI
  appends a cache-busting query so it always hits Rolimon's directly. Don't drop the cache to
  zero: every uncached open pulls a ~5 MB page from Rolimon's.
- **Date window** — the API returns everything added since Jan 1 of the current year, or the last
  30 days if that reaches further back (so January still has a full 30-day view). The 24h / 7d /
  30d / this-year toggle is client-side in `public/index.html`.

## If it breaks

A 502 with `item_details blob not found` means Rolimon's changed how the page embeds its data.
Fix `MARKER` / `TERMINATOR` in `api/items.js` to match the new markup.

The positional item format is:

```
[ name, addedUnix, totalCopies, copiesLeft, unused, thumbnailUrl, [{ name, game_id }] ]
```

The API trims each item to:

```
{ i: id, n: name, a: addedUnix, r: copiesLeft, t: totalCopies, g: gameName, gi: gameId,
  gx: extraGameCount, ty: assetType (from the thumbnail URL), th: thumbnailUrl }
```
