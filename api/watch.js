// Discord alerts for big free limiteds. Hit this every minute from an external cron
// (cron-job.org): GET /api/watch?key=WATCH_SECRET
//
// Data: Rolimon's is only used to discover which items exist (refreshed every 5 minutes); copies
// left come straight from Roblox every run, so alerts don't wait on Rolimon's update lag and
// off-sale / sold-out items are skipped. If Roblox refuses, the run falls back to Rolimon's numbers.
//
// Alerts (each is a new message, so it notifies):
//   - "Claiming started"   an untouched item (copies left = total) has started moving
//   - "Claiming reopened"  an item quiet for DORMANT_HOURS got REOPEN_MIN+ claims within 30 minutes
//                          (single stragglers trickling in don't count)
//   - "Still claimable"    the first claim the watcher sees on an older item. Once per item, ever;
//                          sent as one list linking to the site's "Still claimable" tab
//   - "New drop"           an item that wasn't tracked last run
// Live board: one message that is edited in place every run (edits don't notify), listing what is
// being claimed right now and what is waiting to start. Pin it in the channel.
//
// Env: DISCORD_WEBHOOK_URL, WATCH_SECRET, KV_REST_API_URL + KV_REST_API_TOKEN
//      (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Optional: MIN_TOTAL (default 500),
//      DORMANT_HOURS (default 24), REOPEN_MIN (default 5), DISCORD_MENTION (e.g. "@everyone",
//      added to started/reopened alerts), DISCORD_BOARD=off to disable the live board,
//      SITE_URL (defaults to the host this endpoint was called on) for links to the board.
// Query: ?test=1 sends a sample alert; ?dry=1 reports what would happen without sending or saving.

import { fetchItems } from './_lib/rolimons.js';
import { fetchStock } from './_lib/roblox.js';
import { redis, STATE_KEY, META_KEY } from './_lib/redis.js';

// v3 state: { ts, src, slot, board, items: { id: { r, m, q, s?, c?, w? } } }
//   r = copies left, m = last time it moved, q = copies left at the last few 15-min marks,
//   s = last time a claim was actually observed (read by /api/claimable), c = already announced,
//   w = [copiesLeftWhenWoken, wokeAt, quietSince] while a dormant item is being watched for a reopen
//   src = which source the numbers came from. Rolimon's lags Roblox, so comparing one against the
//   other would look like movement: a run where the source changed only records, it never alerts.
// meta: { ts, items: { id: Rolimon's row } }, the list of tracked items (refreshed every META_TTL).
const LEGACY_KEY = 'flb:watch:v2';
const META_TTL = 300;
const SLOT = 900;          // activity sample every 15 minutes...
const SLOTS = 5;           // ...keeping five, so q[0] is roughly an hour old
const REOPEN_WINDOW = 1800;
const MAX_CARDS = 4;       // more alerts of one kind than this in a run are sent as a single list
const COLORS = { started: 0x22c55e, reopened: 0xf59e0b, claimable: 0x14b8a6, new: 0x7c5cff, board: 0x2b2d31 };
const TITLES = {
  started: '🚨 Claiming started',
  reopened: '🔥 Claiming reopened',
  claimable: '✅ Still claimable',
  new: '✨ New drop',
};

const env = (k) => (process.env[k] || '').trim();
const nf = (n) => n.toLocaleString('en-US');
// Names like "[NEW] Foo" would break Discord's [text](url) link syntax.
const md = (s) => s.replace(/[\[\]\\*_~`|]/g, '\\$&');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const catalogUrl = (it) => `https://www.roblox.com/catalog/${it.i}/`;
const gameUrl = (it) => (it.gi ? `https://www.roblox.com/games/${it.gi}` : '');

// POSTs a new message, or PATCHes an existing one when messageId is given. Returns Discord's
// message object, or null when the message to edit no longer exists.
async function discord(payload, messageId) {
  const hook = env('DISCORD_WEBHOOK_URL');
  if (!hook) throw new Error('DISCORD_WEBHOOK_URL is not set');
  const u = new URL(hook);
  if (messageId) u.pathname += `/messages/${messageId}`;
  else u.searchParams.set('wait', 'true');
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(u, {
      method: messageId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) return r.json();
    if (r.status === 404 && messageId) return null;
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await new Promise((ok) => setTimeout(ok, Math.min(5, j.retry_after || 1) * 1000));
      continue;
    }
    throw new Error(`Discord returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error('Discord kept rate-limiting the webhook');
}

/* ---------- alert messages ---------- */

function card(e) {
  const { item, kind } = e;
  const game = gameUrl(item);
  const status = kind === 'started'
    ? `🟢 **Claiming is open** — ${nf(item.t - item.r)} claimed so far`
    : kind === 'reopened'
      ? `🟢 **${nf(e.claimed)} claimed in the last few minutes** after being quiet since <t:${e.quietSince}:R>`
      : item.r === item.t
        ? '⏳ Not claimable yet — you\'ll get a ping when the count starts moving'
        : `🟢 Already claiming — ${nf(item.t - item.r)} claimed`;
  return {
    title: cut(`${TITLES[kind]}: ${item.n}`, 256),
    url: catalogUrl(item),
    color: COLORS[kind],
    description: [
      status,
      game ? `🎮 **[${md(item.g || 'Open game')}](${game})**` : '🎮 No game listed',
      `[View on Roblox catalog](${catalogUrl(item)})`,
    ].join('\n'),
    fields: [
      { name: 'Copies left', value: `${nf(item.r)} / ${nf(item.t)}`, inline: true },
      { name: 'Added', value: `<t:${item.a}:R>`, inline: true },
    ],
    thumbnail: item.th ? { url: item.th } : undefined,
    timestamp: new Date().toISOString(),
  };
}

// Many alerts of one kind in a single run become one compact list (description cap is 4096).
function list(kind, events) {
  const lines = [];
  for (const e of events) {
    const { item } = e;
    const game = item.gi ? ` · [${md(cut(item.g || 'game', 40))}](${gameUrl(item)})` : '';
    const extra = kind === 'reopened' || kind === 'claimable' ? `, +${nf(e.claimed)} just now` : '';
    const line = `• **[${md(cut(item.n, 60))}](${catalogUrl(item)})** — ${nf(item.r)}/${nf(item.t)} left${extra}${game}`;
    if (lines.join('\n').length + line.length > 3900) { lines.push(`…and ${events.length - lines.length} more`); break; }
    lines.push(line);
  }
  return { title: `${TITLES[kind]} · ${events.length} item${events.length === 1 ? '' : 's'}`, color: COLORS[kind], description: lines.join('\n') };
}

async function sendAlerts(events, claimableUrl) {
  const mention = env('DISCORD_MENTION');
  for (const [kind, ping] of [['started', true], ['reopened', true], ['claimable', false], ['new', false]]) {
    const group = events.filter((e) => e.kind === kind);
    if (!group.length) continue;
    // "Still claimable" is low-priority catch-up info: always one quiet list with a link to the site.
    if (kind === 'claimable') {
      const embed = list(kind, group);
      if (claimableUrl) embed.description += `\n\n**[See every still-claimable item →](${claimableUrl})**`;
      await discord({ embeds: [embed] });
      continue;
    }
    const embeds = group.length > MAX_CARDS ? [list(kind, group)] : group.map(card);
    await discord({
      content: ping && mention ? mention : undefined,
      embeds,
      allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
    });
  }
}

/* ---------- live board (edited in place) ---------- */

function boardPayload(rows, now, source, claimableUrl) {
  const line = (x, extra) => {
    const game = x.item.gi ? ` · [${md(cut(x.item.g || 'game', 32))}](${gameUrl(x.item)})` : '';
    return `**[${md(cut(x.item.n, 48))}](${catalogUrl(x.item)})** — ${nf(x.item.r)}/${nf(x.item.t)}${extra}${game}`;
  };
  const active = rows.filter((x) => x.hour > 0).sort((a, b) => b.hour - a.hour).slice(0, 12);
  const waiting = rows.filter((x) => x.item.r === x.item.t).sort((a, b) => b.item.a - a.item.a).slice(0, 10);
  const lowest = rows.filter((x) => x.hour > 0 && x.item.r / x.item.t <= 0.1);
  return {
    content: '',
    embeds: [
      {
        title: '🔥 Being claimed right now',
        color: COLORS.started,
        description: active.length
          ? active.map((x, i) => `${i + 1}. ${line(x, ` · **+${nf(x.hour)}**/hr`)}`).join('\n')
          : '_Nothing has moved in the last hour._',
      },
      {
        title: '⏳ Waiting to start',
        color: COLORS.new,
        description: waiting.length
          ? waiting.map((x) => `• ${line(x, ` · added <t:${x.item.a}:R>`)}`).join('\n')
          : '_Every tracked item has started._',
      },
      {
        color: COLORS.board,
        description: `Tracking **${rows.length}** items · ${lowest.length} almost gone · ` +
          `stock from ${source} · updated <t:${now}:R>` +
          (claimableUrl ? `\n**[All still-claimable items →](${claimableUrl})**` : ''),
      },
    ],
  };
}

/* ---------- main ---------- */

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = env('WATCH_SECRET');
  const given = (req.query && req.query.key) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || given !== secret) return res.status(401).json({ error: 'bad or missing key' });

  try {
    const minTotal = Number(env('MIN_TOTAL')) || 500;
    const dormant = (Number(env('DORMANT_HOURS')) || 24) * 3600;
    const reopenMin = Number(env('REOPEN_MIN')) || 5;
    const now = Math.floor(Date.now() / 1000);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const site = (env('SITE_URL') || (host ? `https://${host}` : '')).replace(/\/+$/, '');
    const claimableUrl = site ? `${site}/#tab=claimable` : '';
    const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);

    const [rawState, rawMeta, rawLegacy] = await redis(['MGET', STATE_KEY, META_KEY, LEGACY_KEY]);

    // Which items to track: Rolimon's list, refreshed every few minutes.
    let meta = rawMeta ? JSON.parse(rawMeta) : null;
    let metaFresh = false;
    const refreshMeta = async () => {
      const rows = (await fetchItems(yearStart)).filter((it) => it.t >= minTotal);
      meta = { ts: now, items: Object.fromEntries(rows.map(({ i, n, a, r, t, g, gi, gx, ty, th }) => [i, { i, n, a, r, t, g, gi, gx, ty, th }])) };
      metaFresh = true;
    };
    if (!meta || now - meta.ts >= META_TTL || req.query.refresh) await refreshMeta();

    // Copies left: Roblox, or Rolimon's numbers if Roblox refuses.
    let stock;
    let source = 'roblox';
    try {
      stock = await fetchStock(Object.keys(meta.items));
    } catch {
      source = 'rolimons';
      if (!metaFresh) await refreshMeta();
      stock = new Map();
    }

    const items = [];
    const offSale = [];
    for (const m of Object.values(meta.items)) {
      const s = stock.get(m.i);
      const r = s ? s.r : m.r;
      if (r <= 0) continue; // sold out
      const item = { ...m, r, t: Math.max(m.t, s ? s.t : 0, r) };
      if (s && s.off) offSale.push(item.n);
      else items.push(item);
    }

    if (req.query.test) {
      const sample = items.find((it) => it.r < it.t) || items[0];
      if (!sample) return res.status(200).json({ ok: true, note: 'no items to use as a sample' });
      await discord({ content: '🧪 Test alert from Free Limiteds Board', embeds: [card({ kind: 'started', item: sample })] });
      return res.status(200).json({ ok: true, sent: 'test', item: sample.n, source });
    }

    let prev = rawState ? JSON.parse(rawState) : null;
    if (!prev && rawLegacy) {
      // Upgrade from v2 (Rolimon's numbers). Its `src` differs, so this run only records; everything
      // starts as recently active so the switch-over doesn't fire a burst of "reopened" alerts.
      const old = JSON.parse(rawLegacy);
      prev = { ts: old.ts, src: 'rolimons-v2', items: Object.fromEntries(Object.entries(old.items).map(([id, [r]]) => [id, { r, m: now, q: [r] }])) };
    }
    const compare = prev && prev.src === source;

    const slot = Math.floor(now / SLOT);
    const next = { ts: now, src: source, slot, board: prev && prev.board, items: {} };
    const events = [];
    const rows = [];
    for (const item of items) {
      const p = prev && prev.items[item.i];
      const cur = { r: item.r, m: p ? p.m : now, q: p ? p.q : [item.r] };
      if (p && p.s) cur.s = p.s;
      if (p && p.c) cur.c = 1;
      const before = events.length;
      if (p && !compare) {
        // Different source than last run: carry the history over but don't read anything into
        // the jump in numbers. Activity samples restart from this source's numbers.
        cur.q = [item.r];
        if (p.w) cur.w = [item.r, p.w[1], p.w[2]];
      } else if (p) {
        const moved = p.r - item.r;
        let w = p.w;
        if (moved > 0) {
          if (p.r >= item.t && item.r < item.t) events.push({ kind: 'started', item });
          else if (!w && now - p.m >= dormant) w = [p.r, now, p.m];
          cur.m = now;
          cur.s = now;
        }
        if (w) {
          const claimed = w[0] - item.r;
          if (claimed >= reopenMin) {
            events.push({ kind: 'reopened', item, claimed, quietSince: w[2] });
          } else if (now - w[1] <= REOPEN_WINDOW) {
            cur.w = w; // still waiting to see if this is real activity or a straggler
          }
        }
        // First claim ever seen on an item nothing else announced: one quiet "still claimable".
        if (moved > 0 && !cur.c && events.length === before) {
          events.push({ kind: 'claimable', item, claimed: moved });
        }
      } else if (prev && item.a >= prev.ts - 3600) {
        // Only brand-new additions; not old items that crossed MIN_TOTAL or came back into stock.
        events.push({ kind: 'new', item });
      }
      // Anything announced as claiming counts, so it never gets a separate "still claimable".
      if (events.length > before && item.r < item.t) cur.c = 1;
      if (!prev || prev.slot !== slot) cur.q = [...cur.q, item.r].slice(-SLOTS);
      next.items[item.i] = cur;
      rows.push({ item, hour: Math.max(0, cur.q[0] - item.r) });
    }

    const waiting = items.filter((it) => it.r === it.t).length;
    const summary = {
      ok: true,
      source,
      compared: !!compare,
      tracked: items.length,
      waiting,
      offSale: offSale.length,
      firstRun: !prev,
      started: events.filter((e) => e.kind === 'started').map((e) => e.item.n),
      reopened: events.filter((e) => e.kind === 'reopened').map((e) => e.item.n),
      stillClaimable: events.filter((e) => e.kind === 'claimable').map((e) => e.item.n),
      new: events.filter((e) => e.kind === 'new').map((e) => e.item.n),
    };
    if (req.query.dry) return res.status(200).json({ ...summary, dry: true });

    if (!prev) {
      await discord({
        content: `👀 Watcher online — tracking **${items.length}** free limiteds from this year with ${nf(minTotal)}+ copies ` +
          `(**${waiting}** not claimable yet). You'll be pinged when one starts being claimed, an old one ` +
          'comes back to life, or a new one drops. The board below updates itself — pin it.',
      });
    } else if (events.length) {
      await sendAlerts(events, claimableUrl);
    }

    // The board is a nice-to-have; never let it block alerts or the state save.
    if (env('DISCORD_BOARD').toLowerCase() !== 'off') {
      try {
        const payload = boardPayload(rows, now, source === 'roblox' ? 'Roblox' : "Rolimon's (Roblox unavailable)", claimableUrl);
        const edited = next.board && (await discord(payload, next.board));
        if (!edited) next.board = (await discord(payload)).id;
        summary.board = 'ok';
      } catch (err) {
        summary.board = String(err.message || err);
      }
    }

    // Save only after Discord accepted the alerts, so a failed post is retried next run.
    const writes = [redis(['SET', STATE_KEY, JSON.stringify(next)])];
    if (metaFresh) writes.push(redis(['SET', META_KEY, JSON.stringify(meta)]));
    await Promise.all(writes);
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
