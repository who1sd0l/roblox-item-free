import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractScheduleEntries,
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

test('verifies live stock and creates one transition alert', () => {
  const post = {
    id: '2120363414086123856', key: 'id:2120363414086123856', username: 'itznevn',
    url: 'https://x.com/itznevn/status/2120363414086123856', text: 'Free UGC dropping tmr at 5PM EST.',
    createdAt: '2026-11-11T03:50:07.022Z', image: null,
    links: ['https://www.roblox.com/catalog/123'],
  };
  const before = mergeSchedule(null, [post], new Map(), Date.parse('2026-11-11T20:00:00Z'));
  const live = mergeSchedule(before, [post], new Map([['123', { n: 'Test item', r: 50, t: 100, off: false, price: 0 }]]), Date.parse('2026-11-11T20:05:00Z'));
  assert.equal(live.items[0].status, 'live');
  assert.equal(live.items[0].title, 'Test item');
  assert.deepEqual(scheduleEvents(before, live, Date.parse('2026-11-11T20:05:00Z')).map((event) => event.kind), ['live']);
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
