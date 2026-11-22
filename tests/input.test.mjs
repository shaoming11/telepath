import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createEmulator, createMediaInput, DEFAULT_EMULATOR, DEFAULT_TIMING, recognize, touchSettings, tuneCalibration } from '../public/input.mjs';
import { createNetworkLink } from '../public/network.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./tap-fixtures.json', import.meta.url)));

function clock() {
  const events = new Map();
  let sequence = 0;
  let time = 0;
  return {
    now: () => time,
    setTimer(fn, delay) {
      events.set(++sequence, { at: time + delay, fn });
      return sequence;
    },
    clearTimer(id) { events.delete(id); },
    advance(at) {
      for (;;) {
        const next = [...events].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > at) break;
        events.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = at;
    },
  };
}

for (const trace of FIXTURES.traces) {
  test(trace.label, () => {
    const timer = clock();
    const signals = [];
    const errors = [];
    const input = createMediaInput({ ...timer, mode: trace.mode, onSignal: signal => signals.push(signal), onError: event => errors.push(event) });
    for (const [action, at] of trace.events) {
      timer.advance(at);
      input.dispatch(action);
    }
    timer.advance(timer.now() + 1201);
    assert.deepEqual(signals, trace.signals);
    assert.equal(errors.length, trace.errors ?? 0);
  });
}

test('simulated track callbacks and Safari Media Session actions reach the same recognizer', () => {
  const timer = clock();
  const signals = [];
  const raw = [];
  const handlers = {};
  const input = createMediaInput({ ...timer, onRaw: event => raw.push(event), onSignal: signal => signals.push(signal) });
  input.register({ setActionHandler(name, fn) { handlers[name] = fn; } });
  handlers.nexttrack();
  timer.advance(1300);
  const emu = createEmulator({ ...timer, input, settings: { delayMs: 70, jitterMs: 0, doubleRate: 1, missRate: 0 } });
  emu.signal('R1', 2);
  timer.advance(2900);
  handlers.pause();
  emu.gesture('play');
  timer.advance(3600);
  assert.deepEqual(signals, ['R1', 'R1', 'OUT', 'BACK']);
  assert.equal(raw.filter(event => event.action === 'nexttrack').length, 3);
  assert.equal(emu.stats.doubled, 2);
  emu.configure({ missRate: 1 });
  emu.signal('R2', 2);
  timer.advance(5600);
  assert.equal(emu.stats.missed, 2);
  assert.equal(signals.length, 4);
});

test('fast, slow and mixed intervals classify across emulator jitter ranges', () => {
  for (let seed = 1; seed <= 55; seed++) {
    const timer = clock();
    const signals = [];
    const input = createMediaInput({ ...timer, onSignal: signal => signals.push(signal) });
    const ranges = { seed, delayMs: 55 + seed, jitterMs: 30 + (seed % 18), missRate: 0, doubleRate: 1 };
    const emu = createEmulator({ ...timer, input, settings: ranges });
    for (const mode of [1, 2]) {
      input.configure({ mode });
      for (const signal of mode === 1 ? ['R1', 'R2', 'L2', 'LR', 'OUT', 'BACK'] : ['R1', 'R2', 'L1', 'L2', 'LR', 'OUT', 'BACK']) {
        emu.signal(signal, mode);
        timer.advance(timer.now() + 2500);
        assert.equal(signals.pop(), signal, 'mode ' + mode + ' seed ' + seed);
      }
    }
  }
});

test('AirPods 1 groups Next Track across the personal timing window without checking side', () => {
  const timer = clock();
  const handlers = {};
  const signals = [];
  const input = createMediaInput({ ...timer, gestureModel: 'next-only', onSignal: signal => signals.push(signal) });
  input.register({ setActionHandler(action, callback) { handlers[action] = callback; } });
  input.configure({ timing: { countWindowMs: 1700 } });
  handlers.nexttrack();
  timer.advance(1450);
  handlers.nexttrack();
  timer.advance(2400);
  handlers.nexttrack();
  timer.advance(4100);
  assert.deepEqual(signals, ['L1']);
  handlers.previoustrack();
  timer.advance(5000);
  handlers.nexttrack();
  timer.advance(5800);
  handlers.nexttrack();
  timer.advance(7500);
  assert.deepEqual(signals, ['L1', 'R2']);
});

test('AirPods Pro maps media commands immediately to squeeze counts', () => {
  const handlers = {};
  const seen = [];
  const input = createMediaInput({ gestureModel: 'pro', onSignal: (signal, trace) => seen.push([signal, trace[0].squeeze]) });
  input.register({ setActionHandler(action, callback) { handlers[action] = callback; } });
  handlers.pause();
  handlers.nexttrack();
  handlers.previoustrack();
  assert.deepEqual(seen, [['R1', true], ['R2', true], ['L1', true]]);
});

test('personal timing uses a median and a margin above the measured gaps', () => {
  const make = (signal, times) => ({
    signal, gestureModel: 'next-only', mode: 2, promptAt: 0,
    events: times.map(at => ({ action: 'nexttrack', at })),
  });
  const { timing, metrics } = tuneCalibration([make('R2', [380, 1080]), make('L1', [380, 1180, 2090])]);
  assert.equal(timing.countMedianMs, 800);
  assert.equal(timing.countWindowMs, 1130);
  assert.equal(metrics.missed, 0);
});

test('calibration estimates duplicate, miss and inter-tap values from timestamps', () => {
  const profile = tuneCalibration([
    { mode: 2, signal: 'R2', promptAt: 0, events: [{ action: 'nexttrack', at: 380 }, { action: 'nexttrack', at: 431 }, { action: 'nexttrack', at: 739 }] },
    { mode: 2, signal: 'R2', promptAt: 1500, events: [{ action: 'nexttrack', at: 1910 }, { action: 'nexttrack', at: 2310 }] },
    { mode: 1, signal: 'L2', promptAt: 3500, events: [{ action: 'nexttrack', at: 3810 }, { action: 'nexttrack', at: 4590 }] },
    { mode: 2, signal: 'L1', promptAt: 6000, events: [] },
  ]);
  assert.equal(profile.metrics.missed, 1);
  assert.equal(profile.metrics.duplicates, 1);
  assert.equal(profile.emulator.fastGapMs, 380);
  assert.equal(profile.emulator.slowGapMs, 780);
  assert.notEqual(profile.emulator.jitterMs, DEFAULT_EMULATOR.jitterMs);
  assert.equal(profile.emulator.delayMs, DEFAULT_EMULATOR.delayMs, 'prompt response does not measure Bluetooth air latency');
});

test('network loss adds delay, retries preserve order and never duplicate delivery', () => {
  const calls = [];
  const timer = clock();
  const random = [0.5, 0.01, 0.8, 0.5, 0.8][Symbol.iterator]();
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.send = payload => calls.push([timer.now(), JSON.parse(payload).id]);
  const link = createNetworkLink(socket, { ...timer, enabled: true, random: () => random.next().value ?? 0.9, delayMs: 30, jitterMs: 0, retryMs: 100, dropRate: 0.1 });
  link.send({ id: 1 });
  link.send({ id: 2 });
  timer.advance(129);
  assert.deepEqual(calls, []);
  timer.advance(131);
  assert.deepEqual(calls, [[130, 1], [130, 2]]);
  assert.equal(link.stats.dropped, 1);
  assert.equal(link.stats.retried, 1);
  assert.equal(link.stats.delivered, 2);
});

test('calibration leaves a rejection gap between overlapping one-ear double-tap patterns', () => {
  const taps = gap => [{ action: 'nexttrack', at: 100 }, { action: 'nexttrack', at: gap + 100 }];
  const trials = [490, 510, 530].map(gap => ({ mode: 1, signal: 'R2', events: taps(gap) }))
    .concat([560, 590, 620].map(gap => ({ mode: 1, signal: 'L2', events: taps(gap) })));
  const { timing } = tuneCalibration(trials);
  assert.equal(recognize(taps(540), 1, timing), null, 'uncertain pauses cannot become a fixed send');
  assert.equal(recognize(taps(540), 2, timing), 'R2', 'ordinary two-ear timing has no slow-R ambiguity');
  assert.equal(recognize(taps(475), 1, timing), 'R2');
  assert.equal(recognize(taps(650), 1, timing), 'L2');
});

test('named one-ear touch controls generate valid timings inside the calibrated bands', () => {
  const timer = clock();
  const signals = [];
  const timing = { ...DEFAULT_TIMING, oneEarFastMaxMs: 420, slowMinMs: 600, slowMaxMs: 810 };
  const device = { ...DEFAULT_EMULATOR, fastGapMs: 500, slowGapMs: 520, jitterMs: 40, missRate: 0.2 };
  const input = createMediaInput({ ...timer, mode: 1, timing, onSignal: signal => signals.push(signal) });
  const emu = createEmulator({ ...timer, input, settings: touchSettings(timing, device, 1) });
  for (const signal of ['R2', 'L2', 'LR']) {
    emu.signal(signal, 1);
    timer.advance(timer.now() + 2500);
  }
  assert.deepEqual(signals, ['R2', 'L2', 'LR']);
});

test('browser timer batching cannot turn an emulated two-event pattern into one tap', () => {
  const raw = [];
  const signals = [];
  const callbacks = [];
  let now = 0;
  const input = createMediaInput({
    now: () => now, setTimer: () => 0, clearTimer() {},
    onRaw: event => raw.push(event), onSignal: signal => signals.push(signal),
  });
  const emu = createEmulator({
    input, now: () => now,
    settings: { delayMs: 70, jitterMs: 0, missRate: 0, doubleRate: 0, fastGapMs: 330 },
    setTimer(fn) { callbacks.push(fn); return callbacks.length; },
  });
  emu.signal('R2', 2);
  now = 1000;
  callbacks.forEach(fn => fn());
  input.flush();
  assert.deepEqual(raw.map(event => event.at), [70, 400]);
  assert.deepEqual(signals, ['R2']);
});
