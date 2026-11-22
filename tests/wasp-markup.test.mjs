import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, ROOT), 'utf8');

for (const [filename, name] of [['index', 'PhoneMarkup'], ['stage', 'StageMarkup']]) {
  test(name + ' preserves legacy controller IDs and state attributes as React markup', async () => {
    const html = await text('public/' + filename + '.html');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1];
    const jsx = await text('wasp-ui/src/generated/' + name + '.tsx');
    assert.ok(body);
    assert.match(jsx, new RegExp('export function ' + name + '\\('));
    const hooks = source => Array.from(source.matchAll(/\s(id|role|aria-[a-z-]+|data-[a-z-]+)="([^"]*)"/g), match => [match[1], match[2]]);
    assert.deepEqual(hooks(jsx), hooks(body));
    assert.doesNotMatch(jsx, /<(?:script|iframe)\b|dangerouslySetInnerHTML/);
    assert.doesNotMatch(jsx, /\s(?:class|for|viewbox)=/);
    assert.match(jsx, /<svg[^>]*viewBox=/);
  });
}

test('phone input remains uncontrolled for Media Session and setup controllers', async () => {
  const jsx = await text('wasp-ui/src/generated/PhoneMarkup.tsx');
  assert.match(jsx, /<audio id="keepalive"[^>]+loop playsInline/);
  assert.match(jsx, /<input[^>]*type="radio"[^>]*name="earbud_mode"[^>]*defaultValue="next-only"/);
  assert.match(jsx, /<input[^>]*name="cal_scope"[^>]*defaultValue="mode" defaultChecked/);
  assert.match(jsx, /<input[^>]+id="settings-room-link"[^>]*readOnly hidden/);
});

test('stage preserves inline SVG definitions, joins, and room mic controls', async () => {
  const jsx = await text('wasp-ui/src/generated/StageMarkup.tsx');
  assert.match(jsx, /<clipPath id="profclip"><use href="#prof" \/><\/clipPath>/);
  assert.match(jsx, /href="\/\?sim=1&amp;seat=A"/);
  assert.match(jsx, /<label[^>]*htmlFor="room-mic-device"/);
  assert.match(jsx, /<meter[^>]*id="room-mic-level"[^>]*max="1"/);
});
