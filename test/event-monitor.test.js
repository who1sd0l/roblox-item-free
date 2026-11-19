import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineEvents,
  buildEventRun,
  emptyEventState,
  markEventAlert,
  normalizeRobloxEvent,
  parseGamePlaceId,
} from '../api/_lib/event-monitor.js';

const game = { placeId: '126259681759948', universeId: '6546714281', name: 'Gabby', creator: 'Studio' };
const now = Date.parse('2026-11-19T08:00:00.000Z');

const rawEvent = (overrides = {}) => ({
  id: '123456789', universeId: game.universeId, placeId: game.placeId,
  displayTitle: 'Free UGC Event', displaySubtitle: 'New drop',
  displayDescription: 'Claim a free limited item during the event.',
  eventTime: { startUtc: '2026-11-19T10:00:00Z', endUtc: '2026-11-20T10:00:00Z' },
  eventStatus: 'active', eventVisibility: 'public',
  eventCategories: [{ category: 'itemDrop' }],
  ...overrides,
});

test('parses safe Roblox game links and numeric place ids', () => {
  assert.equal(parseGamePlaceId('126259681759948'), '126259681759948');
  assert.equal(parseGamePlaceId('https://www.roblox.com/games/126259681759948/Game?privateServerLinkCode=x'), '126259681759948');
  assert.equal(parseGamePlaceId('https://roblox.com/en/games/126259681759948/Game'), '126259681759948');
  assert.equal(parseGamePlaceId('https://example.com/games/126259681759948'), null);
  assert.equal(parseGamePlaceId('javascript:alert(1)'), null);
});

test('normalizes a public future Roblox event and detects UGC', () => {
  const event = normalizeRobloxEvent(rawEvent(), game, now);
  assert.equal(event.id, '123456789');
  assert.equal(event.title, 'Free UGC Event');
  assert.equal(event.ugc, true);
  assert.deepEqual(event.categories, ['itemDrop']);
  assert.equal(normalizeRobloxEvent(rawEvent({ eventVisibility: 'private' }), game, now), null);
  assert.equal(normalizeRobloxEvent(rawEvent({ eventTime: { startUtc: '2026-11-17T00:00:00Z', endUtc: '2026-11-18T00:00:00Z' } }), game, now), null);
});

test('adding a game baselines current events without sending old announcements', () => {
  const event = normalizeRobloxEvent(rawEvent(), game, now);
  const state = baselineEvents({ ...emptyEventState(), games: [game] }, game, [event], now);
  const run = buildEventRun(state, [{ game, events: [event], error: null }], now + 60000);
  assert.equal(run.notifications.length, 0);
  assert.ok(run.state.alerts[event.id].announced);
});

test('watcher announces new events, then sends soon and live transitions once', () => {
  const event = normalizeRobloxEvent(rawEvent(), game, now);
  const initial = { ...emptyEventState(), games: [game] };
  const discovered = buildEventRun(initial, [{ game, events: [event], error: null }], now);
  assert.deepEqual(discovered.notifications.map((item) => item.kind), ['new']);
  markEventAlert(discovered.state, event.id, 'new', now);

  const soonAt = Date.parse('2026-11-19T09:45:00Z');
  const soon = buildEventRun(discovered.state, [{ game, events: [event], error: null }], soonAt);
  assert.deepEqual(soon.notifications.map((item) => item.kind), ['soon']);
  markEventAlert(soon.state, event.id, 'soon', soonAt);

  const liveAt = Date.parse('2026-11-19T10:01:00Z');
  const live = buildEventRun(soon.state, [{ game, events: [event], error: null }], liveAt);
  assert.deepEqual(live.notifications.map((item) => item.kind), ['live']);
  markEventAlert(live.state, event.id, 'live', liveAt);
  const repeated = buildEventRun(live.state, [{ game, events: [event], error: null }], liveAt + 60000);
  assert.equal(repeated.notifications.length, 0);
});
