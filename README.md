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
api/_lib/          shared Rolimon's scraper + Roblox stock reader (not endpoints)
api/items.js       JSON feed for the board
api/watch.js       Discord alerts for 500+ copy items (call every minute)
api/claimable.js   items the watcher saw being claimed in the last 24h ("Still claimable" tab)
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

## Discord alerts

`/api/watch` watches every in-stock free limited released this year with **500+ total copies**.
Rolimon's is only used to find which items exist (every 5 minutes). **Copies left come straight
from Roblox's catalog API every run**, so alerts don't wait on Rolimon's update lag, and items Roblox
marks Off Sale or sold out are skipped. If Roblox refuses a request, that run uses Rolimon's numbers.

Alerts (new messages, so they notify):

- **🚨 Claiming started**: an untouched item (copies left = total) just started moving
- **🔥 Claiming reopened**: an item that was quiet for 24h+ got 5+ claims within 30 minutes. One
  person claiming a leftover copy doesn't count, which is what made the old "still claimable"
  alert so noisy.
- **✅ Still claimable**: the first claim the watcher ever sees on an older item. Sent **once per
  item**, always as one quiet list (no mention) with a link to the site's **Still claimable** tab
- **✨ New drop**: it's new since the last check (the alert says whether it's claimable yet)

More than 4 of one kind in the same check arrive as a single list.

**Still claimable tab** (`/#tab=claimable` on the site): every tracked item someone claimed on Roblox
in the last 24 hours, sorted by claims in the last hour. It reads the watcher's saved data, so it
only fills in once `/api/watch` is running. The alert links use the domain cron-job.org calls; set
`SITE_URL` if you want them to point at a different domain.

**Live board**: one message the watcher edits in place every minute, listing what's being claimed
right now (claims in the last hour) and what's waiting to start. Edits don't notify, so pin it and
glance at it whenever. If it's deleted, the next run posts a new one.

It remembers the previous numbers in Upstash Redis and needs something to call it every minute.

1. **Webhook**: in Discord, channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy
   Webhook URL. Keep it private: anyone with the URL can post in the channel.
2. **Redis**: Vercel project → Storage → Create → Upstash (Redis), free plan, connect it to this
   project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Env vars**: Vercel project → Settings → Environment Variables:
   - `DISCORD_WEBHOOK_URL`: the webhook URL
   - `WATCH_SECRET`: any long random string (stops strangers triggering it)
   - `DISCORD_MENTION` *(optional)*: e.g. `@everyone`, added to started / reopened alerts
   - `MIN_TOTAL` *(optional)*: minimum total copies, default `500`
   - `DORMANT_HOURS` *(optional)*: how long an item must be quiet to count as reopened, default `24`
   - `REOPEN_MIN` *(optional)*: claims needed within 30 minutes to count as reopened, default `5`
   - `DISCORD_BOARD` *(optional)*: `off` to disable the live board
   - `SITE_URL` *(optional)*: site address used in alert links, e.g. `https://my-board.vercel.app`

   Then redeploy so the function picks them up.
4. **Test**: open `https://YOUR-SITE.vercel.app/api/watch?key=WATCH_SECRET&test=1`; a sample alert
   should appear in Discord.
5. **Schedule**: at [cron-job.org](https://cron-job.org) (free) create a job for
   `https://YOUR-SITE.vercel.app/api/watch?key=WATCH_SECRET` every 1 minute. Vercel's own cron
   only runs once a day on the free plan, which is too slow for this.

The very first run posts "Watcher online" and records a baseline. Any run where the stock source
changed (Roblox ↔ Rolimon's fallback, or an upgrade) also only records, because the two sources
disagree and the difference would look like claims. `?dry=1` shows what would be sent without
sending or saving; the JSON response says which source was used (`"source":"roblox"`).

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
