// Turn trusted public X posts into structured upcoming-drop records.
// This is intentionally conservative: a post needs UGC/drop language plus a Roblox item or game link.

const X_EPOCH = 1288834974657n;
const DAY = 86400000;
const KEEP_MS = 21 * DAY;

const TZ = {
  ET: 'America/New_York', EST: 'Etc/GMT+5', EDT: 'Etc/GMT+4',
  CT: 'America/Chicago', CST: 'Etc/GMT+6', CDT: 'Etc/GMT+5',
  PT: 'America/Los_Angeles', PST: 'Etc/GMT+8', PDT: 'Etc/GMT+7',
  UTC: 'UTC', GMT: 'UTC',
};
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

const unique = (values) => [...new Set(values.filter(Boolean))];
const cleanUrl = (value) => String(value || '').replace(/&amp;/g, '&').replace(/[),.;]+$/, '');

export function snowflakeDate(id) {
  if (!/^\d{15,20}$/.test(String(id || ''))) return null;
  try {
    const ms = Number((BigInt(id) >> 22n) + X_EPOCH);
    const date = new Date(ms);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

export function linksFromMarkdown(markdown) {
  const links = [];
  const value = String(markdown || '');
  for (const match of value.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+"(https?:\/\/[^"]+)")?\)/gi)) {
    links.push(cleanUrl(match[2] || match[1]));
  }
  for (const match of value.matchAll(/(?<!["'(])(https?:\/\/[^\s<]+)/gi)) links.push(cleanUrl(match[1]));
  return unique(links).filter((url) => {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); }
    catch { return false; }
  });
}

export function linksFromHtml(html) {
  const links = [];
  const value = String(html || '');
  for (const match of value.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) links.push(cleanUrl(match[1]));
  for (const match of value.matchAll(/(?<!["'])(https?:\/\/[^\s<"']+)/gi)) links.push(cleanUrl(match[1]));
  return unique(links);
}

function zonedParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = part.value;
  return {
    year: +out.year, month: +out.month, day: +out.day, weekday: WEEKDAYS[out.weekday.toLowerCase()],
    hour: +out.hour, minute: +out.minute, second: +out.second,
  };
}

function zonedToUtc(parts, zone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  for (let pass = 0; pass < 2; pass++) {
    const seen = zonedParts(new Date(guess), zone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    guess += Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0) - seenUtc;
  }
  return new Date(guess);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function parseScheduledTime(text, createdAt) {
  const value = String(text || '');
  const time = value.match(/\b(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!time) return null;
  const zoneMatch = value.match(/\b(EST|EDT|ET|CST|CDT|CT|PST|PDT|PT|UTC|GMT)\b/i);
  const zoneLabel = (zoneMatch?.[1] || 'ET').toUpperCase();
  const zone = TZ[zoneLabel] || TZ.ET;
  const created = new Date(createdAt || Date.now());
  if (Number.isNaN(created.valueOf())) return null;
  const base = zonedParts(created, zone);
  let date = { year: base.year, month: base.month, day: base.day };
  const lower = value.toLowerCase();

  if (/\b(tomorrow|tmr|tmrw|mañana)\b/.test(lower)) date = addLocalDays(base, 1);
  else {
    const numeric = value.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
    const ordinal = value.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
    const weekday = lower.match(/\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (numeric) {
      let year = numeric[3] ? +numeric[3] : base.year;
      if (year < 100) year += 2000;
      date = { year, month: +numeric[1], day: +numeric[2] };
    } else if (ordinal) {
      date = { year: base.year, month: base.month, day: +ordinal[1] };
      if (+ordinal[1] < base.day) {
        const nextMonth = new Date(Date.UTC(base.year, base.month, +ordinal[1]));
        date = { year: nextMonth.getUTCFullYear(), month: nextMonth.getUTCMonth() + 1, day: nextMonth.getUTCDate() };
      }
    } else if (weekday) {
      const target = WEEKDAYS[weekday[2]];
      let delta = (target - base.weekday + 7) % 7;
      if (weekday[1] === 'next' && delta === 0) delta = 7;
      date = addLocalDays(base, delta);
    }
  }

  let hour = +time[1] % 12;
  if (/^p/i.test(time[4])) hour += 12;
  let result = zonedToUtc({ ...date, hour, minute: +(time[2] || 0), second: +(time[3] || 0) }, zone);
  // A bare time normally refers to the next occurrence, not earlier on the post's date.
  const hasDateHint = /\b(tomorrow|tmr|tmrw|today|tonight|mañana|hoy|this|next|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(value)
    || /\b\d{1,2}[\/-]\d{1,2}\b/.test(value) || /\b\d{1,2}(?:st|nd|rd|th)\b/i.test(value);
  if (!hasDateHint && result.getTime() < created.getTime() - 30 * 60000) {
    const next = addLocalDays(date, 1);
    result = zonedToUtc({ ...next, hour, minute: +(time[2] || 0), second: +(time[3] || 0) }, zone);
  }
  return { iso: result.toISOString(), timezone: zoneLabel };
}

function methodFromText(text) {
  const value = String(text || '').toLowerCase();
  if (/kick(?:\s+|-)points?|points?\s+on\s+kick/.test(value)) return 'Kick points';
  if (/twitch(?:\s+|-)points?|points?\s+on\s+twitch/.test(value)) return 'Twitch points';
  if (/\bcode\b|redeem|c[oó]digo/.test(value)) return 'Code drop';
  if (/\blauncher\b|launch(?:ing)?\s+(?:the\s+)?item/.test(value)) return 'Launcher';
  if (/web(?:site)?\s+drop|drops?\s+on\s+(?:x|twitter|the\s+website)/.test(value)) return 'Web drop';
  if (/join\s*(?:(?:&|and)\s*)?claim/.test(value)) return 'Join & claim';
  if (/\bquest\b|misi[oó]n|play\s+\d|matches|invite|invita|afk|hours?\s+to\s+(?:get|claim)|join\s+(?:the\s+)?group|(?:estar|unirse)\s+en\s+el\s+grupo/.test(value)) return 'Quest';
  return 'Unknown';
}

function numberFrom(value) {
  if (!value) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  const suffix = normalized.match(/[km]$/i)?.[0]?.toLowerCase();
  const number = Number(suffix ? normalized.slice(0, -1) : normalized) * (suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1);
  return Number.isFinite(number) ? number : null;
}

function titleFromText(text, username) {
  const first = String(text || '').split(/(?:[.!?]\s+|\n)/)[0].replace(/^RT\s+/i, '').trim();
  if (!first) return `UGC update from @${username}`;
  return first.length > 96 ? `${first.slice(0, 95)}…` : first;
}

export function extractScheduleEntries(post) {
  const text = String(post.text || '');
  const links = unique(post.links || []);
  const relevant = /\b(ugc|limited|free item|gratis|pr[oó]ximo|drop(?:ping|s|ped)?|launch(?:er|ing|es|ed)?|restock(?:ed|ing)?|redeem|obtain|claim|reclamar|obtener|available soon|will be available|uploaded a new item)\b/i.test(text);
  // Only catalog IDs are verified as assets. Bundle IDs live in a separate Roblox namespace and
  // could otherwise collide with an unrelated asset ID.
  const itemIds = unique(links.map((url) => url.match(/roblox\.com\/catalog\/(\d+)/i)?.[1]));
  const gameUrls = unique(links.filter((url) => /roblox\.com\/games\/\d+/i.test(url)));
  if (!relevant || (!itemIds.length && !gameUrls.length)) return [];

  const createdAt = post.createdAt || snowflakeDate(post.id) || new Date().toISOString();
  const schedule = parseScheduledTime(text, createdAt);
  const expectedStock = numberFrom(text.match(/\b([\d,]+(?:\.\d+)?\s*[km]?)\s*(?:stock|copies)\b/i)?.[1]
    || text.match(/\bstock\s*:?\s*([\d,]+(?:\.\d+)?\s*[km]?)/i)?.[1]);
  const limitPerUser = numberFrom(text.match(/\b(?:limit(?:ed)?\s*(?:to)?|max)\s*([\d,.]+)\s*(?:per\s+(?:user|person))?/i)?.[1]);
  const code = text.match(/\b(?:redeem\s+(?:the\s+)?code|code\s*(?:is|:))\s*[`"']?([A-Z0-9-]{3,24})\b/i)?.[1] || null;
  const region = /\b(?:US|USA|United States)\s+(?:only|accounts?\s+only)|region.?lock(?:ed)?[^.]{0,30}\b(?:US|USA)\b/i.test(text) ? 'US' : null;
  const isPaid = /\bpaid\b|\b\d[\d,.]*\s*robux\b/i.test(text);
  const isCancelled = /\b(cancelled|canceled|abandoned|not releasing|called off)\b/i.test(text);
  const common = {
    postKey: post.key, postId: post.id || null, username: post.username, sourceUrl: post.url,
    createdAt, scheduledAt: schedule?.iso || null, timezone: schedule?.timezone || null,
    text, image: post.image || null, links, gameUrls, method: methodFromText(text), expectedStock,
    limitPerUser, code, region, isPaid, isCancelled, isRestock: /\brestock/i.test(text),
  };
  const ids = itemIds.length ? itemIds : [null];
  return ids.map((itemId) => ({
    ...common,
    id: itemId ? `item:${itemId}` : `post:${post.username}:${post.key}`,
    itemId,
    itemUrl: itemId ? links.find((url) => new RegExp(`roblox\\.com/catalog/${itemId}(?:/|$)`, 'i').test(url)) : null,
    title: titleFromText(text, post.username),
  }));
}

function statusFor(entry, detail, now) {
  if (entry.isCancelled) return 'cancelled';
  if (detail && detail.r > 0 && !detail.off) return 'live';
  const scheduled = entry.scheduledAt ? Date.parse(entry.scheduledAt) : NaN;
  if (Number.isFinite(scheduled) && scheduled > now) return 'upcoming';
  if (detail && detail.t > 0 && detail.r === 0) return 'ended';
  if (Number.isFinite(scheduled) && scheduled <= now - 30 * 60000) return 'delayed';
  return 'announced';
}

export function mergeSchedule(previous, posts, catalog = new Map(), now = Date.now(), preserveCatalog = false) {
  const entries = new Map();
  for (const old of previous?.items || []) {
    const created = Date.parse(old.createdAt || 0);
    const scheduled = Date.parse(old.scheduledAt || 0);
    if (created >= now - KEEP_MS || scheduled >= now - 2 * DAY) entries.set(old.id, old);
  }
  const extracted = posts.flatMap(extractScheduleEntries).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const item of extracted) {
    const old = entries.get(item.id);
    if (!old || Date.parse(item.createdAt) >= Date.parse(old.createdAt || 0)) {
      const reminders = { ...(old?.reminders || {}) };
      // A moved release needs a fresh starting-soon alert for its new time.
      if (old?.scheduledAt && item.scheduledAt && old.scheduledAt !== item.scheduledAt) delete reminders.soon;
      entries.set(item.id, { ...old, ...item, reminders });
    }
  }
  const items = [...entries.values()].map((entry) => {
    let detail = entry.itemId ? catalog.get(String(entry.itemId)) : null;
    if (!detail && preserveCatalog && entry.verified) detail = {
      n: entry.title, r: entry.currentStock, t: entry.totalStock, off: entry.offSale, price: entry.price,
    };
    const isPaid = Boolean(entry.isPaid || (detail && detail.price > 0));
    return {
      ...entry,
      isPaid,
      title: detail?.n || entry.title,
      verified: Boolean(detail),
      currentStock: detail?.r ?? null,
      totalStock: detail?.t ?? entry.expectedStock ?? null,
      offSale: detail?.off ?? null,
      price: detail?.price ?? null,
      status: statusFor(entry, detail, now),
      checkedAt: new Date(now).toISOString(),
    };
  }).filter((entry) => !entry.isPaid);
  items.sort((a, b) => {
    const at = a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity;
    const bt = b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity;
    return at - bt || Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  return { items, updatedAt: new Date(now).toISOString() };
}

export function scheduleEvents(previous, next, now = Date.now()) {
  const oldById = new Map((previous?.items || []).map((item) => [item.id, item]));
  const events = [];
  for (const item of next.items) {
    const old = oldById.get(item.id);
    const scheduled = item.scheduledAt ? Date.parse(item.scheduledAt) : NaN;
    const soon = Number.isFinite(scheduled) && scheduled >= now - 2 * 60000 && scheduled <= now + 20 * 60000;
    if (soon && ['upcoming', 'announced'].includes(item.status) && !old?.reminders?.soon) events.push({ kind: 'soon', item });
    if (old && item.status === 'live' && old.status !== 'live') events.push({ kind: 'live', item });
    if (old?.scheduledAt && item.scheduledAt && old.scheduledAt !== item.scheduledAt) events.push({ kind: 'changed', item });
  }
  return events;
}
