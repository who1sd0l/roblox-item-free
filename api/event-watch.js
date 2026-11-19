// Scheduled Roblox event checker. Call every 10 minutes from cron-job.org.
// Uses the X-specific Discord webhook so event and X alerts can share one channel.

import { redis, EVENT_MONITOR_KEY } from './_lib/redis.js';
import {
  buildEventRun,
  fetchMonitoredEvents,
  markEventAlert,
  parseEventState,
} from './_lib/event-monitor.js';

const env = (key) => (process.env[key] || '').trim();
const cut = (value, max) => String(value || '').length > max ? `${String(value).slice(0, max - 1)}…` : String(value || '');
const md = (value) => String(value || '').replace(/[\[\]\\*_~`|]/g, '\\$&');

function authorized(req) {
  const secret = env('EVENT_WATCH_SECRET') || env('X_WATCH_SECRET') || env('WATCH_SECRET');
  const given = String(req.query?.key || '').trim()
    || String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(secret && given === secret);
}

async function discord(payload) {
  const hook = env('X_DISCORD_WEBHOOK_URL') || env('DISCORD_WEBHOOK_URL');
  if (!hook) throw new Error('X_DISCORD_WEBHOOK_URL is not set');
  const url = new URL(hook);
  url.searchParams.set('wait', 'true');
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.ok) return;
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      await new Promise((resolve) => setTimeout(resolve, Math.min(5, Number(body.retry_after) || 1) * 1000));
      continue;
    }
    throw new Error(`Discord returned ${response.status}: ${cut(await response.text(), 200)}`);
  }
  throw new Error('Discord kept rate-limiting the webhook');
}

function alertPayload(kind, event, game) {
  const titles = { new: '📅 New Roblox event detected', soon: '⏰ Roblox event starting soon', live: '🟢 Roblox event is live' };
  const colors = { new: 0x5865f2, soon: 0xf59e0b, live: 0x22c55e };
  const start = Math.floor(Date.parse(event.start) / 1000);
  const end = Math.floor(Date.parse(event.end) / 1000);
  const description = [
    event.subtitle ? `*${md(cut(event.subtitle, 180))}*` : '',
    event.description ? cut(md(event.description), 900) : '',
    `**Starts:** <t:${start}:F> · <t:${start}:R>`,
    `**Ends:** <t:${end}:R>`,
    event.ugc ? '**Free UGC / item-drop signal detected**' : '',
    `**[Open event](https://www.roblox.com/events/${event.id})** · **[Play game](https://www.roblox.com/games/${event.placeId})**`,
  ].filter(Boolean).join('\n');
  const mention = env('X_DISCORD_MENTION');
  return {
    content: mention || undefined,
    embeds: [{
      title: `${titles[kind]} · ${cut(event.title, 180)}`,
      url: `https://www.roblox.com/events/${event.id}`,
      description,
      color: colors[kind],
      thumbnail: game?.icon ? { url: game.icon } : undefined,
      footer: { text: `${game?.name || 'Monitored Roblox game'}${event.ugc ? ' · UGC' : ''}` },
      timestamp: kind === 'live' ? new Date().toISOString() : event.start,
    }],
    allowed_mentions: mention ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
  };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method && req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'Bad or missing watcher secret' });
  try {
    if (req.query?.test) {
      const now = Date.now();
      await discord(alertPayload('new', {
        id: '1', placeId: '920587237', title: 'Example monitored event', subtitle: 'Discord test',
        description: 'This is a test from the Roblox event monitor.', start: new Date(now + 3600000).toISOString(),
        end: new Date(now + 7200000).toISOString(), ugc: true,
      }, { name: 'Example game', icon: null }));
      return res.status(200).json({ ok: true, sent: 'test' });
    }

    const raw = await redis(['GET', EVENT_MONITOR_KEY]);
    const previous = parseEventState(raw);
    if (!previous.games.length) return res.status(200).json({ ok: true, games: 0, events: 0, notified: 0, message: 'No games are monitored yet' });
    const now = Date.now();
    const results = await Promise.all(previous.games.map(async (game) => {
      try { return { game, events: await fetchMonitoredEvents(game, now), error: null }; }
      catch (error) { return { game, events: [], error: error.message }; }
    }));
    const { state, notifications } = buildEventRun(previous, results, now);
    const games = new Map(state.games.map((game) => [game.universeId, game]));
    const sent = [];
    const sendFailed = [];
    if (!req.query?.dry) {
      for (const notification of notifications) {
        try {
          await discord(alertPayload(notification.kind, notification.event, games.get(notification.event.universeId)));
          markEventAlert(state, notification.event.id, notification.kind, now);
          sent.push(notification);
        } catch (error) {
          sendFailed.push({ kind: notification.kind, id: notification.event.id, error: error.message });
        }
      }
      await redis(['SET', EVENT_MONITOR_KEY, JSON.stringify(state)]);
    }
    return res.status(200).json({
      ok: true,
      dry: Boolean(req.query?.dry),
      games: state.games.length,
      events: state.events.length,
      notified: req.query?.dry ? 0 : sent.length,
      detected: notifications.length,
      alerts: notifications.map(({ kind, event }) => ({ kind, id: event.id, title: event.title, start: event.start })),
      failed: state.failed,
      sendFailed,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Event watcher failed' });
  }
}
