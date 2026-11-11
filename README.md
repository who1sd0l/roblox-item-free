# Free Limiteds Board

A live board of free Roblox UGC limiteds that still have copies left, scraped from
[Rolimon's](https://www.rolimons.com/free-roblox-limiteds), newest drops first.

The board auto-checks every 5 minutes while open, badges items that dropped since your last
visit, pops a toast (and a `(3)` tab-title count) when new items land, and keeps its filters
in the URL hash so a filtered view can be shared or bookmarked. Status tabs highlight items
being claimed now, announced upcoming drops, drops waiting to start, items almost gone, and items
that recently ended.

The Rolimon's page renders from a JSON blob embedded in its HTML (`var item_details = {...}`)
and serves no CORS headers, so the scrape runs server-side in a Vercel function; the browser
only ever talks to `/api/items` on your own domain.

## Layout

```
api/_lib/          shared Rolimon's scraper + Roblox stock reader (not endpoints)
api/items.js       JSON feed for the board
api/watch.js       Discord alerts for 500+ copy items (call every minute)
api/x-watch.js     Discord alerts for new posts from configured X accounts
api/x-feed.js      public snapshots captured by the X watcher for the website
api/upcoming.js    structured upcoming drops inferred from trusted X posts
api/claimable.js   items the watcher saw being claimed in the last 24h ("Still claimable" tab)
api/ended.js       Roblox-confirmed sold-out / off-sale items from the last 72h
public/index.html  the board (static, fetches /api/items on open)
vercel.json        function timeouts
```

## Deploy to Vercel

**Option A - dashboard (no Node needed locally).** Push this folder to a GitHub repo, then at
[vercel.com/new](https://vercel.com/new) import it. Framework preset: **Other**. Leave build and
output settings empty — Vercel serves `public/` statically and turns `api/items.js` into a
function automatically. Deploy.

**Option B - CLI.** Install [Node.js](https://nodejs.org), then:

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

**Claiming now and Recently ended tabs**: the watcher also supplies the live hourly activity view
and keeps Roblox-confirmed sold-out or off-sale items for 72 hours. An ended item is removed from
the archive if Roblox puts it back on sale. These tabs therefore also require `/api/watch` to run.

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

## X account alerts

`/api/x-watch` checks selected X accounts for new posts and sends each one to the same Discord
webhook. This free version reads public profiles through the free
[Jina Reader API](https://jina.ai/reader/), which works from Vercel's serverless network. Public
Nitter/Teapawt RSS instances remain as a secondary fallback. No X developer account, bearer token,
login cookie, or paid API credit is needed.

Add these variables in Vercel → Project → Settings → Environment Variables, then redeploy:

- `X_ACCOUNTS`: comma-separated handles without passwords. For this project:
  `UgcNoticias_,itznevn,Xh0PlUgc`
- `X_DISCORD_WEBHOOK_URL`: webhook for the channel that should receive X post alerts. This is
  separate from `DISCORD_WEBHOOK_URL`, which continues receiving Roblox item alerts.
- `X_WATCH_SECRET` *(optional)*: a separate secret for this endpoint; otherwise `WATCH_SECRET`
  is used
- `X_DISCORD_MENTION` *(optional)*: e.g. `@everyone` or `<@&ROLE_ID>` on each X alert
- `X_INCLUDE_REPLIES` *(optional)*: `true` to notify for replies; off by default
- `X_INCLUDE_REPOSTS` *(optional)*: `true` to notify for reposts; off by default
- `X_RSS_BASE_URLS` *(optional)*: comma-separated custom mirrors, intended for a self-hosted
  instance or another instance whose operator gave permission

The existing Redis variables are reused. If `X_DISCORD_WEBHOOK_URL` is omitted, the watcher falls
back to `DISCORD_WEBHOOK_URL` for compatibility. Up to 10 accounts can be watched. The account list
stays on the server, and no X credentials are stored anywhere.

1. Test Discord without fetching an X profile:
   `https://YOUR-SITE.vercel.app/api/x-watch?key=YOUR_SECRET&test=1`
2. Run once to save the newest post as a baseline. This first run intentionally sends no old posts:
   `https://YOUR-SITE.vercel.app/api/x-watch?key=YOUR_SECRET`
3. Create a cron-job.org job for that same URL. Every 10 minutes is a sensible interval for a
   free community service and reliably catches the 20-minute reminder window.

After the baseline, Redis remembers recent post IDs or stable content fingerprints separately for
every account. Replies and reposts are ignored unless enabled; original posts and quote posts
notify normally. `?dry=1` previews what would be sent without posting to Discord or advancing the
saved state. The endpoint also accepts the secret in an `Authorization: Bearer YOUR_SECRET` header
if your scheduler supports headers.

The watcher also stores a small sanitized snapshot of each account's latest posts. `/api/x-feed`
publishes that snapshot without secrets, and the site's **X updates** tab displays it. The tab starts
filling after the first successful non-dry `/api/x-watch` run following deployment.

### Upcoming-drop tracking

The same X scan now extracts structured free-UGC announcements when a trusted post contains a
Roblox item or game link. It records the source, expanded links, release time, announced timezone,
method, expected stock, public code, region, and requirements. X snowflake IDs supply the exact post
time, so phrases such as `tomorrow at 5PM EST` can be converted without a paid X API.

When an item ID is present, the watcher checks Roblox's public catalog endpoint and labels the entry
as Roblox verified, live, ended, delayed, or still upcoming. Explicitly paid/Robux drops are excluded
from this free-item board. `/api/upcoming` exposes only the sanitized schedule, and the site's
**Upcoming** tab adds countdowns, source links, method/status filters, stock, codes, and game links.

On each normal `/api/x-watch` run, the X webhook can also receive:

- **Starting soon** when a confirmed time is within 20 minutes
- **Drop is live** when Roblox stock becomes available after an earlier announcement
- **Time changed** when a newer trusted post changes the schedule for the same item

These reminders use `X_DISCORD_WEBHOOK_URL` and `X_DISCORD_MENTION`. They require the watcher cron;
the website itself does not need to remain open. Ten-minute checks are recommended if you want the
20-minute reminder reliably. Test and dry-run calls never advance reminder state.

This is genuinely free, but it is less reliable than the official X API. Reader and the community
RSS fallbacks ultimately depend on X's public website or unofficial internal interface and may
temporarily stop working after an X change.

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
