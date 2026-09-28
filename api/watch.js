// Discord alerts for big free limiteds. Hit this every minute from an external cron
// (cron-job.org): GET /api/watch?key=WATCH_SECRET
//
// Each run compares Rolimon's numbers with the previous run (kept in Upstash Redis) and posts:
//   - "Claiming started"  an item that sat untouched (copies left = total) has started moving
//   - "Still claimable"   an older item's stock moved after IDLE_HOURS of no movement (or the first
//                         movement the watcher has seen), so it can still be claimed
//   - "New drop"          an item that wasn't there last run
// Every in-stock item released this year with at least MIN_TOTAL total copies is tracked.
//
// Env: DISCORD_WEBHOOK_URL, WATCH_SECRET, KV_REST_API_URL + KV_REST_API_TOKEN
//      (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), optional MIN_TOTAL (default 500),
//      optional IDLE_HOURS (default 12), optional DISCORD_MENTION (e.g. "@everyone" or
//      "<@&roleId>") prepended to claim-started and still-claimable pings.
// Query: ?test=1 sends a sample alert; ?dry=1 reports what would be sent without sending or saving.

import { fetchItems } from './_lib/rolimons.js';

// v2 state: { ts, items: { id: [copiesLeft, lastMovedUnix | 0] } }. v1 was { ts, items: { id: copiesLeft } }.
const STATE_KEY = 'flb:watch:v2';
const LEGACY_KEY = 'flb:watch:v1';
const COLOR_STARTED = 0x22c55e;
const COLOR_REVIVED = 0xf59e0b;
const COLOR_NEW = 0x7c5cff;
// More "still claimable" items than this in one run are sent as a single list instead of cards.
const MAX_REVIVED_CARDS = 4;

const env = (k) => (process.env[k] || '').trim();

async function redis(cmd) {
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) throw new Error('Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Redis ${cmd[0]} failed: ${j.error || r.status}`);
  return j.result;
}

async function discord(payload) {
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set');
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) return;
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await new Promise((ok) => setTimeout(ok, Math.min(5, j.retry_after || 1) * 1000));
      continue;
    }
    throw new Error(`Discord returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error('Discord kept rate-limiting the webhook');
}

const nf = (n) => n.toLocaleString('en-US');
// Game names like "[NEW] Foo" would break Discord's [text](url) link syntax.
const md = (s) => s.replace(/[\[\]\\*_~`|]/g, '\\$&');

const TITLES = { started: '🚨 Claiming started', revived: '🔄 Still claimable', new: '✨ New drop' };
const COLORS = { started: COLOR_STARTED, revived: COLOR_REVIVED, new: COLOR_NEW };

// `e` is an event: { kind, item, moved?, lastMoved? } (moved = copies claimed since last check).
function embed(e) {
  const { item, kind } = e;
  const claimed = item.t - item.r;
  const catalog = `https://www.roblox.com/catalog/${item.i}/`;
  const game = item.gi ? `https://www.roblox.com/games/${item.gi}` : '';
  const status = kind === 'started'
    ? `🟢 **Claiming is open** — ${nf(claimed)} claimed so far`
    : kind === 'revived'
      ? `🟢 **Stock is moving** — ${nf(e.moved)} claimed since the last check` +
        (e.lastMoved ? ` (quiet since <t:${e.lastMoved}:R>)` : '')
      : item.r === item.t
        ? '⏳ Not claimable yet — you\'ll get another ping when the count starts moving'
        : `🟢 Already claiming — ${nf(claimed)} claimed`;
  return {
    title: `${TITLES[kind]}: ${item.n}`.slice(0, 256),
    url: catalog,
    color: COLORS[kind],
    description: [
      status,
      game ? `🎮 **[${md(item.g || 'Open game')}](${game})**` : '🎮 No game listed',
      `[View on Roblox catalog](${catalog})`,
    ].join('\n'),
    fields: [
      { name: 'Copies left', value: `${nf(item.r)} / ${nf(item.t)}`, inline: true },
      { name: 'Added', value: `<t:${item.a}:R>`, inline: true },
    ],
    thumbnail: item.th ? { url: item.th } : undefined,
    timestamp: new Date().toISOString(),
  };
}

// One compact embed listing many still-claimable items (Discord caps a description at 4096 chars).
function revivedList(events) {
  const lines = [];
  let len = 0;
  for (const { item, moved } of events) {
    const game = item.gi ? ` · [${md(item.g || 'game')}](https://www.roblox.com/games/${item.gi})` : '';
    const line = `• **[${md(item.n)}](https://www.roblox.com/catalog/${item.i}/)** — ` +
      `${nf(item.r)}/${nf(item.t)} left, ${nf(moved)} claimed since last check${game}`;
    if (len + line.length > 3900) { lines.push(`…and ${events.length - lines.length} more`); break; }
    lines.push(line);
    len += line.length + 1;
  }
  return {
    title: `🔄 ${events.length} older items are still claimable`,
    color: COLOR_REVIVED,
    description: lines.join('\n'),
    timestamp: new Date().toISOString(),
  };
}

// Discord allows 10 embeds per message; the time-critical kinds go first and carry the mention.
async function send(events) {
  const mention = env('DISCORD_MENTION');
  const of = (k) => events.filter((e) => e.kind === k);
  const revived = of('revived');
  const groups = [
    [of('started').map(embed), true],
    [revived.length > MAX_REVIVED_CARDS ? [revivedList(revived)] : revived.map(embed), true],
    [of('new').map(embed), false],
  ];
  for (const [embeds, withMention] of groups) {
    for (let i = 0; i < embeds.length; i += 10) {
      await discord({
        content: withMention && mention && i === 0 ? mention : undefined,
        embeds: embeds.slice(i, i + 10),
        allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
      });
    }
  }
}

async function loadState() {
  const raw = await redis(['GET', STATE_KEY]);
  if (raw) return JSON.parse(raw);
  // Upgrade from v1: keep the stock numbers, but no movement has been seen yet.
  const legacy = await redis(['GET', LEGACY_KEY]);
  if (!legacy) return null;
  const old = JSON.parse(legacy);
  return { ts: old.ts, items: Object.fromEntries(Object.entries(old.items).map(([id, r]) => [id, [r, 0]])) };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = env('WATCH_SECRET');
  const given = (req.query && req.query.key) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || given !== secret) return res.status(401).json({ error: 'bad or missing key' });

  try {
    const minTotal = Number(env('MIN_TOTAL')) || 500;
    const idle = (Number(env('IDLE_HOURS')) || 12) * 3600;
    const now = Math.floor(Date.now() / 1000);
    const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
    const items = (await fetchItems(yearStart)).filter((it) => it.t >= minTotal);

    if (req.query.test) {
      const sample = items.find((it) => it.r < it.t) || items[0];
      if (!sample) return res.status(200).json({ ok: true, note: 'no items to use as a sample' });
      await discord({ content: '🧪 Test alert from Free Limiteds Board', embeds: [embed({ kind: 'started', item: sample })] });
      return res.status(200).json({ ok: true, sent: 'test', item: sample.n });
    }

    const prev = await loadState();
    const next = { ts: now, items: {} };

    const events = [];
    for (const it of items) {
      const [was, lastMoved] = (prev && prev.items[it.i]) || [undefined, 0];
      const moved = was === undefined ? 0 : was - it.r;
      next.items[it.i] = [it.r, moved > 0 ? now : lastMoved];
      if (!prev) continue;
      if (was === undefined) {
        // Only brand-new additions; not old items that crossed MIN_TOTAL or came back into stock.
        if (it.a >= prev.ts - 3600) events.push({ kind: 'new', item: it });
      } else if (moved > 0 && was >= it.t) {
        events.push({ kind: 'started', item: it });
      } else if (moved > 0 && (!lastMoved || now - lastMoved >= idle)) {
        events.push({ kind: 'revived', item: it, moved, lastMoved });
      }
    }

    const waiting = items.filter((it) => it.r === it.t).length;
    const summary = {
      ok: true,
      tracked: items.length,
      waiting,
      firstRun: !prev,
      started: events.filter((e) => e.kind === 'started').map((e) => e.item.n),
      stillClaimable: events.filter((e) => e.kind === 'revived').map((e) => e.item.n),
      new: events.filter((e) => e.kind === 'new').map((e) => e.item.n),
    };
    if (req.query.dry) return res.status(200).json({ ...summary, dry: true });

    if (!prev) {
      await discord({
        content: `👀 Watcher online — tracking **${items.length}** free limiteds from this year with ${nf(minTotal)}+ copies ` +
          `(**${waiting}** not claimable yet). You'll be pinged when one starts moving, an older one is ` +
          'still being claimed, or a new one drops.',
      });
    } else if (events.length) {
      await send(events);
    }
    // Save only after Discord accepted everything, so a failed post is retried next run.
    await redis(['SET', STATE_KEY, JSON.stringify(next)]);
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
