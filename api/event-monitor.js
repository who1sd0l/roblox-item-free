// Public event feed plus secret-protected add/remove controls for monitored Roblox games.

import { redis, EVENT_MONITOR_KEY } from './_lib/redis.js';
import {
  MAX_MONITORED_GAMES,
  baselineEvents,
  fetchMonitoredEvents,
  parseGamePlaceId,
  parseEventState,
  publicEventState,
  resolveMonitoredGame,
} from './_lib/event-monitor.js';

const env = (key) => (process.env[key] || '').trim();

function authorized(req) {
  const secret = env('EVENT_WATCH_SECRET') || env('X_WATCH_SECRET') || env('WATCH_SECRET');
  const given = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim()
    || String(req.query?.key || '').trim();
  return Boolean(secret && given === secret);
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(String(req.body || '{}')); } catch { return {}; }
}

async function readState() {
  return parseEventState(await redis(['GET', EVENT_MONITOR_KEY]));
}

async function saveState(state) {
  await redis(['SET', EVENT_MONITOR_KEY, JSON.stringify(state)]);
}

export default async function handler(req, res) {
  const method = req.method || 'GET';
  res.setHeader('allow', 'GET, POST, DELETE');
  try {
    if (method === 'GET') {
      const raw = await redis(['GET', EVENT_MONITOR_KEY]);
      const state = parseEventState(raw);
      res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
      return res.status(200).json({ ...publicEventState(state), ready: Boolean(raw) });
    }
    res.setHeader('cache-control', 'no-store');
    if (!['POST', 'DELETE'].includes(method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!authorized(req)) return res.status(401).json({ error: 'Bad or missing watcher secret' });

    const body = bodyOf(req);
    const state = await readState();
    if (method === 'POST') {
      const input = body.url || body.game || '';
      if (!parseGamePlaceId(input)) return res.status(400).json({ error: 'Paste a valid https://www.roblox.com/games/... URL' });
      if (state.games.length >= MAX_MONITORED_GAMES) return res.status(409).json({ error: `You can monitor up to ${MAX_MONITORED_GAMES} games` });
      const game = await resolveMonitoredGame(input);
      if (state.games.some((item) => item.universeId === game.universeId)) return res.status(409).json({ error: 'That game is already monitored' });
      const events = await fetchMonitoredEvents(game);
      state.games.push(game);
      const next = baselineEvents(state, game, events);
      next.updatedAt = new Date().toISOString();
      next.failed = [];
      await saveState(next);
      return res.status(201).json({ ...publicEventState(next), added: game, baselineEvents: events.length });
    }

    const placeId = String(body.placeId || req.query?.placeId || '').trim();
    const game = state.games.find((item) => item.placeId === placeId);
    if (!game) return res.status(404).json({ error: 'Monitored game not found' });
    const removedEventIds = new Set(state.events.filter((event) => event.universeId === game.universeId).map((event) => event.id));
    state.games = state.games.filter((item) => item.universeId !== game.universeId);
    state.events = state.events.filter((event) => event.universeId !== game.universeId);
    for (const eventId of removedEventIds) delete state.alerts[eventId];
    state.updatedAt = new Date().toISOString();
    await saveState(state);
    return res.status(200).json({ ...publicEventState(state), removed: game });
  } catch (error) {
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json({ error: error.message || 'Event monitor unavailable' });
  }
}
