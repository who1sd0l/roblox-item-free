import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('inline browser scripts parse', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const [, source] of scripts) assert.doesNotThrow(() => new Function(source));
});

test('static element ids are unique and JavaScript references exist', () => {
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);

  const references = [...html.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  const missing = [...new Set(references.filter((id) => !ids.includes(id)))];
  assert.deepEqual(missing, []);
});

test('personal tracking and cross-feed pulse controls are present', () => {
  assert.match(html, /data-v="saved"/);
  assert.match(html, /data-save=/);
  assert.match(html, /id="pulse-active"/);
  assert.match(html, /id="pulse-drop"/);
  assert.match(html, /id="pulse-event"/);
  assert.match(html, /timeZone: 'Asia\/Kuala_Lumpur'/);
});

test('navigation uses the organized responsive sidebar shell', () => {
  assert.match(html, /<aside class="sidebar"/);
  assert.match(html, /class="main-shell"/);
  assert.match(html, /class="nav-label" role="presentation">Live tracking/);
  assert.match(html, /id="view-title"/);
  assert.match(html, /@media \(max-width:1000px\)/);
});

test('claim activity uses one deduplicated view with stock sorting', () => {
  assert.match(html, /data-v="claimable"[^>]*>Claimable now/);
  assert.doesNotMatch(html, /data-v="active"/);
  assert.doesNotMatch(html, /data-v="low"/);
  assert.match(html, /\['stock', 'Most stock left'\]/);
  assert.match(html, /\['low', 'Lowest stock first'\]/);
  assert.match(html, /data-pulse-tab="claimable"/);
});
