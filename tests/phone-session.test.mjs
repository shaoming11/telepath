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
const mic_tracks = [];
const fake_microphone = {
  async getUserMedia() {
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    mic_tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  },
};
const stored = new Map();
const seat_buttons = [];

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

const globals = {
  document: {
    visibilityState: 'visible',
    activeElement: null,
    getElementById: get_element,
    querySelectorAll: selector => (selector === '.seat' ? seat_buttons : []),
    querySelector: () => null,
    createElement: () => make_element('created'),
    addEventListener() {},
    body: make_element('body'),
  },
  window: { isSecureContext: true, scrollTo() {} },
  sessionStorage: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key),
  },
  navigator: { mediaSession: { setActionHandler(action, callback) { media_actions.set(action, callback); }, playbackState: 'none' }, mediaDevices: fake_microphone },
  AudioWorkletNode: class {
    port = { onmessage: null, postMessage() {} };
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

test.after(() => {
  restore();
  Object.defineProperty(globalThis, 'location', saved_location);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});
