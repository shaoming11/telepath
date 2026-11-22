// Drives the real public/phone.mjs against a stub DOM and a scripted hub socket. Browser-only pieces
// (layout, real Media Session, real audio output) are not covered here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorld } from './phone-fakes.mjs';

const world = createWorld();
const restore = world.install();
const elements = new Map();
const sockets = [];
const media_actions = new Map();
const document_listeners = new Map();
const mic_tracks = [];
const mic_nodes = [];
const fake_microphone = {
  async getUserMedia() {
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    mic_tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  },
};
const stored = new Map();
const seat_buttons = [];
const pro_radio = { value: 'pro', addEventListener(type, fn) { this[type] = fn; } };

function make_element(id) {
  const base = {
    id, dataset: {}, style: {}, hidden: false, textContent: '', value: '', checked: false, disabled: false,
    paused: true, ended: false, offsetWidth: 0, childElementCount: 0, children: [], className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    play: () => Promise.resolve(),
    pause() {},
    append() {},
    replaceChildren() {},
    setAttribute() {},
  };
  return new Proxy(base, {
    get: (target, prop) => (prop in target ? target[prop] : prop === 'then' || typeof prop === 'symbol' ? undefined : () => undefined),
  });
}
const get_element = id => {
  if (!elements.has(id)) elements.set(id, make_element(id));
  return elements.get(id);
};

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    sockets.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== fn); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  open() {
    this.readyState = 1;
    for (const fn of this.listeners.open ?? []) fn({});
  }
  receive(frame) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(frame) });
  }
}

for (const seat of ['A', 'B']) {
  const button = make_element('seat-' + seat);
  button.dataset.seat = seat;
  seat_buttons.push(button);
}
const settings_nav = make_element('settings-nav');
settings_nav.dataset.go = 'settings';
const fetch_asset = globalThis.fetch;

const globals = {
  document: {
    visibilityState: 'visible',
    activeElement: null,
    getElementById: get_element,
    querySelectorAll: selector => selector === '.seat' ? seat_buttons : selector === 'input[name="settings_mode"]' ? [pro_radio]
      : selector === '[data-go]' ? [settings_nav] : [],
    querySelector: () => null,
    createElement: () => make_element('created'),
    addEventListener(name, handler) { document_listeners.set(name, handler); },
    body: make_element('body'),
  },
  window: { isSecureContext: true, scrollTo() {} },
  sessionStorage: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key),
  },
  navigator: { mediaSession: { setActionHandler(action, callback) { media_actions.set(action, callback); }, playbackState: 'none' }, mediaDevices: fake_microphone },
  fetch: async (url, options) => url === '/info' ? { ok: true, json: async () => ({ voicePreview: true }) } : fetch_asset(url, options),
  AudioWorkletNode: class {
    port = { onmessage: null, postMessage() {} };
    constructor() { mic_nodes.push(this); }
    connect() {}
    disconnect() {}
  },
  WebSocket: FakeSocket,
  HTMLInputElement: class {},
  MediaMetadata: class {},
};
const saved = new Map();
for (const [name, value] of Object.entries(globals)) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const saved_location = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', {
  value: { href: 'https://hub.test/phone', search: '', protocol: 'https:', host: 'hub.test' }, configurable: true, writable: true,
});
const { STORAGE_KEY, CONSENT_KEY } = await import('../public/phone-data.mjs');
stored.set(STORAGE_KEY, JSON.stringify({
  seat: 'A', input_mode: 'real',
  setup: { voice: true, voice_kind: 'premade', earbuds: true, calibrated: true, ready: true },
}));
await import('../public/phone.mjs');

const seat_state = (pending, extra = {}) => ({
  sessionId: '1', hubId: 'hub-a', phase: 'live', preset: 'Pitch', codebook: {}, log: [], online: { A: true, B: true },
  seats: {
    A: { online: true, ready: true, mode: 2, voice: 'ready', listening: false, pending, lastIn: null, lastOut: null },
    B: { online: true, ready: true, mode: 2, voice: 'ready' },
  },
  ...extra,
});
const draft = extra => ({ id: 'draft-1', kind: 'draft', text: 'Send: hello?', decisionAt: 1000, expiresAt: 7000, ...extra });

const settle = async () => { await world.flush(); };
const CRITICAL = new Set(['signal', 'heard', 'cache_ready', 'voice', 'mic', 'setup', 'listen', 'configure', 'preset']);

let socket;
const join = async () => {
  seat_buttons[0].listeners.click[0]({});
  socket = sockets.at(-1);
  socket.open();
  return socket;
};

test('a draft that has not been heard is shown but cannot be approved until the hub reports it heard', async () => {
  assert.equal(sockets.length, 0, 'nothing connects before a seat is chosen');
  await join();
  assert.match(socket.url, /role=seat&seat=A/);
  socket.receive({ type: 'state', state: seat_state(draft()) });
  await settle();
  assert.equal(get_element('live-draft').hidden, false);
  assert.equal(get_element('draft-send').disabled, true);
  socket.receive({ type: 'state', state: seat_state(draft({ heardAt: 1800, expiresAt: 7800 })) });
  await settle();
  assert.equal(get_element('draft-send').disabled, false);
});

test('earbud recovery returns on Live after voice setup without blocking the voice choice', () => {
  const anchor = get_element('keepalive');
  const banner = get_element('banner');
  anchor.listeners.pause[0]();
  assert.equal(banner.hidden, false);
  assert.match(get_element('banner-text').textContent, /Earbud controls stopped/);

  get_element('settings-voice').listeners.click[0]();
  assert.equal(banner.hidden, true);
  assert.equal(get_element('voice-skip').disabled, false);

  get_element('nav-back').listeners.click[0]();
  get_element('nav-back').listeners.click[0]();
  assert.equal(banner.hidden, false);
  assert.equal(get_element('banner-action').textContent, 'Wake');
  anchor.listeners.playing[0]();
  assert.equal(banner.hidden, true);
});

test('the draft clock restarts on playback and disables approval at the hub deadline', async () => {
  const start = Date.now();
  const preview = draft({ id: 'clock-test', decisionAt: start, heardAt: null, expiresAt: start + 4500 });
  socket.receive({ type: 'state', state: seat_state(preview, { serverNow: start }) });
  await settle();
  assert.equal(get_element('live-draft-time').textContent, 'Waiting for preview');
  assert.equal(get_element('draft-send').disabled, true);
  world.advance(2200);
  const heard = Date.now();
  socket.receive({ type: 'state', state: seat_state({ ...preview, heardAt: heard, expiresAt: heard + 6000 }, { serverNow: heard }) });
  await settle();
  assert.equal(get_element('live-draft-time').textContent, '6 s');
  assert.equal(get_element('live-draft-clock').style.transition, 'transform 6000ms linear');
  assert.equal(get_element('draft-send').disabled, false);
  world.advance(3001);
  await settle();
  assert.equal(get_element('live-draft-time').textContent, '3 s');
  world.advance(3000);
  await settle();
  assert.equal(get_element('live-draft-time').textContent, 'Expired');
  assert.equal(get_element('draft-send').disabled, true);
});

test('repeated discard clicks target the same draft and never become a codebook gesture', async () => {
  socket.receive({ type: 'state', state: seat_state(draft({ id: 'current-preview' })) });
  await settle();
  socket.sent.length = 0;
  get_element('draft-discard').listeners.click[0]();
  get_element('draft-discard').listeners.click[0]();
  world.advance(1300);
  await settle();
  const signals = socket.sent.filter(frame => frame.type === 'signal');
  assert.deepEqual(signals.map(frame => [frame.signal, frame.draftId]), [['L1', 'current-preview'], ['L1', 'current-preview']]);
});

test('a draft whose clearing state never arrives still leaves the screen', async () => {
  socket.receive({ type: 'state', state: seat_state(draft({ id: 'draft-9', heardAt: 1800, expiresAt: 7800 })) });
  await settle();
  assert.equal(get_element('live-draft').hidden, false);
  world.advance(6000 + 1600);
  await settle();
  assert.equal(get_element('live-draft').hidden, true, 'the locally expired draft is removed');
  socket.receive({ type: 'state', state: seat_state(null) });
  socket.receive({ type: 'state', state: seat_state(draft({ id: 'draft-10' })) });
  await settle();
  assert.equal(get_element('live-draft').hidden, false, 'a later draft appears normally');
});

test('every critical frame sent after the first state carries the session and hub it was made for', async () => {
  const scoped = socket.sent.filter(frame => CRITICAL.has(frame.type));
  assert.ok(scoped.length >= 2);
  for (const frame of scoped) assert.deepEqual([frame.sessionId, frame.hubId], ['1', 'hub-a'], frame.type);
});

test('a different hubId under the same sessionId is treated as a reset and re-configures the seat', async () => {
  await join();
  socket.receive({ type: 'state', state: seat_state(null) });
  await settle();
  socket.sent.length = 0;
  socket.receive({ type: 'state', state: seat_state(null, { hubId: 'hub-b' }) });
  await settle();
  const configure = socket.sent.find(frame => frame.type === 'configure');
  assert.ok(configure, 'the seat reconciles against the new hub');
  assert.deepEqual([configure.sessionId, configure.hubId], ['1', 'hub-b']);
});

test('a manifest the hub sends before the first state of a reconnect is acknowledged for that hub', async () => {
  world.durations['https://hub.test/assets/fixed.mp3'] = 1;
  await join();
  socket.receive({
    type: 'cache', activeId: 'cache-7', sessionId: '1', hubId: 'hub-c',
    items: [{ key: 'A:Pitch:R1', url: '/assets/fixed.mp3' }],
  });
  await settle();
  assert.equal(socket.sent.some(frame => frame.type === 'cache_ready'), false, 'not acknowledged before the hub identifies itself');
  socket.receive({ type: 'state', state: seat_state(null, { hubId: 'hub-c' }) });
  await settle();
  const ready = socket.sent.find(frame => frame.type === 'cache_ready');
  assert.ok(ready, 'the early manifest is processed once the first state arrives');
  assert.equal(ready.activeId, 'cache-7');
  assert.deepEqual([ready.sessionId, ready.hubId], ['1', 'hub-c']);
});

test('a manifest tagged for another hub is dropped after the first state', async () => {
  socket.sent.length = 0;
  socket.receive({ type: 'cache', activeId: 'cache-8', hubId: 'hub-old', items: [{ key: 'A:Pitch:R1', url: '/assets/fixed.mp3' }] });
  await settle();
  assert.equal(socket.sent.some(frame => frame.type === 'cache_ready'), false);
});

test('the first Media Session tap binds the gesture to the draft and codebook before recognition', async () => {
  const old_state = seat_state(draft({ id: 'old-draft', heardAt: Date.now(), expiresAt: Date.now() + 6000 }), { cacheId: 'pitch-cache' });
  socket.receive({ type: 'state', state: old_state });
  await settle();
  socket.sent.length = 0;
  media_actions.get('nexttrack')();
  world.advance(360);
  socket.receive({ type: 'state', state: seat_state(draft({ id: 'other-draft', heardAt: Date.now(), expiresAt: Date.now() + 6000 }), { preset: 'Party', cacheId: 'party-cache' }) });
  world.advance(900);
  await settle();
  const signal = socket.sent.find(frame => frame.type === 'signal');
  assert.equal(signal?.draftId, 'old-draft');
  assert.equal(signal.cacheId, 'pitch-cache');
});

test('a receipt gesture does not become an approval when a new draft appears mid-pattern', async () => {
  const stage_time = Date.now();
  const base = seat_state(null, { cacheId: 'pitch-cache' });
  base.seats.A.receipt = { messageId: 'inbound-1', until: stage_time + 4000 };
  socket.receive({ type: 'state', state: base });
  socket.sent.length = 0;
  media_actions.get('nexttrack')();
  world.advance(260);
  socket.receive({ type: 'state', state: seat_state(draft({ id: 'new-draft', heardAt: stage_time + 300, expiresAt: stage_time + 6300 }), { cacheId: 'pitch-cache' }) });
  world.advance(1010);
  await settle();
  const signal = socket.sent.find(frame => frame.type === 'signal');
  assert.equal(signal?.draftId, null);
  assert.equal(signal.receiptId, 'inbound-1');
});

test('a receipt binds its press time to the first media event before recognition closes', async () => {
  const serverNow = Date.now();
  const base = seat_state(null, { cacheId: 'pitch-cache', serverNow });
  base.seats.A.receipt = { messageId: 'almost-expired', until: serverNow + 4000 };
  socket.receive({ type: 'state', state: base });
  socket.sent.length = 0;
  world.advance(3950);
  media_actions.get('nexttrack')();
  world.advance(1300);
  await settle();
  const signal = socket.sent.find(frame => frame.type === 'signal');
  assert.equal(signal?.receiptId, 'almost-expired');
  assert.equal(signal.receiptPressedAt, serverNow + 3950);
  assert.equal(get_element('live-acknowledge').hidden, true);
});

test('triple Next Track discards the unheard draft captured by the first press', async () => {
  const now = Date.now();
  socket.receive({ type: 'state', state: seat_state(draft({ id: 'preview-loading', heardAt: null, expiresAt: now + 5000 })) });
  await settle();
  socket.sent.length = 0;
  media_actions.get('nexttrack')();
  world.advance(340);
  media_actions.get('nexttrack')();
  world.advance(340);
  media_actions.get('nexttrack')();
  world.advance(1210);
  await settle();
  const signals = socket.sent.filter(frame => frame.type === 'signal');
  assert.deepEqual(signals.map(frame => [frame.signal, frame.draftId]), [['L1', 'preview-loading']]);
});

test('the on-screen signal labels, draft approval and acknowledgement act independently', async () => {
  const now = Date.now();
  const state = seat_state(draft({ id: 'preview-heard', heardAt: now, expiresAt: now + 6000 }));
  state.seats.A.receipt = { messageId: 'private-in', until: now + 4500 };
  socket.receive({ type: 'state', state });
  await settle();
  const click_signal = signal => get_element('signals').listeners.click[0]({
    target: { closest: () => ({ disabled: false, dataset: { signal } }) },
  });
  socket.sent.length = 0;
  click_signal('R1');
  click_signal('L1');
  click_signal('L1');
  assert.equal(get_element('live-acknowledge').hidden, false);
  get_element('live-acknowledge').listeners.click[0]();
  get_element('draft-send').listeners.click[0]();
  const frames = () => socket.sent.filter(frame => frame.type === 'signal');
  const before = frames().map(frame => [frame.signal, frame.draftId, frame.receiptId]);
  assert.deepEqual(before, [
    ['R1', null, null], ['L1', null, null], ['R1', null, 'private-in'], ['R1', 'preview-heard', 'private-in'],
  ]);
  world.advance(4501);
  await settle();
  assert.equal(get_element('live-acknowledge').hidden, true);
  get_element('live-acknowledge').listeners.click[0]();
  assert.equal(frames().length, 4);
});

test('a tap without a hub acknowledgement gets a local buzz and is never retried', async () => {
  socket.receive({ type: 'state', state: seat_state(null) });
  socket.sent.length = 0;
  media_actions.get('nexttrack')();
  world.advance(1210);
  await settle();
  assert.equal(socket.sent.filter(frame => frame.type === 'signal').length, 1);
  world.advance(2100);
  await settle();
  assert.match(get_element('live-note').textContent, /confirm.*signal/i);
  assert.equal(socket.sent.filter(frame => frame.type === 'signal').length, 1);
});

test('a transport acknowledgement prevents an erroneous retry cue', async () => {
  socket.receive({ type: 'state', state: seat_state(null) });
  socket.sent.length = 0;
  media_actions.get('nexttrack')();
  world.advance(1210);
  const signal = socket.sent.find(frame => frame.type === 'signal');
  socket.receive({ type: 'signal_ack', id: signal.id, accepted: true, sessionId: '1', hubId: 'hub-a' });
  world.advance(6500);
  await settle();
  assert.equal(get_element('live-note').textContent, '');
  assert.equal(socket.sent.filter(frame => frame.type === 'signal').length, 1);
});

test('Reveal releases the physical mic and the next take resumes previously consented capture', async () => {
  stored.set(CONSENT_KEY, '1');
  await join();
  socket.receive({ type: 'state', state: seat_state(null) });
  await settle();
  assert.equal(mic_tracks.at(-1)?.readyState, 'live');
  const current = mic_tracks.at(-1);
  socket.receive({ type: 'state', state: seat_state(null, { phase: 'reveal' }) });
  await settle();
  assert.equal(current.readyState, 'ended');
  assert.ok(socket.sent.some(frame => frame.type === 'listen' && !frame.enabled));
  socket.receive({ type: 'state', state: seat_state(null, { phase: 'lobby', sessionId: '2' }) });
  await settle();
  assert.notEqual(mic_tracks.at(-1), current);
  assert.equal(mic_tracks.at(-1).readyState, 'live');
});

test('Mac input releases the phone room microphone and leaves approval controls available', async () => {
  const current = mic_tracks.at(-1);
  socket.sent.length = 0;
  socket.receive({ type: 'state', state: seat_state(draft({ heardAt: 1800, expiresAt: 999999 }), {
    roomInput: 'mac', room: { listening: true, transcription: 'live' },
  }) });
  await settle();
  assert.equal(current.readyState, 'ended');
  assert.match(get_element('live-listen-text').textContent, /Mac listening/);
  assert.equal(get_element('draft-send').disabled, false);
  assert.equal(socket.sent.some(frame => frame.type === 'listen' && frame.enabled), false);
  const count = mic_tracks.length;
  socket.receive({ type: 'state', state: seat_state(null, { roomInput: 'mac', room: { transcription: 'off' }, phase: 'lobby', sessionId: '3' }) });
  await settle();
  assert.equal(mic_tracks.length, count);
});

test('Mac-only voice consent never grants the phone permission to listen to the room', async () => {
  socket.receive({ type: 'state', state: seat_state(null, { roomInput: 'mac', sessionId: '3' }) });
  get_element('settings-voice').listeners.click[0]();
  await settle();
  assert.match(get_element('voice-consent-text').textContent, /temporary clone/);
  assert.equal(get_element('voice-room').hidden, true);
  const captured = mic_tracks.length;
  get_element('voice-consent').listeners.change[0]({ target: { checked: true } });
  get_element('voice-room').listeners.click[0]();
  await settle();
  assert.equal(stored.get(CONSENT_KEY), 'voice');
  assert.equal(mic_tracks.length, captured);

  socket.receive({ type: 'state', state: seat_state(null, { roomInput: 'phones', sessionId: '3' }) });
  get_element('settings-listen').listeners.change[0]({ target: { checked: true } });
  await settle();
  assert.match(get_element('voice-consent-text').textContent, /listen to this room/);
  assert.equal(get_element('voice-consent').checked, false);
  assert.equal(get_element('voice-room').hidden, false);
  assert.equal(mic_tracks.length, captured);
  socket.receive({ type: 'state', state: seat_state(null, { roomInput: 'mac', sessionId: '3' }) });
});

test('a rejected clone stays on the voice screen with the provider reason and a retry', async () => {
  get_element('settings-voice').listeners.click[0]();
  get_element('voice-record').listeners.click[0]();
  await settle();
  mic_nodes.at(-1).port.onmessage({ data: { pcm: new Int16Array(480_000).fill(1000).buffer, level: 0.2 } });
  await settle();
  const upload = socket.sent.findLast(frame => frame.type === 'voice');
  assert.ok(upload?.requestId);
  assert.match(get_element('voice-status').textContent, /uploading/i);
  assert.equal(get_element('voice-record').disabled, true);
  assert.equal(mic_tracks.at(-1).readyState, 'ended', 're-recording releases the phone mic');
  socket.receive({
    type: 'voice_status', status: 'fallback', requestId: upload.requestId,
    detail: 'ElevenLabs requires voice verification.',
  });
  world.advance(20);
  await settle();
  assert.equal(get_element('voice-status').textContent, 'ElevenLabs requires voice verification.');
  assert.equal(get_element('voice-record').disabled, false);
  stored.set(CONSENT_KEY, '1');
});

test('AirPods 1 calibration releases mic capture until leaving setup', async () => {
  socket.receive({ type: 'state', state: seat_state(null, { phase: 'lobby', sessionId: '2' }) });
  get_element('settings-listen').listeners.change[0]({ target: { checked: true } });
  await settle();
  const before = mic_tracks.at(-1);
  assert.equal(before.readyState, 'live');
  get_element('settings-calibrate').listeners.click[0]();
  get_element('cal-quick-start').listeners.click[0]();
  await settle();
  assert.equal(before.readyState, 'ended');
  media_actions.get('nexttrack')();
  assert.equal(get_element('cal-quick-nexttrack').textContent, 'Next Track received');
  get_element('cal-skip').listeners.click[0]();
  await settle();
  assert.notEqual(mic_tracks.at(-1), before);
  assert.equal(mic_tracks.at(-1).readyState, 'live');
});

test('keyboard clicker signals work on focused buttons while the phone mic stays open', async () => {
  socket.receive({ type: 'state', state: seat_state(null, { phase: 'live', sessionId: '2' }) });
  get_element('nav-back').listeners.click[0]();
  await settle();
  const mic = mic_tracks.at(-1);
  assert.equal(mic.readyState, 'live');
  const before = socket.sent.length;
  const focusedButton = { closest: selector => selector.includes('button') ? focusedButton : null };
  document_listeners.get('keydown')({ key: 'PageDown', preventDefault() {}, target: focusedButton });
  assert.ok(socket.sent.slice(before).some(frame => frame.type === 'signal' && frame.signal === 'R1'));
  assert.equal(mic.readyState, 'live');
});

test('both AirPods profiles toggle question mode with one press and retain receipt and approval priority', async () => {
  const settings = { pitchHelp: true, questionModeAvailable: true, roomInput: 'mac', sessionId: '2' };
  const base = seat_state(null, settings);
  const sent = () => socket.sent.filter(frame => frame.type === 'signal');
  socket.receive({ type: 'state', state: base });
  await settle();
  socket.sent.length = 0;
  media_actions.get('nexttrack')();
  world.advance(1200);
  await settle();
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].purpose, 'question_mode');

  pro_radio.change();
  socket.sent.length = 0;
  media_actions.get('pause')();
  assert.equal(sent()[0]?.purpose, 'question_mode');
  media_actions.get('previoustrack')();
  assert.equal(sent().at(-1)?.signal, 'L1');
  assert.equal(sent().at(-1)?.purpose, undefined);

  base.seats.A.receipt = { messageId: 'receipt-help', until: Date.now() + 4000 };
  socket.receive({ type: 'state', state: base });
  media_actions.get('play')();
  assert.equal(sent().at(-1)?.receiptId, 'receipt-help');
  assert.equal(sent().at(-1)?.purpose, undefined);

  const pending = draft({ id: 'pitch-approved', heardAt: Date.now(), expiresAt: Date.now() + 6000 });
  socket.receive({ type: 'state', state: seat_state(pending, settings) });
  media_actions.get('pause')();
  assert.equal(sent().at(-1)?.draftId, 'pitch-approved');
  assert.equal(sent().at(-1)?.purpose, undefined);
});

test('the live screen keeps the private cue visible until the hub clears it', async () => {
  const state = seat_state(null, { sessionId: '2' });
  state.seats.A.lastPitchCue = { text: 'Phone catches taps.', points: ['Safari sends a browser event.'] };
  socket.receive({ type: 'state', state });
  await settle();
  assert.equal(get_element('live-pitch-notes').hidden, false);
  assert.equal(get_element('live-pitch-cue').textContent, 'Phone catches taps.');
  socket.receive({ type: 'state', state: seat_state(null, { sessionId: '2' }) });
  await settle();
  assert.equal(get_element('live-pitch-notes').hidden, true);
});

test('voice Settings offers a clone preview only after the hub confirms a clone', async () => {
  const premade = seat_state(null, { roomInput: 'mac', sessionId: '2' });
  premade.seats.A.voice = 'fallback';
  socket.receive({ type: 'state', state: premade });
  settings_nav.listeners.click[0]();
  await settle();
  assert.equal(get_element('settings-voice').textContent, 'Record my voice');
  assert.equal(get_element('settings-voice-preview').hidden, true);
  socket.receive({ type: 'state', state: seat_state(null, { roomInput: 'mac', sessionId: '2' }) });
  await settle();
  assert.equal(get_element('settings-voice').textContent, 'Re-record voice');
  assert.equal(get_element('settings-voice-preview').hidden, false);
});

test('a playback report accepted by the socket is retried until the current hub echoes it', async () => {
  const scope = { sessionId: '2', hubId: 'hub-a' };
  const messageId = 'announcement-playback-report';
  socket.receive({ type: 'state', state: seat_state(null, scope) });
  socket.sent.length = 0;
  socket.receive({ ...scope, type: 'audio', kind: 'announcement', cue: 'system', messageId,
    url: '/assets/report.mp3', expiresAfterMs: 8000 });
  await settle();
  world.advance(1600);
  const reports = () => socket.sent.filter(frame => frame.type === 'heard' && frame.messageId === messageId);
  assert.ok(reports().length > 1, 'the socket accepted the first report but the hub did not echo it');
  assert.ok(reports().every(frame => frame.sessionId === scope.sessionId && frame.hubId === scope.hubId));

  const starts = () => world.contexts[0].started().filter(source => source.buffer?.url?.endsWith('/report.mp3')).length;
  assert.equal(starts(), 1, 'a single announcement starts');
  const report_count = reports().length;
  socket.receive({ ...scope, type: 'heard_ack', messageId, hubId: 'old-hub' });
  world.advance(300);
  assert.ok(reports().length > report_count, 'an echo from another hub cannot clear the report');

  socket.receive({ ...scope, type: 'heard_ack', messageId });
  const confirmed_count = reports().length;
  world.advance(1000);
  assert.equal(reports().length, confirmed_count);
  assert.equal(starts(), 1, 'a report retry does not replay audio');
});

test('a full hub reset clears previously ready setup and returns the seat to Voice', async () => {
  assert.equal(JSON.parse(stored.get(STORAGE_KEY)).setup.ready, true);
  const reset = seat_state(null, { phase: 'lobby', sessionId: '3', setupReset: '3' });
  reset.seats.A = { online: true, ready: false, mode: 2, voice: 'idle', calibrated: false };
  socket.sent.length = 0;
  socket.receive({ type: 'state', state: reset });
  world.advance(20);
  await settle();
  assert.equal(JSON.parse(stored.get(STORAGE_KEY)).setup.ready, false);
  assert.equal(stored.has(CONSENT_KEY), false);
  assert.match(get_element('voice-status').textContent, /set up your voice/i);
  assert.ok(!socket.sent.some(frame => frame.type === 'setup' && frame.complete));
});

test.after(() => {
  restore();
  Object.defineProperty(globalThis, 'location', saved_location);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});
