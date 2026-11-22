import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, ROOT), 'utf8');

for (const [filename, name] of [['index', 'PhoneMarkup'], ['stage', 'StageMarkup']]) {
  test(name + ' preserves legacy controller IDs and state attributes as React markup', async () => {
    const html = await text('public/' + filename + '.html');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1];
    const generated = await text('wasp-ui/src/generated/' + name + '.tsx');
    const jsx = generated.replace(/<ChannelMonitor id="([^"]+)" className="[^"]+" \/>/g,
      '<section id="$1" aria-label="Live audio and context"></section>');
    assert.ok(body);
    assert.match(jsx, new RegExp('export function ' + name + '\\('));
    assert.equal((generated.match(/<ChannelMonitor /g) ?? []).length, filename === 'index' ? 1 : 2);
    const hooks = source => Array.from(source.matchAll(/\s(id|role|aria-[a-z-]+|data-[a-z-]+)="([^"]*)"/g), match => [match[1], match[2]]);
    if (filename === 'index') {
      const pitch = await text('wasp-ui/src/PhonePitchControls.tsx');
      const calibration = await text('wasp-ui/src/CalibrationTrial.tsx');
      const replaced = jsx.replace('<PhonePitchControls />', pitch.replaceAll('className="pitch-panel__status" role="status"', 'className="pitch-panel__status"'))
        .replace('<CalibrationTrial />', calibration);
      const dynamic = new Set(['aria-pressed:false', 'data-pitch-owner:react', 'data-calibration-owner:react', 'aria-label:Get a private cue now']);
      const expected = hooks(body).filter(pair => !dynamic.has(pair.join(':')));
      const draft_start = expected.findIndex(([, value]) => value === 'live-draft');
      const draft_end = expected.findIndex(([, value]) => value === 'draft-discard');
      const draft_hooks = expected.splice(draft_start, draft_end - draft_start + 1);
      const receipt_hook = expected.splice(expected.findIndex(([, value]) => value === 'live-acknowledge'), 1);
      expected.splice(expected.findIndex(([, value]) => value === 'phone-monitor'), 0, ...draft_hooks, ...receipt_hook);
      assert.deepEqual(hooks(replaced).filter(pair => !dynamic.has(pair.join(':'))),
        expected);
      assert.match(pitch, /aria-pressed=\{state\.armed\}/);
    } else {
      const room = await text('wasp-ui/src/StageRoomConsole.tsx');
      const boundary = room.indexOf('export function StageRoomConsole');
      const meter = room.slice(room.indexOf('function RoomInputMeter'), boundary);
      const rendered = room.slice(boundary).replace('<RoomInputMeter wanted={state.wanted} />', meter);
      const reveal = await text('wasp-ui/src/StageRevealHeader.tsx');
      const announce = (await text('wasp-ui/src/StageAnnouncement.tsx')).split('<p className="sr-only"', 1)[0];
      const replaced = jsx.replace('<StageRoomConsole />', rendered).replace('<StageRevealHeader />', reveal)
        .replace('<StageAnnouncement />', announce);
      const dynamic = new Set(['data-state:off', 'data-room-owner:react', 'data-reveal-owner:react', 'data-announce-owner:react',
        'aria-controls:room-mic-details room-review', 'id:room-mic-details', 'id:room-review']);
      assert.deepEqual(hooks(replaced).filter(pair => !dynamic.has(pair.join(':'))),
        hooks(body).filter(pair => !dynamic.has(pair.join(':'))));
      assert.match(room, /data-state=\{state\.tone\}/);
    }
    assert.doesNotMatch(jsx, /<(?:script|iframe)\b|dangerouslySetInnerHTML/);
    assert.doesNotMatch(jsx, /\s(?:class|for|viewbox)=/);
    assert.match(jsx, /<svg[^>]*viewBox=/);
  });
}

test('the Wasp cue panel keeps the two actions distinct and exposes actual room and playback status', async () => {
  const controller = await text('public/phone.mjs');
  const component = await text('wasp-ui/src/PhonePitchControls.tsx');
  const css = await text('wasp-ui/src/liquid.css');
  for (const event of ['telepathy:pitch-state', 'telepathy:pitch-speech-start', 'telepathy:toggle-question-mode', 'telepathy:request-pitch-cue']) {
    assert.ok(controller.includes(event));
    assert.ok(component.includes(event));
  }
  assert.match(component, /disabled=\{!state\.live \|\| !state\.connected\}/);
  assert.match(component, /state\.roomLive \? 'Listening for questions' : 'Armed/);
  assert.match(component, /started \? 'Voice started'/);
  assert.match(component, /className="pitch-panel__status" role="status"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('the channel monitor renders supplied state in React and announces phase rather than meter frames', async () => {
  const component = await text('wasp-ui/src/ChannelMonitor.tsx');
  const controller = await text('public/channel-monitor.mjs');
  assert.match(component, /data-channel-owner="react"/);
  assert.match(component, /className="channel-monitor__phase" role="status"/);
  assert.match(component, /addEventListener\('telepathy:channel-monitor'/);
  assert.match(controller, /dispatchEvent\(new CustomEvent\('telepathy:channel-monitor'/);
});

test('the Wasp calibration panel separates raw browser events from the validated trial status', async () => {
  const controller = await text('public/calibrate.mjs');
  const component = await text('wasp-ui/src/CalibrationTrial.tsx');
  assert.match(controller, /dispatchEvent\(new CustomEvent\('telepathy:calibration-trial'/);
  assert.match(component, /addEventListener\('telepathy:calibration-trial'/);
  assert.match(component, /key=\{index\} data-filled=\{index < observed\}/);
  assert.match(component, /trial\?\.tone === 'hit' \? 'Accepted'/);
  assert.match(component, /Checking timing/);
});

test('phone input remains uncontrolled for Media Session and setup controllers', async () => {
  const jsx = await text('wasp-ui/src/generated/PhoneMarkup.tsx');
  assert.match(jsx, /<audio id="keepalive"[^>]+loop playsInline/);
  assert.match(jsx, /<input[^>]*type="radio"[^>]*name="earbud_mode"[^>]*defaultValue="next-only"/);
  assert.match(jsx, /<input[^>]*name="cal_scope"[^>]*defaultValue="mode" defaultChecked/);
  assert.match(jsx, /<input[^>]+id="settings-room-link"[^>]*readOnly hidden/);
});

test('timed actions precede passive context and the Live nav has its own row', async () => {
  const phone = await text('wasp-ui/src/generated/PhoneMarkup.tsx');
  const css = await text('wasp-ui/src/liquid.css');
  assert.match(phone, /<PhonePitchControls \/>[\s\S]*id="live-draft"[\s\S]*id="draft-send"[\s\S]*id="live-acknowledge"[\s\S]*<ChannelMonitor id="phone-monitor"/);
  assert.match(phone, /id="screen-live"[^>]*>\s*<div className="live-content">[\s\S]*<\/div>\s*<nav className="live-nav"/);
  assert.match(css, /#screen-live > \.live-content \{[^}]*overflow-y: auto/);
  assert.match(css, /#screen-live > \.live-nav \{[^}]*position: static/);
});

test('stage preserves inline SVG definitions, joins, and room mic controls', async () => {
  const jsx = await text('wasp-ui/src/generated/StageMarkup.tsx');
  assert.match(jsx, /<clipPath id="profclip"><use href="#prof" \/><\/clipPath>/);
  assert.match(jsx, /href="\/\?sim=1&amp;seat=A"/);
  const room = await text('wasp-ui/src/StageRoomConsole.tsx');
  assert.match(room, /<label[^>]*htmlFor="room-mic-device"/);
  assert.match(room, /<meter[^>]*id="room-mic-level"[^>]*max="1"/);
});

test('the Stage console separates live meter frames from room state and keeps actions on the capture controller', async () => {
  const controller = await text('public/stage.mjs');
  const component = await text('wasp-ui/src/StageRoomConsole.tsx');
  for (const event of ['telepathy:room-state', 'telepathy:room-level', 'telepathy:room-action']) {
    assert.ok(controller.includes(event));
    assert.ok(component.includes(event));
  }
  assert.match(component, /function RoomInputMeter/);
  assert.match(component, /aria-expanded=\{expanded\}/);
  assert.match(component, /id="room-mic-details" hidden=\{!expanded && !state.wanted\}/);
  assert.match(component, /!expanded && !state.reviewing && latest/);
  assert.doesNotMatch(component, /getUserMedia|WebSocket/);
});

test('the Wasp reveal places the source score in its focusable heading and animates the connection', async () => {
  const controller = await text('public/stage.mjs');
  const component = await text('wasp-ui/src/StageRevealHeader.tsx');
  const styles = await text('wasp-ui/src/liquid.css');
  assert.ok(controller.includes('telepathy:reveal'));
  assert.match(component, /addEventListener\('telepathy:reveal'/);
  assert.match(component, /<h1 id="reveal-title" className="score"/);
  assert.match(component, /id="reveal-words">\{reveal\?\.words\}/);
  assert.match(component, /aria-live="polite">\{reveal\?\.count\}/);
  assert.match(styles, /\[data-phase=reveal\] \.score\[data-ready=true\] \.score__arrow-trace \{\s*animation:/);
  assert.doesNotMatch(styles, /\[data-phase=reveal\] \.timeline__row/);
});

test('the Wasp operator receipt connects to authoritative announcement status and leaves the composer mounted', async () => {
  const controller = await text('public/stage.mjs');
  const component = await text('wasp-ui/src/StageAnnouncement.tsx');
  assert.match(controller, /dispatchEvent\(new CustomEvent\('telepathy:announcement'/);
  assert.match(component, /addEventListener\('telepathy:announcement'/);
  assert.match(component, /key=\{receipt.id \+ ':' \+ row.label\}/);
  assert.match(component, /disabled=\{!view.canSend && !view.busy\}/);
});
