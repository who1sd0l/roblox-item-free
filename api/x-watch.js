// Free new-post alerts for public X accounts, using Teapawt/Nitter-compatible RSS feeds.
// Call from an external cron: GET /api/x-watch?key=WATCH_SECRET
//
// Env: X_ACCOUNTS (comma-separated handles), X_DISCORD_WEBHOOK_URL, WATCH_SECRET, and the same
// Redis variables used by /api/watch. Optional: X_WATCH_SECRET, X_DISCORD_MENTION,
// X_INCLUDE_REPLIES=true, X_INCLUDE_REPOSTS=true, X_RSS_BASE_URLS (custom/self-hosted mirrors).
// DISCORD_WEBHOOK_URL is used as a backward-compatible fallback when the X-specific URL is absent.
// Query: ?test=1 sends a sample Discord message without fetching RSS;
//        ?dry=1 reports new posts without sending or saving.

import { redis, X_STATE_KEY } from './_lib/redis.js';

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
const MAX_MIRRORS_PER_ACCOUNT = 5;
const FETCH_TIMEOUT = 6500;
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

function laterId(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return BigInt(a) > BigInt(b) ? a : b;
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
      username: account,
      creator: creator || account,
      name,
      text,
      createdAt: Number.isNaN(date.valueOf()) ? null : date.toISOString(),
      url: `https://x.com/${encodeURIComponent(account)}/status/${id}`,
      avatar,
      image: imageMatch ? decodeXml(imageMatch[1]) : null,
      repost,
      reply,
    });
  }
  if (!posts.length && /<item>/i.test(xml)) throw new Error('RSS items could not be parsed');
  return { name, avatar, posts };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
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

async function fetchAccount(account, bases) {
  const failures = [];
  for (const base of bases.slice(0, MAX_MIRRORS_PER_ACCOUNT)) {
    // A few accounts return 404 on the standard profile route while the with-replies route works.
    // When replies are disabled we can still use that fuller feed and remove replies locally.
    const suffixes = enabled('X_INCLUDE_REPLIES') ? ['/with_replies/rss'] : ['/rss', '/with_replies/rss'];
    for (const suffix of suffixes) {
      try {
        const xml = await fetchText(`${base}/${encodeURIComponent(account)}${suffix}`);
        return { account, source: new URL(base).hostname, ...parseFeed(xml, account) };
      } catch (error) {
        const reason = error.name === 'AbortError' ? 'timeout' : error.message;
        failures.push(`${new URL(base).hostname}${suffix === '/rss' ? '' : ' (with replies)'}: ${reason}`);
      }
    }
  }
  throw new Error(failures.join('; '));
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

async function sendDiscord(post) {
  const hook = env('X_DISCORD_WEBHOOK_URL') || env('DISCORD_WEBHOOK_URL');
  if (!hook) throw new Error('X_DISCORD_WEBHOOK_URL is not set');
  const url = new URL(hook);
  url.searchParams.set('wait', 'true');
  const mention = env('X_DISCORD_MENTION');
  const payload = {
    content: mention || undefined,
    embeds: [embedFor(post)],
    allowed_mentions: mention ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
  };

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
    const rawState = await redis(['GET', X_STATE_KEY]);
    const previous = rawState ? JSON.parse(rawState) : null;
    const results = await Promise.all(accounts.map(async (account) => {
      try { return { ok: true, feed: await fetchAccount(account, bases) }; }
      catch (error) { return { ok: false, account, error: error.message }; }
    }));
    const successful = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok).map(({ account, error }) => ({ account, error }));
    if (!successful.length) throw new Error(`Every RSS feed failed: ${failed.map((x) => `${x.account}: ${x.error}`).join(' | ')}`);

    const includeReplies = enabled('X_INCLUDE_REPLIES');
    const includeReposts = enabled('X_INCLUDE_REPOSTS');
    const nextAccounts = {};
    const pending = [];
    const baselined = [];
    for (const { feed } of successful) {
      const old = previous?.accounts?.[feed.account];
      const latestId = feed.posts.reduce((latest, post) => laterId(latest, post.id), old?.sinceId || null);
      nextAccounts[feed.account] = { initialized: true, sinceId: latestId, source: feed.source };
      if (!old?.initialized && !old?.sinceId) {
        baselined.push(feed.account);
        continue;
      }
      for (const post of feed.posts) {
        if (old.sinceId && BigInt(post.id) <= BigInt(old.sinceId)) continue;
        if ((!includeReplies && post.reply) || (!includeReposts && post.repost)) continue;
        pending.push(post);
      }
    }
    for (const account of accounts) {
      if (!nextAccounts[account] && previous?.accounts?.[account]) nextAccounts[account] = previous.accounts[account];
    }
    pending.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

    if (!req.query?.dry) {
      for (const post of pending) await sendDiscord(post);
      await redis(['SET', X_STATE_KEY, JSON.stringify({
        initialized: true,
        accounts: nextAccounts,
        ts: Math.floor(Date.now() / 1000),
      })]);
    }

    return res.status(200).json({
      ok: true,
      free: true,
      dry: Boolean(req.query?.dry),
      accounts,
      baselined,
      fetched: successful.reduce((total, result) => total + result.feed.posts.length, 0),
      notified: pending.length,
      failed,
      sources: Object.fromEntries(successful.map(({ feed }) => [feed.account, feed.source])),
      posts: req.query?.dry ? pending.map(({ id, username, text, url }) => ({ id, username, text, url })) : undefined,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'X RSS watcher failed' });
  }
}
