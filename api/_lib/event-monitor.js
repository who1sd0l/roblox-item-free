// Public Roblox virtual-event helpers for the user-selected game monitor.
// No Roblox login or cookie is used. All creator-controlled text is normalized and length-capped.

const EVENT_API = 'https://apis.roblox.com/virtual-events/v1';
const UNIVERSE_API = 'https://apis.roblox.com/universes/v1/places';
const GAMES_API = 'https://games.roblox.com/v1/games';
const THUMBS_API = 'https://thumbnails.roblox.com/v1/games/icons';
const EVENT_HORIZON = 60 * 86400000;
export const MAX_MONITORED_GAMES = 20;

const id = (value) => /^\d{1,20}$/.test(String(value || '')) && String(value) !== '0' ? String(value) : null;
const unique = (values) => [...new Set(values.filter(Boolean))];

export function cleanEventText(value, limit) {
  const clean = String(value || '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b\ufeff]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

export function parseGamePlaceId(value) {
  const raw = String(value || '').trim();
  if (/^\d{1,20}$/.test(raw) && raw !== '0') return raw;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !/^(?:www\.)?roblox\.com$/i.test(url.hostname)) return null;
  return url.pathname.match(/^\/(?:[a-z]{2}\/)?games\/(\d{1,20})(?:\/|$)/i)?.[1] || null;
}

async function fetchJson(url, { timeout = 10000, attempts = 3 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'Free-Limiteds-Event-Monitor/1.0' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`Roblox returned HTTP ${response.status}`);
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
      }
      if (!response.ok) throw new Error(`Roblox returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      last = error.name === 'AbortError' ? new Error('Roblox request timed out') : error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error('Roblox request failed');
}

function safeIcon(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname.endsWith('.rbxcdn.com') && !url.username ? url.href : null;
  } catch { return null; }
}

export async function resolveMonitoredGame(input) {
  const placeId = parseGamePlaceId(input);
  if (!placeId) throw new Error('Paste a Roblox game URL such as https://www.roblox.com/games/123/Game');
  const universe = await fetchJson(`${UNIVERSE_API}/${placeId}/universe`);
  const universeId = id(universe?.universeId);
  if (!universeId) throw new Error('Roblox could not resolve that game');
  const [details, thumbs] = await Promise.all([
    fetchJson(`${GAMES_API}?universeIds=${universeId}`),
    fetchJson(`${THUMBS_API}?universeIds=${universeId}&size=150x150&format=Webp&isCircular=false`, { attempts: 2 }).catch(() => ({ data: [] })),
  ]);
  const game = details?.data?.find((item) => id(item.id) === universeId);
  if (!game || !id(game.rootPlaceId)) throw new Error('Roblox returned no public game details');
  const thumb = thumbs?.data?.find((item) => id(item.targetId) === universeId && item.state === 'Completed');
  return {
    placeId: String(game.rootPlaceId),
    universeId,
    name: cleanEventText(game.name, 100) || 'Untitled game',
    creator: cleanEventText(game.creator?.name, 80),
    verified: Boolean(game.creator?.hasVerifiedBadge),
    icon: safeIcon(thumb?.imageUrl),
    addedAt: new Date().toISOString(),
  };
}

function iso(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function normalizeRobloxEvent(raw, game, now = Date.now()) {
  const eventId = id(raw?.id);
  const universeId = id(raw?.universeId);
  const placeId = id(raw?.placeId) || game?.placeId;
  const start = iso(raw?.eventTime?.startUtc);
  const end = iso(raw?.eventTime?.endUtc);
  if (!eventId || universeId !== String(game?.universeId) || !placeId || !start || !end) return null;
  const startMs = Date.parse(start), endMs = Date.parse(end);
  if (endMs <= now || startMs > now + EVENT_HORIZON || endMs < startMs) return null;
  if (String(raw.eventStatus || 'active').toLowerCase() !== 'active') return null;
  if (String(raw.eventVisibility || 'public').toLowerCase() !== 'public') return null;
  const categories = unique((raw.eventCategories || []).map((entry) => {
    const value = typeof entry === 'object' ? entry?.category : null;
    return /^[A-Za-z]{1,40}$/.test(String(value || '')) ? value : null;
  })).slice(0, 4);
  const title = cleanEventText(raw.displayTitle || raw.title, 120) || 'Untitled event';
  const subtitle = cleanEventText(raw.displaySubtitle || raw.subtitle, 160);
  const description = cleanEventText(raw.displayDescription || raw.description, 600);
  const ugc = /\bugcs?\b|free\s+(?:limited|item|hat|accessor|cosmetic)|\blimiteds\b|item\s+drop/i.test(`${title}\n${subtitle}\n${description}`)
    || categories.includes('itemDrop');
  return { id: eventId, universeId, placeId, title, subtitle, description, start, end, categories, ugc };
}

export async function fetchMonitoredEvents(game, now = Date.now()) {
  const from = new Date(now - 5 * 60000).toISOString();
  const rows = [];
  let cursor = '';
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ limit: '25', fromUtc: from });
    if (cursor) params.set('cursor', cursor);
    const data = await fetchJson(`${EVENT_API}/universes/${game.universeId}/virtual-events?${params}`);
    rows.push(...(Array.isArray(data?.data) ? data.data : []));
    cursor = String(data?.nextPageCursor || '');
    if (!cursor) break;
  }
  const used = new Set();
  return rows.map((raw) => normalizeRobloxEvent(raw, game, now)).filter((event) => {
    if (!event || used.has(event.id)) return false;
    used.add(event.id);
    return true;
  }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function emptyEventState() {
  return { games: [], events: [], alerts: {}, updatedAt: null, failed: [] };
}

export function parseEventState(raw) {
  if (!raw) return emptyEventState();
  try {
    const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      games: Array.isArray(state.games) ? state.games.slice(0, MAX_MONITORED_GAMES) : [],
      events: Array.isArray(state.events) ? state.events : [],
      alerts: state.alerts && typeof state.alerts === 'object' ? state.alerts : {},
      updatedAt: state.updatedAt || null,
      failed: Array.isArray(state.failed) ? state.failed : [],
    };
  } catch { return emptyEventState(); }
}

export function baselineEvents(state, game, events, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const kept = state.events.filter((event) => event.universeId !== game.universeId && Date.parse(event.end) > now);
  const alerts = { ...state.alerts };
  for (const event of events) {
    const start = Date.parse(event.start), end = Date.parse(event.end);
    alerts[event.id] = {
      ...(alerts[event.id] || {}), announced: stamp, lastSeen: stamp,
      soon: start <= now + 20 * 60000 ? stamp : alerts[event.id]?.soon,
      live: start <= now && end > now ? stamp : alerts[event.id]?.live,
    };
  }
  return { ...state, events: [...kept, ...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), alerts };
}

export function buildEventRun(previous, results, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const successful = new Set(results.filter((result) => !result.error).map((result) => result.game.universeId));
  const events = results.filter((result) => !result.error).flatMap((result) => result.events);
  for (const old of previous.events) {
    if (!successful.has(old.universeId) && Date.parse(old.end) > now) events.push(old);
  }
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()]
    .filter((event) => Date.parse(event.end) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const alerts = { ...previous.alerts };
  const notifications = [];
  for (const event of uniqueEvents) {
    const record = { ...(alerts[event.id] || {}), lastSeen: stamp };
    alerts[event.id] = record;
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (start <= now && end > now && !record.live) notifications.push({ kind: 'live', event });
    else if (start > now && start <= now + 20 * 60000 && !record.soon) notifications.push({ kind: 'soon', event });
    else if (!record.announced) notifications.push({ kind: 'new', event });
  }
  const cutoff = now - 90 * 86400000;
  for (const [eventId, record] of Object.entries(alerts)) {
    if (Date.parse(record.lastSeen || 0) < cutoff) delete alerts[eventId];
  }
  return {
    state: {
      games: previous.games,
      events: uniqueEvents,
      alerts,
      updatedAt: stamp,
      failed: results.filter((result) => result.error).map((result) => ({ universeId: result.game.universeId, error: result.error })),
    },
    notifications,
  };
}

export function markEventAlert(state, eventId, kind, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const record = { ...(state.alerts[eventId] || {}), lastSeen: stamp, announced: state.alerts[eventId]?.announced || stamp };
  if (kind === 'soon' || kind === 'live') record.soon = record.soon || stamp;
  if (kind === 'live') record.live = stamp;
  state.alerts[eventId] = record;
}

export function publicEventState(state) {
  return {
    ready: true,
    games: state.games.map(({ placeId, universeId, name, creator, verified, icon, addedAt }) => ({ placeId, universeId, name, creator, verified, icon, addedAt })),
    events: state.events.map(({ id: eventId, universeId, placeId, title, subtitle, description, start, end, categories, ugc }) => ({ id: eventId, universeId, placeId, title, subtitle, description, start, end, categories, ugc })),
    updatedAt: state.updatedAt,
    failed: state.failed || [],
  };
}
