// Phone alerts (via ntfy) for big free limiteds. Hit this every minute from an external cron
// (cron-job.org): GET /api/watch?key=WATCH_SECRET
//
// Each run compares Rolimon's numbers with the previous run (kept in Upstash Redis) and sends:
//   - "Claiming started"  an item that sat untouched (copies left = total) has started moving (urgent)
//   - "New drop"          an item that wasn't there last run
// Only items with at least MIN_TOTAL total copies are tracked.
//
// Env: NTFY_TOPIC, WATCH_SECRET, KV_REST_API_URL + KV_REST_API_TOKEN
//      (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), optional MIN_TOTAL (default 500),
//      optional NTFY_SERVER (default https://ntfy.sh) and NTFY_TOKEN for a protected topic.
// Query: ?test=1 sends a sample alert; ?dry=1 reports what would be sent without sending or saving.

import { fetchItems } from './_lib/rolimons.js';

const STATE_KEY = 'flb:watch:v1';
const TRACK_DAYS = 60;
// More new drops than this in one run get bundled into a single summary notification.
const MAX_SINGLE_NEW = 3;

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

async function ntfy(msg) {
  const topic = env('NTFY_TOPIC');
  if (!topic) throw new Error('NTFY_TOPIC is not set');
  const headers = { 'content-type': 'application/json' };
  if (env('NTFY_TOKEN')) headers.authorization = `Bearer ${env('NTFY_TOKEN')}`;
  const r = await fetch((env('NTFY_SERVER') || 'https://ntfy.sh').replace(/\/+$/, '') + '/', {
    method: 'POST',
    headers,
    body: JSON.stringify({ topic, ...msg }),
  });
  if (!r.ok) throw new Error(`ntfy returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

const nf = (n) => n.toLocaleString('en-US');
const png = (thumb) => (thumb || '').replace('/Webp/', '/Png/');

function ago(unix) {
  const s = Date.now() / 1000 - unix;
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago`
    : s < 86400 ? `${Math.round(s / 3600)}h ago`
    : `${Math.round(s / 86400)}d ago`;
}

function alert(item, kind) {
  const catalog = `https://www.roblox.com/catalog/${item.i}/`;
  const game = item.gi ? `https://www.roblox.com/games/${item.gi}` : '';
  const claimed = item.t - item.r;
  const status = kind === 'started'
    ? `Claiming is open — ${nf(claimed)} claimed so far`
    : item.r === item.t
      ? 'Not claimable yet — you\'ll get an urgent alert when it starts'
      : `Already claiming — ${nf(claimed)} claimed`;
  return {
    title: kind === 'started' ? `🚨 Claim now: ${item.n}` : `✨ New drop: ${item.n}`,
    message: [
      status,
      `${nf(item.r)} / ${nf(item.t)} left · added ${ago(item.a)}`,
      item.g ? `Game: ${item.g}` : 'No game listed',
    ].join('\n'),
    priority: kind === 'started' ? 5 : 3,
    tags: kind === 'started' ? ['rotating_light'] : ['sparkles'],
    click: game || catalog,
    attach: item.th ? png(item.th) : undefined,
    actions: [
      game && { action: 'view', label: 'Open game', url: game, clear: true },
      { action: 'view', label: 'Catalog', url: catalog },
    ].filter(Boolean),
  };
}

// Claim-started alerts go out one by one (they're the time-critical ones); a burst of new drops
// becomes one summary so the phone isn't flooded.
async function send(events, siteUrl) {
  for (const e of events.filter((e) => e.kind === 'started')) await ntfy(alert(e.item, 'started'));
  const fresh = events.filter((e) => e.kind === 'new').map((e) => e.item);
  if (fresh.length <= MAX_SINGLE_NEW) {
    for (const it of fresh) await ntfy(alert(it, 'new'));
  } else {
    const waiting = fresh.filter((it) => it.r === it.t).length;
    await ntfy({
      title: `✨ ${fresh.length} new drops`,
      message: fresh.slice(0, 12).map((it) => `• ${it.n} — ${nf(it.r)}/${nf(it.t)}`).join('\n') +
        (fresh.length > 12 ? `\n…and ${fresh.length - 12} more` : '') +
        (waiting ? `\n\n${waiting} not claimable yet — you'll get an urgent alert when they start.` : ''),
      priority: 3,
      tags: ['sparkles'],
      click: siteUrl,
    });
  }
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = env('WATCH_SECRET');
  const given = (req.query && req.query.key) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || given !== secret) return res.status(401).json({ error: 'bad or missing key' });

  try {
    const minTotal = Number(env('MIN_TOTAL')) || 500;
    const siteUrl = req.headers.host ? `https://${req.headers.host}/` : undefined;
    const now = Math.floor(Date.now() / 1000);
    const items = (await fetchItems(now - TRACK_DAYS * 86400)).filter((it) => it.t >= minTotal);

    if (req.query.test) {
      const sample = items.find((it) => it.r < it.t) || items[0];
      if (!sample) return res.status(200).json({ ok: true, note: 'no items to use as a sample' });
      const msg = alert(sample, 'started');
      await ntfy({ ...msg, title: `🧪 Test — ${msg.title}` });
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
      await ntfy({
        title: '👀 Watcher online',
        message: `Tracking ${items.length} free limiteds with ${nf(minTotal)}+ copies, ${waiting} not claimable yet. ` +
          'You\'ll get an urgent alert when one starts moving.',
        tags: ['eyes'],
        click: siteUrl,
      });
    } else if (events.length) {
      await send(events, siteUrl);
    }
    // Save only after ntfy accepted everything, so a failed send is retried next run.
    await redis(['SET', STATE_KEY, JSON.stringify(next)]);
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
