import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { bytes_to_base64, createCapture, encode_wav, PCM_RATE } from '../public/capture.mjs';
import { createWorld, deferred } from './phone-fakes.mjs';

let world;
let restore;
let restore_globals;
let media;
let nodes;
let states;

function fake_track() {
  return { stopped: false, stop() { this.stopped = true; }, onended: null, onmute: null, onunmute: null };
}

function fake_stream() {
  const track = fake_track();
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

beforeEach(() => {
  world = createWorld();
  restore = world.install();
  nodes = [];
  states = [];
  media = { calls: [], gates: [] };
  const saved = new Map();
  const set = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  set('navigator', {
    mediaDevices: {
      getUserMedia: constraints => {
        media.calls.push(constraints);
        const gate = deferred();
        media.gates.push(gate);
        return gate.promise;
      },
    },
    audioSession: { type: 'auto' },
  });
  set('AudioWorkletNode', class {
    constructor() {
      this.port = { onmessage: null, posted: [], postMessage(message) { this.posted.push(message); } };
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  });
  restore_globals = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
});
afterEach(() => {
  restore_globals();
  restore();
});

function make_capture(extra = {}) {
  const frames = [];
  const capture = createCapture({
    get_context: () => globalThis.__context ??= new globalThis.AudioContext(),
    frame_ms: () => 250,
    on_frame: frame => frames.push(frame),
    on_state: (status, detail) => states.push([status, detail]),
    ...extra,
  });
  return { capture, frames };
}

afterEach(() => { delete globalThis.__context; });

test('stage capture can select the built-in microphone and enable room echo cancellation', async () => {
  const constraints = { audio: { deviceId: { exact: 'mac-built-in' }, echoCancellation: true } };
  const { capture } = make_capture({ get_constraints: () => constraints });
  const starting = capture.start();
  const stream = fake_stream();
  stream.track.label = 'MacBook Microphone';
  media.gates[0].resolve(stream);
  assert.equal(await starting, true);
  assert.deepEqual(media.calls[0], constraints);
  assert.equal(capture.deviceLabel, 'MacBook Microphone');
  capture.stop();
  assert.equal(stream.track.stopped, true);
});

test('stop during the permission prompt leaves no open microphone behind', async () => {
  const { capture } = make_capture();
  const starting = capture.start();
  assert.equal(capture.opening, true);
  capture.stop();
  const stream = fake_stream();
  media.gates[0].resolve(stream);
  assert.equal(await starting, false);
  assert.equal(stream.track.stopped, true, 'the late stream is released');
  assert.equal(nodes.length, 0, 'no audio graph is built for a cancelled open');
  assert.equal(capture.open, false);
  assert.equal(capture.status, 'idle');
});

test('start after a stop that raced an open performs a fresh open', async () => {
  const { capture } = make_capture();
  const first = capture.start();
  capture.stop();
  const second = capture.start();
  const stale = fake_stream();
  media.gates[0].resolve(stale);
  assert.equal(await first, false);
  await world.flush();
  assert.equal(media.calls.length, 2, 'a second getUserMedia was issued');
  const live = fake_stream();
  media.gates[1].resolve(live);
  assert.equal(await second, true);
  assert.equal(stale.track.stopped, true);
  assert.equal(live.track.stopped, false);
  assert.equal(capture.open, true);
  assert.equal(capture.status, 'streaming');
});

test('a refused permission reports blocked without leaving a stream', async () => {
  const { capture } = make_capture();
  const starting = capture.start();
  media.gates[0].reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
  assert.equal(await starting, false);
  assert.deepEqual(states.at(-1), ['blocked', 'Microphone permission was refused.']);
  assert.equal(capture.open, false);
});

test('an ended track fails an in-flight recording and reports a lost microphone', async () => {
  const { capture } = make_capture();
  const starting = capture.start();
  const stream = fake_stream();
  media.gates[0].resolve(stream);
  await starting;
  const recording = capture.record({ duration_ms: 1000 });
  stream.track.onended();
  await assert.rejects(recording, /Microphone stopped/);
  assert.equal(capture.status, 'lost');
  assert.equal(capture.open, false);
});

test('unmuting resumes an interrupted audio context before streaming continues', async () => {
  const { capture } = make_capture();
  const starting = capture.start();
  const stream = fake_stream();
  media.gates[0].resolve(stream);
  await starting;
  const context = world.contexts[0];
  stream.track.onmute();
  context.set_state('interrupted');
  assert.equal(capture.status, 'interrupted');
  stream.track.onunmute();
  assert.equal(capture.status, 'streaming');
  context.allow_resume();
  await world.flush();
  assert.equal(context.state, 'running');
});

test('recording trims to the requested sample count and encodes a valid mono WAV', async () => {
  const { capture, frames } = make_capture();
  const starting = capture.start();
  media.gates[0].resolve(fake_stream());
  await starting;
  const progress = [];
  const recording = capture.record({ duration_ms: 500, on_progress: value => progress.push(value) });
  const target = PCM_RATE / 2;
  const chunk = size => new Int16Array(size).fill(1000).buffer;
  nodes[0].port.onmessage({ data: { pcm: chunk(5000), level: 0.2 } });
  nodes[0].port.onmessage({ data: { pcm: chunk(5000), level: 1.7 } });
  const result = await recording;
  assert.equal(result.samples, target);
  assert.equal(result.duration_ms, 500);
  assert.equal(progress.at(-1), 1);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].level, 1, 'the live level is clamped for the hub');
  const wav = Buffer.from(result.wav, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), PCM_RATE);
  assert.equal(wav.readUInt32LE(40), target * 2);
  assert.equal(wav.length, 44 + target * 2);
  assert.equal(capture.recording, false);
});

test('base64 and WAV helpers handle large buffers and empty input', () => {
  const big = new Uint8Array(0x6000 * 3 + 5).map((_, index) => index % 251);
  assert.deepEqual(new Uint8Array(Buffer.from(bytes_to_base64(big), 'base64')), big);
  assert.equal(encode_wav([]).length, 44);
});

test('a recording rejects if the microphone never supplies PCM', async () => {
  const { capture } = make_capture();
  const started = capture.start();
  media.gates[0].resolve(fake_stream());
  await started;
  const rejected = assert.rejects(capture.record({ duration_ms: 500 }), /stopped delivering audio/);
  world.advance(11_000);
  await rejected;
  assert.equal(capture.recording, false);
});

test('adaptive capture ignores silence and clipped frames and can finish on usable speech', async () => {
  const { capture } = make_capture();
  const started = capture.start();
  media.gates[0].resolve(fake_stream());
  await started;
  const updates = [];
  const result = capture.record({ speech_ms: 24_000, on_progress: (_, data) => updates.push(data) });
  const feed = (seconds, sample, level) => nodes[0].port.onmessage({
    data: { pcm: new Int16Array(seconds * PCM_RATE).fill(sample).buffer, level },
  });
  feed(4, 0, 0);
  feed(2, 32767, 0.9);
  assert.equal(updates.at(-1).seconds, 0);
  assert.equal(updates.at(-1).clipped, true);
  assert.equal(capture.finish_record(), false);
  feed(8, 1800, 0.06);
  feed(5, 0, 0);
  feed(7, 1600, 0.05);
  assert.equal(updates.at(-1).seconds, 15);
  assert.equal(capture.finish_record(), true);
  assert.equal((await result).duration_ms, 15_160);
});
