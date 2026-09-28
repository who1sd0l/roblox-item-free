// Discord alerts for big free limiteds. Hit this every minute from an external cron
// (cron-job.org): GET /api/watch?key=WATCH_SECRET
//
// Each run compares Rolimon's numbers with the previous run (kept in Upstash Redis) and posts:
//   - "Claiming started"  an item that sat untouched (copies left = total) has started moving
//   - "New drop"          an item that wasn't there last run
// Only items with at least MIN_TOTAL total copies are tracked.
//
// Env: DISCORD_WEBHOOK_URL, WATCH_SECRET, KV_REST_API_URL + KV_REST_API_TOKEN
//      (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), optional MIN_TOTAL (default 500),
//      optional DISCORD_MENTION (e.g. "@everyone" or "<@&roleId>") prepended to claim-started pings.
// Query: ?test=1 sends a sample alert; ?dry=1 reports what would be sent without sending or saving.

import { fetchItems } from './_lib/rolimons.js';

const STATE_KEY = 'flb:watch:v1';
const TRACK_DAYS = 60;
const COLOR_STARTED = 0x22c55e;
const COLOR_NEW = 0x7c5cff;

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

function embed(item, kind) {
  const claimed = item.t - item.r;
  const catalog = `https://www.roblox.com/catalog/${item.i}/`;
  const game = item.gi ? `https://www.roblox.com/games/${item.gi}` : '';
  const status = kind === 'started'
    ? `🟢 **Claiming is open** — ${nf(claimed)} claimed so far`
    : item.r === item.t
      ? '⏳ Not claimable yet — you\'ll get another ping when the count starts moving'
      : `🟢 Already claiming — ${nf(claimed)} claimed`;
  return {
    title: `${kind === 'started' ? '🚨 Claiming started' : '✨ New drop'}: ${item.n}`.slice(0, 256),
    url: catalog,
    color: kind === 'started' ? COLOR_STARTED : COLOR_NEW,
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

// Discord allows 10 embeds per message; claim-started first since those are time-critical.
async function send(events) {
  const mention = env('DISCORD_MENTION');
  const started = events.filter((e) => e.kind === 'started');
  const fresh = events.filter((e) => e.kind === 'new');
  for (const [group, withMention] of [[started, true], [fresh, false]]) {
    for (let i = 0; i < group.length; i += 10) {
      const chunk = group.slice(i, i + 10);
      await discord({
        content: withMention && mention && i === 0 ? mention : undefined,
        embeds: chunk.map((e) => embed(e.item, e.kind)),
        allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
      });
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = env('WATCH_SECRET');
  const given = (req.query && req.query.key) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || given !== secret) return res.status(401).json({ error: 'bad or missing key' });

  try {
    const minTotal = Number(env('MIN_TOTAL')) || 500;
    const now = Math.floor(Date.now() / 1000);
    const items = (await fetchItems(now - TRACK_DAYS * 86400)).filter((it) => it.t >= minTotal);

    if (req.query.test) {
      const sample = items.find((it) => it.r < it.t) || items[0];
      if (!sample) return res.status(200).json({ ok: true, note: 'no items to use as a sample' });
      await discord({ content: '🧪 Test alert from Free Limiteds Board', embeds: [embed(sample, 'started')] });
      return res.status(200).json({ ok: true, sent: 'test', item: sample.n });
    }

    const raw = await redis(['GET', STATE_KEY]);
    const prev = raw ? JSON.parse(raw) : null;
    const next = { ts: now, items: Object.fromEntries(items.map((it) => [it.i, it.r])) };

    const events = [];
    if (prev) {
      for (const it of items) {
        const was = prev.items[it.i];
        if (was === undefined) {
          // Only brand-new additions; not old items that crossed MIN_TOTAL or came back into range.
          if (it.a >= prev.ts - 3600) events.push({ kind: 'new', item: it });
        } else if (was >= it.t && it.r < it.t) {
          events.push({ kind: 'started', item: it });
        }
      }
    }

    const waiting = items.filter((it) => it.r === it.t).length;
    const summary = {
      ok: true,
      tracked: items.length,
      waiting,
      firstRun: !prev,
      started: events.filter((e) => e.kind === 'started').map((e) => e.item.n),
      new: events.filter((e) => e.kind === 'new').map((e) => e.item.n),
    };
    if (req.query.dry) return res.status(200).json({ ...summary, dry: true });

    if (!prev) {
      await discord({
        content: `👀 Watcher online — tracking **${items.length}** free limiteds with ${nf(minTotal)}+ copies, ` +
          `**${waiting}** not claimable yet. You'll be pinged when one starts moving or a new one drops.`,
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
