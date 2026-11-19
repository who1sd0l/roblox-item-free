import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractScheduleEntries,
  isUpcomingVisible,
  linksFromMarkdown,
  mergeSchedule,
  parseScheduledTime,
  scheduleEvents,
  snowflakeDate,
} from '../api/_lib/x-schedule.js';

test('extracts expanded markdown links and a snowflake timestamp', () => {
  const links = linksFromMarkdown('[item](https://t.co/a "https://www.roblox.com/catalog/123/Test")');
  assert.deepEqual(links, ['https://www.roblox.com/catalog/123/Test']);
  assert.equal(snowflakeDate('2120363414086123856'), '2026-11-11T03:50:07.022Z');
});

test('understands relative EST announcements', () => {
  const parsed = parseScheduledTime('dropping tmr at 5:30PM EST', '2026-11-11T03:50:07.022Z');
  assert.deepEqual(parsed, { iso: '2026-11-11T22:30:00.000Z', timezone: 'EST' });
});

test('understands ordinal ET dates used in quote posts', () => {
  const parsed = parseScheduledTime('releasing on the 11th at 5PM ET', '2026-11-09T12:00:00.000Z');
  assert.deepEqual(parsed, { iso: '2026-11-11T22:00:00.000Z', timezone: 'ET' });
});

test('turns a trusted post into a structured drop', () => {
  const [drop] = extractScheduleEntries({
    id: '2120363414086123856', key: 'id:2120363414086123856', username: 'itznevn',
    url: 'https://x.com/itznevn/status/2120363414086123856',
    text: 'Dropping a 100 stock code tmr at 5:30PM EST. Redeem for points on Kick.',
    createdAt: '2026-11-11T03:50:07.022Z', image: null,
    links: ['https://www.roblox.com/catalog/138954050463584', 'https://www.roblox.com/games/136656968143195'],
  });
  assert.equal(drop.itemId, '138954050463584');
  assert.equal(drop.expectedStock, 100);
  assert.equal(drop.method, 'Kick points');
  assert.equal(drop.gameUrls.length, 1);
  assert.equal(drop.scheduledAt, '2026-11-11T22:30:00.000Z');
});

test('recognizes join-claim and Spanish stock formats', () => {
  const [join] = extractScheduleEntries({
    key: 'join', username: 'xh0plugc', url: 'https://x.com/xh0plugc', createdAt: '2026-11-11T12:00:00Z',
    text: 'Join Claim 📦Stock: 1,159', links: ['https://www.roblox.com/catalog/78072846888660'],
  });
  assert.equal(join.method, 'Join & claim');
  assert.equal(join.expectedStock, 1159);
  const [spanish] = extractScheduleEntries({
    key: 'es', username: 'ugcnoticias_', url: 'https://x.com/UgcNoticias_', createdAt: '2026-11-11T12:00:00Z',
    text: 'Nuevo Limited Gratis. Stock: 3500. Misión: Invita a 10 amigos.',
    links: ['https://www.roblox.com/catalog/78072846888660'],
  });
  assert.equal(spanish.method, 'Quest');
  assert.equal(spanish.expectedStock, 3500);
});

test('future catalog stock stays upcoming until its announced release time', () => {
  const post = {
    id: '2120363414086123856', key: 'id:2120363414086123856', username: 'itznevn',
    url: 'https://x.com/itznevn/status/2120363414086123856', text: 'Free UGC dropping tmr at 5PM EST.',
    createdAt: '2026-11-11T03:50:07.022Z', image: null,
    links: ['https://www.roblox.com/catalog/123'],
  };
  const before = mergeSchedule(null, [post], new Map(), Date.parse('2026-11-11T20:00:00Z'));
  const catalog = new Map([['123', { n: 'Test item', r: 50, t: 100, off: false, price: 0 }]]);
  const staged = mergeSchedule(before, [post], catalog, Date.parse('2026-11-11T20:05:00Z'));
  assert.equal(staged.items[0].status, 'upcoming');
  assert.equal(staged.items[0].title, 'Test item');
  assert.deepEqual(scheduleEvents(before, staged, Date.parse('2026-11-11T20:05:00Z')), []);

  const live = mergeSchedule(staged, [post], catalog, Date.parse('2026-11-11T22:01:00Z'));
  assert.equal(live.items[0].status, 'live');
  assert.equal(live.items[0].liveSince, '2026-11-11T22:00:00.000Z');
  assert.deepEqual(scheduleEvents(staged, live, Date.parse('2026-11-11T22:01:00Z')).map((event) => event.kind), ['live']);
});

test('combines duplicate event posts into one card with multiple sources', () => {
  const common = {
    createdAt: '2026-11-12T03:00:00.000Z', image: null,
    links: ['https://www.roblox.com/games/126259681759948/Gabbys-Dollhouse'],
  };
  const result = mergeSchedule(null, [
    { ...common, key: 'one', username: 'itznevn', url: 'https://x.com/itznevn/status/1', text: 'Free UGC will be available Friday at 10:30AM EST.' },
    { ...common, key: 'two', username: 'xh0plugc', url: 'https://x.com/xh0plugc/status/2', text: 'Free UGC dropping Friday at 10:30AM EST.' },
  ], new Map(), Date.parse('2026-11-12T04:00:00.000Z'));
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].sources.map((source) => source.username).sort(), ['itznevn', 'xh0plugc']);
});

test('combines mirrored relative-time posts even when their parsed dates differ', () => {
  const common = {
    username: 'ugcnoticias_', image: null,
    text: '@ArchUGC will be dropping a 100 stock UGC tmr at 3PM EST',
    links: ['https://www.roblox.com/games/86073223609175'],
  };
  const result = mergeSchedule(null, [
    { ...common, key: 'one', url: 'https://x.com/UgcNoticias_/status/1', createdAt: '2026-11-14T04:50:00.000Z' },
    { ...common, key: 'two', url: 'https://x.com/UgcNoticias_/status/2', createdAt: '2026-11-14T15:50:00.000Z' },
  ], new Map(), Date.parse('2026-11-14T16:00:00.000Z'));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].scheduledAt, '2026-11-15T20:00:00.000Z');
  assert.equal(result.items[0].sourceUrl, 'https://x.com/UgcNoticias_/status/2');
});

test('combines shortened untimed announcements for the same game', () => {
  const common = {
    username: 'xh0plugc', image: null, createdAt: '2026-11-18T12:00:00.000Z',
    links: ['https://www.roblox.com/games/126259681759948/Turkey-Leg-Hunt'],
  };
  const result = mergeSchedule(null, [
    { ...common, key: 'long', url: 'https://x.com/xh0plugc/status/1', text: 'Turkey Leg Hunt free UGC event. Collect ten turkeys to claim the reward.' },
    { ...common, key: 'short', url: 'https://x.com/xh0plugc/status/2', text: 'Turkey Leg Hunt free UGC event.' },
  ], new Map(), Date.parse('2026-11-18T13:00:00.000Z'));
  assert.equal(result.items.length, 1);
});

test('keeps distinct timed drops for the same game separate', () => {
  const common = {
    username: 'itznevn', image: null, createdAt: '2026-11-19T12:00:00.000Z',
    links: ['https://www.roblox.com/games/86073223609175'],
  };
  const result = mergeSchedule(null, [
    { ...common, key: 'one', url: 'https://x.com/itznevn/status/1', text: '50 stock free UGC dropping today at 3PM EST.' },
    { ...common, key: 'two', url: 'https://x.com/itznevn/status/2', text: '100 stock free UGC dropping today at 9PM EST.' },
  ], new Map(), Date.parse('2026-11-19T13:00:00.000Z'));
  assert.equal(result.items.length, 2);
});

test('folds a game-only announcement into its matching verified item card', () => {
  const common = {
    createdAt: '2026-11-12T03:00:00.000Z', image: null,
    links: ['https://www.roblox.com/games/126259681759948/Gabbys-Dollhouse'],
  };
  const result = mergeSchedule(null, [
    {
      ...common, key: 'item', username: 'itznevn', url: 'https://x.com/itznevn/status/1',
      text: 'Doozie Dog Ears free UGC restocks Friday at 10:30AM EST.',
      links: [...common.links, 'https://www.roblox.com/catalog/137813364366385/Doozie-Dog-Ears'],
    },
    {
      ...common, key: 'event', username: 'xh0plugc', url: 'https://x.com/xh0plugc/status/2',
      text: 'Gabby has posted an event. Obtain this free UGC Friday at 10:30AM EST.',
    },
  ], new Map([['137813364366385', { n: 'Doozie Dog Ears', r: 0, t: 5000, off: false, price: 0 }]]), Date.parse('2026-11-12T04:00:00.000Z'));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].itemId, '137813364366385');
  assert.deepEqual(result.items[0].sources.map((source) => source.username).sort(), ['itznevn', 'xh0plugc']);
});

test('upcoming board removes claimed, finished, and ten-minute-old live items', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  assert.equal(isUpcomingVisible({ status: 'upcoming' }, now), true);
  assert.equal(isUpcomingVisible({ status: 'ended' }, now), false);
  assert.equal(isUpcomingVisible({ status: 'cancelled' }, now), false);
  assert.equal(isUpcomingVisible({ status: 'live', currentStock: null, totalStock: 100, liveSince: '2026-11-13T11:51:00.000Z' }, now), true);
  assert.equal(isUpcomingVisible({ status: 'live', currentStock: 99, totalStock: 100, liveSince: '2026-11-13T11:59:00.000Z' }, now), false);
  assert.equal(isUpcomingVisible({ status: 'live', currentStock: 100, totalStock: 100, liveSince: '2026-11-13T11:51:00.000Z' }, now), true);
  assert.equal(isUpcomingVisible({ status: 'live', currentStock: 100, totalStock: 100, liveSince: '2026-11-13T11:50:00.000Z' }, now), false);
  assert.equal(isUpcomingVisible({ status: 'delayed', scheduledAt: '2026-11-13T07:01:00.000Z' }, now), true);
  assert.equal(isUpcomingVisible({ status: 'delayed', scheduledAt: '2026-11-13T06:00:00.000Z' }, now), false);
});

test('excludes drops that Roblox confirms are paid', () => {
  const post = {
    id: '2120363414086123856', key: 'id:2120363414086123856', username: 'itznevn',
    url: 'https://x.com/itznevn/status/2120363414086123856', text: 'A UGC item is dropping tomorrow at 5PM EST.',
    createdAt: '2026-11-11T03:50:07.022Z', image: null,
    links: ['https://www.roblox.com/catalog/456'],
  };
  const result = mergeSchedule(null, [post], new Map([['456', { n: 'Paid', r: 10, t: 10, off: false, price: 75 }]]));
  assert.equal(result.items.length, 0);
});

test('a changed release time can receive a new starting-soon reminder', () => {
  const previous = {
    items: [{
      id: 'item:123', itemId: '123', username: 'itznevn', sourceUrl: 'https://x.com/itznevn/status/1',
      createdAt: '2026-11-11T12:00:00.000Z', scheduledAt: '2026-11-11T22:00:00.000Z',
      reminders: { soon: '2026-11-11T21:45:00.000Z' }, status: 'upcoming',
    }],
  };
  const changed = mergeSchedule(previous, [{
    id: '2120363414086123856', key: 'id:2120363414086123856', username: 'itznevn',
    url: 'https://x.com/itznevn/status/2120363414086123856',
    text: 'Free UGC moved to tomorrow at 7PM EST.', createdAt: '2026-11-12T12:00:00.000Z',
    links: ['https://www.roblox.com/catalog/123'],
  }], new Map(), Date.parse('2026-11-12T12:00:00.000Z'));
  assert.equal(changed.items[0].scheduledAt, '2026-11-14T00:00:00.000Z');
  assert.equal(changed.items[0].reminders.soon, undefined);
});
