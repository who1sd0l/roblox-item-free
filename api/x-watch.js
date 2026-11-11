// Free new-post alerts for public X accounts, using Jina Reader with RSS mirrors as fallback.
// Call from an external cron: GET /api/x-watch?key=WATCH_SECRET
//
// Env: X_ACCOUNTS (comma-separated handles), X_DISCORD_WEBHOOK_URL, WATCH_SECRET, and the same
// Redis variables used by /api/watch. Optional: X_WATCH_SECRET, X_DISCORD_MENTION,
// X_INCLUDE_REPLIES=true, X_INCLUDE_REPOSTS=true, X_RSS_BASE_URLS (custom/self-hosted mirrors).
// DISCORD_WEBHOOK_URL is used as a backward-compatible fallback when the X-specific URL is absent.
// Query: ?test=1 sends a sample Discord message without fetching X;
//        ?dry=1 reports new posts without sending or saving.

import { redis, X_SCHEDULE_KEY, X_STATE_KEY } from './_lib/redis.js';
import { fetchCatalogDetails } from './_lib/roblox.js';
import { linksFromHtml, linksFromMarkdown, mergeSchedule, scheduleEvents, snowflakeDate } from './_lib/x-schedule.js';
import { createHash } from 'node:crypto';

// The first public RSS mirror accepts server-side Node requests. The Teapawt fallbacks explicitly
// allow scraping, although some locations may receive a Cloudflare check. Custom/self-hosted URLs
// can replace this list through X_RSS_BASE_URLS.
const DEFAULT_RSS_BASES = [
  'https://nitter.kareem.one',
  'https://nitter.cf',
  'https://nitter.gq',
  'https://xitter.cf',
  'https://xitter.gq',
  'https://teapaw.org',
  'https://teapawt.net',
  'https://teapawt.org',
];
const MAX_ACCOUNTS = 10;
const MAX_MIRRORS_PER_ACCOUNT = 2;
const RSS_FETCH_TIMEOUT = 3500;
const JINA_FETCH_TIMEOUT = 15000;
const MAX_SEEN = 100;
const env = (key) => (process.env[key] || '').trim();
const enabled = (key) => /^(1|true|yes|on)$/i.test(env(key));
const cut = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

function accountsFromEnv() {
  const handles = env('X_ACCOUNTS')
    .split(/[\s,]+/)
    .map((handle) => handle.replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(handles)];
  const invalid = unique.filter((handle) => !/^[a-z0-9_]{1,15}$/i.test(handle));
  if (invalid.length) throw new Error(`Invalid X account handle: ${invalid.join(', ')}`);
  if (!unique.length) throw new Error('X_ACCOUNTS is not set');
  if (unique.length > MAX_ACCOUNTS) throw new Error(`X_ACCOUNTS supports up to ${MAX_ACCOUNTS} handles`);
  return unique;
}

function rssBases() {
  const configured = env('X_RSS_BASE_URLS').split(/[\s,]+/).filter(Boolean);
  const values = configured.length ? configured : DEFAULT_RSS_BASES;
  return [...new Set(values.map((value) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid RSS mirror URL: ${value}`);
    return url.origin + url.pathname.replace(/\/+$/, '');
  }))];
}

function fingerprint(text, image) {
  const normalizedText = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let normalizedImage = String(image || '');
  try {
    const url = new URL(normalizedImage);
    normalizedImage = `${url.hostname}${url.pathname}`;
  } catch { /* no image */ }
  return `hash:${createHash('sha256').update(`${normalizedText}\n${normalizedImage}`).digest('hex').slice(0, 24)}`;
}

function unwrap(value) {
  const match = String(value || '').match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return match ? match[1] : String(value || '');
}

function decodeXml(value) {
  let decoded = unwrap(value);
  for (let pass = 0; pass < 2; pass++) {
    decoded = decoded
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return decoded;
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? match[1] : '';
}

function descriptionText(raw) {
  const ownPost = unwrap(raw).split(/<hr\s*\/?>/i)[0];
  return decodeXml(ownPost
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseFeed(xml, account) {
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error('response was not an RSS feed');
  const header = xml.split(/<item>/i)[0];
  const channelTitle = decodeXml(tag(header, 'title'));
  const name = channelTitle.replace(/\s*\/\s*@.*$/, '').trim() || account;
  const avatarBlock = tag(header, 'image');
  const avatar = decodeXml(tag(avatarBlock, 'url')) || null;
  const posts = [];

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const id = decodeXml(tag(item, 'guid')).trim();
    if (!/^\d{1,20}$/.test(id)) continue;
    const title = decodeXml(tag(item, 'title')).trim();
    const description = tag(item, 'description');
    const creator = decodeXml(tag(item, 'dc:creator')).trim().replace(/^@/, '');
    const imageMatch = unwrap(description).match(/<img[^>]+src=["']([^"']+)["']/i);
    const date = new Date(decodeXml(tag(item, 'pubDate')).trim());
    const repost = /^RT\s+@.+?\s+\(by\s+@.+?\):/i.test(title);
    const reply = /^R to @/i.test(title);
    const text = descriptionText(description)
      || title.replace(/^RT\s+@.+?\s+\(by\s+@.+?\):\s*/i, '').replace(/^R to @.+?:\s*/i, '');
    posts.push({
      id,
      key: `id:${id}`,
      username: account,
      creator: creator || account,
      name,
      text,
      createdAt: Number.isNaN(date.valueOf()) ? null : date.toISOString(),
      url: `https://x.com/${encodeURIComponent(account)}/status/${id}`,
      avatar,
      image: imageMatch ? decodeXml(imageMatch[1]) : null,
      links: linksFromHtml(decodeXml(`${title}\n${unwrap(description)}`)),
      repost,
      reply,
    });
  }
  if (!posts.length && /<item>/i.test(xml)) throw new Error('RSS items could not be parsed');
  return { name, avatar, posts };
}

function markdownText(value) {
  return String(value || '')
    .replace(/\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[\d+\]\(https:\/\/x\.com\/compose\/[^)]*\)/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^Pinned\s*/i, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJina(data, account) {
  const content = String(data?.content || '');
  if (!content) throw new Error('Reader returned no profile content');
  const title = String(data?.title || '');
  const name = title.replace(/\s+\(@[^)]*\).*$/, '').trim() || account;
  const avatarMatch = content.match(/https:\/\/pbs\.twimg\.com\/profile_images\/[^)\s]+/i);
  const avatar = avatarMatch ? avatarMatch[0] : null;
  const heading = content.match(/\n## [^\n]+(?:’|'|’)s posts\s*\n/i);
  const section = heading ? content.slice(heading.index + heading[0].length) : content;
  const chunks = section.split(/^\* {3}/m).slice(1);
  const escapedAccount = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const statusPattern = new RegExp(`\\[[^\\]]+\\]\\(https://x\\.com/${escapedAccount}/status/(\\d+)\\)`, 'i');
  const profilePattern = new RegExp(`\\[[^\\]]*\\]\\(https://x\\.com/${escapedAccount}\\)`, 'gi');
  const posts = [];

  for (const chunk of chunks) {
    const status = chunk.match(statusPattern);
    const id = status?.[1] || null;
    let body = status ? chunk.slice(status.index + status[0].length) : chunk;
    if (id) {
      const timePattern = new RegExp(`\\[[^\\]]+\\]\\(https://x\\.com/${escapedAccount}/status/${id}\\)`, 'gi');
      const timeLinks = [...chunk.matchAll(timePattern)];
      const timeLink = timeLinks[timeLinks.length - 1];
      if (timeLink) body = chunk.slice(timeLink.index + timeLink[0].length);
      const tails = [
        body.search(new RegExp(`\\[\\]\\(https://x\\.com/${escapedAccount}/status/${id}/(?:photo|video)/`, 'i')),
        body.search(/\[[^\]]*\]\(https:\/\/x\.com\/compose\/post\?/i),
      ].filter((index) => index >= 0);
      if (tails.length) body = body.slice(0, Math.min(...tails));
    }
    body = body.replace(profilePattern, '').replace(/^\s*Pinned\s*/i, '');
    const imageMatches = [...chunk.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/gi)];
    const image = imageMatches.map((match) => match[1]).find((url) =>
      /pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb)\//i.test(url)) || null;
    const handleMatches = [...chunk.matchAll(/\[@([a-z0-9_]+)\]\(https:\/\/x\.com\/[a-z0-9_]+\)/gi)];
    // With a status link the leading handle is the author. Some X profile renders omit both the
    // status link and author metadata; in that case, do not mistake a mentioned account for a repost.
    const creator = status ? (handleMatches[0]?.[1] || account) : account;
    const text = markdownText(body);
    if (!id && !text && !image) continue;
    const key = id ? `id:${id}` : fingerprint(text, image);
    posts.push({
      id,
      key,
      username: account,
      creator,
      name,
      text,
      url: id ? `https://x.com/${encodeURIComponent(account)}/status/${id}` : `https://x.com/${encodeURIComponent(account)}`,
      avatar,
      image,
      links: linksFromMarkdown(chunk).filter((url) =>
        !/^https:\/\/x\.com\/(?:compose\/|[^/]+\/status\/\d+(?:\/(?:photo|video)\/\d+)?$)/i.test(url)
        && !/pbs\.twimg\.com\/(?:profile_images|media|ext_tw_video_thumb|amplify_video_thumb)\//i.test(url)),
      repost: creator.toLowerCase() !== account.toLowerCase(),
      reply: /Replying to|^R to @/i.test(chunk),
      createdAt: snowflakeDate(id),
    });
  }
  if (!posts.length) throw new Error('Reader profile contained no parseable posts');
  return { name, avatar, posts };
}

async function fetchJinaAccount(account) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_FETCH_TIMEOUT);
  try {
    const response = await fetch(`https://r.jina.ai/https://x.com/${encodeURIComponent(account)}`, {
      headers: { accept: 'application/json', 'x-no-cache': 'true' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.code && body.code !== 200) throw new Error(body.message || `Reader code ${body.code}`);
    return { account, source: 'r.jina.ai', sourceType: 'jina', ...parseJina(body.data, account) };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'user-agent': 'Free-Limiteds-Board/1.0 (public RSS watcher)',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRssAccount(account, bases) {
  const failures = [];
  for (const base of bases.slice(0, MAX_MIRRORS_PER_ACCOUNT)) {
    // A few accounts return 404 on the standard profile route while the with-replies route works.
    // When replies are disabled we can still use that fuller feed and remove replies locally.
    const suffixes = enabled('X_INCLUDE_REPLIES') ? ['/with_replies/rss'] : ['/rss', '/with_replies/rss'];
    for (const suffix of suffixes) {
      try {
        const xml = await fetchText(`${base}/${encodeURIComponent(account)}${suffix}`);
        return { account, source: new URL(base).hostname, sourceType: 'rss', ...parseFeed(xml, account) };
      } catch (error) {
        const reason = error.name === 'AbortError' ? 'timeout' : error.message;
        failures.push(`${new URL(base).hostname}${suffix === '/rss' ? '' : ' (with replies)'}: ${reason}`);
      }
    }
  }
  throw new Error(failures.join('; '));
}

async function fetchAccount(account, bases) {
  try {
    return await fetchJinaAccount(account);
  } catch (jinaError) {
    try {
      return await fetchRssAccount(account, bases);
    } catch (rssError) {
      const jinaReason = jinaError.name === 'AbortError' ? 'timeout' : jinaError.message;
      throw new Error(`Reader: ${jinaReason}; RSS: ${rssError.message}`);
    }
  }
}

function embedFor(post) {
  const author = post.repost && post.creator.toLowerCase() !== post.username.toLowerCase()
    ? `${post.name} reposted @${post.creator}`
    : `${post.name} (@${post.username})`;
  return {
    author: { name: cut(author, 256), url: post.url, icon_url: post.avatar || undefined },
    description: cut(post.text || '(Post has no text)', 3900),
    url: post.url,
    color: 0x1d9bf0,
    image: post.image ? { url: post.image } : undefined,
    footer: { text: 'New post on X' },
    timestamp: post.createdAt || undefined,
  };
}

async function postDiscord(payload) {
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

async function sendDiscord(post) {
  const mention = env('X_DISCORD_MENTION');
  return postDiscord({
    content: mention || undefined,
    embeds: [embedFor(post)],
    allowed_mentions: mention ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
  });
}

async function sendScheduleDiscord(event) {
  const item = event.item;
  const labels = {
    soon: '⏰ Free UGC drop starting soon',
    live: '🚀 Free UGC drop is live',
    changed: '🕒 Free UGC release time changed',
  };
  const colors = { soon: 0xf59e0b, live: 0x22c55e, changed: 0x3b82f6 };
  const when = item.scheduledAt ? `<t:${Math.floor(Date.parse(item.scheduledAt) / 1000)}:F> · <t:${Math.floor(Date.parse(item.scheduledAt) / 1000)}:R>` : 'Time not confirmed';
  const lines = [
    `**${cut(item.title, 180)}**`,
    `**When:** ${when}`,
    `**Method:** ${item.method || 'Unknown'}`,
    item.currentStock !== null ? `**Stock:** ${item.currentStock.toLocaleString()}/${(item.totalStock || 0).toLocaleString()} left` : item.expectedStock ? `**Expected stock:** ${item.expectedStock.toLocaleString()}` : '',
    item.gameUrls?.[0] ? `**[Join game](${item.gameUrls[0]})**` : '',
    `**[Source post](${item.sourceUrl})**`,
  ].filter(Boolean);
  const mention = env('X_DISCORD_MENTION');
  return postDiscord({
    content: mention || undefined,
    embeds: [{
      title: labels[event.kind],
      description: lines.join('\n'),
      url: item.itemUrl || item.sourceUrl,
      color: colors[event.kind],
      image: item.image ? { url: item.image } : undefined,
      footer: { text: `Tracked from @${item.username}` },
      timestamp: item.scheduledAt || item.createdAt,
    }],
    allowed_mentions: mention ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
  });
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = env('X_WATCH_SECRET') || env('WATCH_SECRET');
  const given = String(req.query?.key || '').trim()
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!secret || given !== secret) return res.status(401).json({ error: 'bad or missing key' });

  try {
    if (req.query?.test) {
      await sendDiscord({
        username: 'example', creator: 'example', name: 'Example account',
        text: 'This is a test from the free X account watcher.', url: 'https://x.com',
        avatar: null, image: null, repost: false, createdAt: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, sent: 'test' });
    }

    const accounts = accountsFromEnv();
    const bases = rssBases();
    const [rawState, rawSchedule] = await redis(['MGET', X_STATE_KEY, X_SCHEDULE_KEY]);
    const previous = rawState ? JSON.parse(rawState) : null;
    const previousSchedule = rawSchedule ? JSON.parse(rawSchedule) : null;
    const results = await Promise.all(accounts.map(async (account) => {
      try { return { ok: true, feed: await fetchAccount(account, bases) }; }
      catch (error) { return { ok: false, account, error: error.message }; }
    }));
    const successful = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok).map(({ account, error }) => ({ account, error }));
    if (!successful.length) throw new Error(`Every X source failed: ${failed.map((x) => `${x.account}: ${x.error}`).join(' | ')}`);

    const includeReplies = enabled('X_INCLUDE_REPLIES');
    const includeReposts = enabled('X_INCLUDE_REPOSTS');
    const nextAccounts = {};
    const pending = [];
    const baselined = [];
    for (const { feed } of successful) {
      const old = previous?.accounts?.[feed.account];
      const currentKeys = feed.posts.map((post) => post.key);
      const oldKeys = Array.isArray(old?.seen) ? old.seen : [];
      const sourceChanged = old?.sourceType && old.sourceType !== feed.sourceType;
      nextAccounts[feed.account] = {
        initialized: true,
        seen: [...new Set([...currentKeys, ...oldKeys])].slice(0, MAX_SEEN),
        source: feed.source,
        sourceType: feed.sourceType,
        posts: feed.posts.slice(0, 20).map(({ id, key, username, creator, name, text, createdAt, url, avatar, image, links, repost, reply }) => ({
          id, key, username, creator, name, text, createdAt, url, avatar, image, links, repost, reply,
        })),
      };
      if (!old?.initialized || !Array.isArray(old.seen) || sourceChanged) {
        baselined.push(feed.account);
        continue;
      }
      const seen = new Set(old.seen);
      for (let index = 0; index < feed.posts.length; index++) {
        const post = feed.posts[index];
        if (seen.has(post.key)) continue;
        if ((!includeReplies && post.reply) || (!includeReposts && post.repost)) continue;
        pending.push({ ...post, feedIndex: index });
      }
    }
    for (const account of accounts) {
      if (!nextAccounts[account] && previous?.accounts?.[account]) nextAccounts[account] = previous.accounts[account];
    }

    const schedulePosts = successful.flatMap(({ feed }) => feed.posts.filter((post) => !post.reply || includeReplies));
    let nextSchedule = mergeSchedule(previousSchedule, schedulePosts, new Map());
    const catalogIds = [...new Set(nextSchedule.items.map((item) => item.itemId).filter(Boolean))];
    let catalog = new Map();
    let catalogFailed = false;
    if (catalogIds.length) {
      try { catalog = await fetchCatalogDetails(catalogIds); }
      catch (error) {
        catalogFailed = true;
        failed.push({ account: 'Roblox verification', error: error.message });
      }
    }
    nextSchedule = mergeSchedule(previousSchedule, schedulePosts, catalog, Date.now(), catalogFailed);
    const scheduleAlerts = scheduleEvents(previousSchedule, nextSchedule);
    pending.sort((a, b) => {
      if (a.id && b.id) return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
      return b.feedIndex - a.feedIndex;
    });

    if (!req.query?.dry) {
      for (const post of pending) await sendDiscord(post);
      for (const event of scheduleAlerts) {
        await sendScheduleDiscord(event);
        const saved = nextSchedule.items.find((item) => item.id === event.item.id);
        if (saved) saved.reminders = { ...(saved.reminders || {}), [event.kind]: new Date().toISOString() };
      }
      await Promise.all([
        redis(['SET', X_STATE_KEY, JSON.stringify({
          initialized: true,
          accounts: nextAccounts,
          ts: Math.floor(Date.now() / 1000),
        })]),
        redis(['SET', X_SCHEDULE_KEY, JSON.stringify(nextSchedule)]),
      ]);
    }

    return res.status(200).json({
      ok: true,
      free: true,
      dry: Boolean(req.query?.dry),
      accounts,
      baselined,
      fetched: successful.reduce((total, result) => total + result.feed.posts.length, 0),
      notified: pending.length,
      upcoming: nextSchedule.items.length,
      scheduleAlerts: scheduleAlerts.map(({ kind, item }) => ({ kind, id: item.id, title: item.title, scheduledAt: item.scheduledAt })),
      failed,
      sources: Object.fromEntries(successful.map(({ feed }) => [feed.account, feed.source])),
      posts: req.query?.dry ? pending.map(({ id, key, username, text, url }) => ({ id: id || key, username, text, url })) : undefined,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'X watcher failed' });
  }
}
