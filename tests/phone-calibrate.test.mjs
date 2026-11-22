import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { build_plan, createCalibration } from '../public/calibrate.mjs';
import { COUNT_CALIBRATION_WINDOW_MS } from '../public/earbuds/airpods-1/input.mjs';
import { createMediaInput, DEFAULT_EMULATOR, DEFAULT_TIMING, patternFor } from '../public/input.mjs';
import { APP_TIMING } from '../public/phone-data.mjs';
import { createWorld } from './phone-fakes.mjs';

let world;
let restore;
let elements;
let saved_document;

function make_element(id) {
  const base = {
    id, dataset: {}, style: {}, hidden: false, textContent: '', value: '', checked: false, disabled: false,
    listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    append() {}, replaceChildren(...nodes) { this.children = nodes; }, querySelector: () => null,
  };
  return new Proxy(base, {
    get: (target, prop) => (prop in target ? target[prop] : prop === 'then' || typeof prop === 'symbol' ? undefined : () => undefined),
  });
}

beforeEach(() => {
  world = createWorld();
  restore = world.install();
  elements = new Map();
  saved_document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, make_element(id));
        return elements.get(id);
      },
      querySelector: () => null,
      createElement: () => make_element('created'),
    },
  });
});
afterEach(() => {
  if (saved_document) Object.defineProperty(globalThis, 'document', saved_document);
  else delete globalThis.document;
  restore();
});

const element = id => elements.get(id);

function make_services({ respond, classify = true, gesture_model, miss_first = false }) {
  const applied = [];
  const exits = [];
  const settings = {
    mode: 2,
    gesture_model,
    timing: { ...DEFAULT_TIMING },
    emulator: { ...DEFAULT_EMULATOR },
    app: {
      ...APP_TIMING, calibrationLeadMs: 5, calibrationWindowMs: gesture_model ? 5200 : 1200, calibrationRemovalWindowMs: 1200,
      calibrationSettleMs: 500, calibrationRemovalSettleMs: 50, calibrationRestMs: 5,
    },
  };
  let trial = 0;
  let attempts = 0;
  const plan = build_plan('mode', 2, gesture_model);
  const holder = {};
  const services = {
    input: { configure() {}, reset() {}, flush() {} },
    emulator: { reset() {}, gesture() {} },
    audio: {
      play_cue(name) {
        if (name !== 'system') return performance.now();
        if (++attempts === 1 && miss_first) return performance.now();
        const step = plan[trial];
        trial += 1;
        if (respond) {
          const pattern = step.gestureModel
            ? [0, 780, 1560].slice(0, step.signal === 'R2' ? 2 : 3).map(offsetMs => ({ action: 'nexttrack', offsetMs }))
            : patternFor(step.signal, step.mode, settings.emulator);
          for (const event of pattern) {
            setTimeout(() => holder.calibration.note_raw({ action: event.action, at: performance.now() }), 5 + event.offsetMs);
          }
          const last = Math.max(...pattern.map(event => event.offsetMs));
          setTimeout(() => holder.calibration.note_signal(classify ? step.signal : 'WRONG'), 6 + last);
        }
        return performance.now();
      },
    },
    get_settings: () => settings,
    get_seat: () => 'A',
    is_sim: () => false,
    arm() {},
    resume_media() {},
    on_apply: profile => { applied.push(profile); return { applied: true }; },
    on_run_state() {},
    on_exit(value) { exits.push(value); },
  };
  holder.calibration = createCalibration(services);
  return { services, applied, exits, calibration: holder.calibration, attempts: () => attempts };
}

async function run_to_result() {
  element('cal-start').listeners.click[0]();
  for (let step = 0; step < 40000 && element('cal-result').hidden; step += 1) {
    await world.flush();
    world.advance(5);
  }
  assert.equal(element('cal-result').hidden, false, 'the run finished');
}

test('the Pro earbud check reports three squeezes and ignores injected gestures', () => {
  const { calibration, services, exits } = make_services({ respond: false });
  const callbacks = new Map();
  services.input = createMediaInput({ onMediaEvent: calibration.note_media_event });
  services.input.register({ setActionHandler: (action, handler) => callbacks.set(action, handler) });
  calibration.open({ from: 'setup' });
  element('cal-earbud-model').value = 'pro';
  element('cal-quick-start').listeners.click[0]();
  assert.equal(calibration.active(), true);
  services.input.dispatch('nexttrack');
  callbacks.get('previoustrack')();
  assert.equal(element('cal-quick-previoustrack').textContent, 'Triple squeeze · received');
  assert.match(element('cal-quick-nexttrack').textContent, /double squeeze either/);
  assert.match(element('cal-quick-status').textContent, /1 of 3/);
  assert.equal(element('cal-quick-continue').textContent, 'Continue with defaults');
  callbacks.get('nexttrack')();
  assert.equal(element('cal-quick-nexttrack').textContent, 'Double squeeze · received');
  assert.equal(element('cal-quick-continue').hidden, false);
  callbacks.get('pause')();
  callbacks.get('play')();
  assert.equal(element('cal-quick-pause').textContent, 'Single squeeze · received');
  assert.equal(element('cal-quick-status').textContent, 'All three squeezes reached Telepathy.');
  assert.equal(element('cal-quick-continue').textContent, 'Continue');
  element('cal-quick-continue').listeners.click[0]();
  assert.equal(calibration.active(), false);
  assert.deepEqual(exits, [{ skipped: true }]);
});

test('AirPods 1 calibration collects two doubles and two triples', () => {
  const steps = build_plan('both', 2, 'next-only');
  assert.deepEqual(steps.map(step => step.signal), ['R2', 'R2', 'L1', 'L1']);
  assert.ok(steps.every(step => step.gestureModel === 'next-only'));
});

test('the AirPods 1 precheck keeps timing trials off until Safari receives Next Track', () => {
  const { calibration } = make_services({ respond: false, gesture_model: 'next-only' });
  calibration.open({ from: 'setup' });
  element('cal-quick-start').listeners.click[0]();
  calibration.note_media_event('previoustrack');
  assert.match(element('cal-quick-status').textContent, /Previous Track/);
  assert.equal(element('cal-quick-continue').hidden, true);
  assert.equal(element('cal-run').hidden, true);
  calibration.note_media_event('nexttrack');
  assert.equal(element('cal-quick-continue').hidden, false);
  element('cal-quick-continue').listeners.click[0]();
  assert.equal(element('cal-run').hidden, false);
  assert.equal(element('cal-pattern').textContent, 'Next Track twice');
  calibration.stop();
});

test('AirPods 1 calibration saves timing measured over its four trials', async () => {
  const { applied } = make_services({ respond: true, gesture_model: 'next-only' });
  await run_to_result();
  assert.equal(element('cal-verdict').textContent, 'Calibrated');
  assert.equal(element('cal-applied').textContent, 'Saved on this phone.');
  assert.equal(applied[0].timing.countMedianMs, 780);
  assert.equal(applied[0].timing.countWindowMs, 1053);
});

test('the timing screen shows the real repeat total and fills a bar for a received Next Track', async () => {
  const { calibration } = make_services({ respond: false, gesture_model: 'next-only' });
  element('cal-start').listeners.click[0]();
  world.advance(5);
  await world.flush();
  assert.equal(element('cal-count').textContent, 'Trial 1 / 4');
  assert.match(element('cal-repetition').textContent, /1 of 2/);
  const first_beat = element('cal-beats').children[0];
  assert.deepEqual(element('cal-beats').children.map(beat => beat.dataset.filled), ['false', 'false']);
  calibration.note_raw({ action: 'nexttrack', at: performance.now() });
  assert.deepEqual(element('cal-beats').children.map(beat => beat.dataset.filled), ['true', 'false']);
  assert.equal(element('cal-beats').children[0], first_beat);
  world.advance(COUNT_CALIBRATION_WINDOW_MS);
  await world.flush();
  assert.equal(element('cal-phase').dataset.phase, 'miss');
  assert.match(element('cal-detail').textContent, /Received Next Track.*Retrying/);
  assert.deepEqual(element('cal-beats').children.map(beat => beat.dataset.filled), ['true', 'false']);
  calibration.stop();
});

test('AirPods 1 retries a missed trial in place and saves only after four accepted trials', async () => {
  const { applied, attempts } = make_services({ respond: true, gesture_model: 'next-only', miss_first: true });
  await run_to_result();
  assert.equal(attempts(), 5);
  assert.equal(applied[0].metrics.recognized, 4);
  assert.equal(applied[0].metrics.trials, 4);
  assert.equal(applied[0].timing.countMedianMs, 780);
});

test('calibration names the media command and reports the received track event during the trial', async () => {
  const { calibration } = make_services({ respond: false });
  element('cal-start').listeners.click[0]();
  world.advance(5);
  await world.flush();
  assert.equal(element('cal-phase').textContent, 'Now');
  assert.equal(element('cal-pattern').textContent, 'Next Track once');
  calibration.note_raw({ action: 'previoustrack', at: performance.now() });
  assert.equal(element('cal-detail').textContent, 'Received Previous Track.');
  calibration.stop();
});

test('a run where no earbud event arrives is reported as such and cannot be applied', async () => {
  const { applied, exits } = make_services({ respond: false });
  await run_to_result();
  assert.equal(element('cal-verdict').textContent, 'No earbud events');
  assert.equal(element('cal-apply').hidden, true, 'an all-miss profile is never offered');
  assert.equal(applied.length, 0);
  assert.equal(element('cal-applied').textContent, 'The phone received no earbud events, so nothing changed.');
  element('cal-done').listeners.click[0]();
  assert.equal(exits.at(-1).completed, false, 'setup must not mark a silent run calibrated');
});

test('callbacks of the wrong pattern are not automatically accepted as calibration', async () => {
  const { applied } = make_services({ respond: true, classify: false });
  await run_to_result();
  assert.equal(element('cal-verdict').textContent, 'Review the timing');
  assert.equal(applied.length, 0);
});

test('a run where events arrive is applied as a real profile with the measured response', async () => {
  const { applied } = make_services({ respond: true });
  await run_to_result();
  assert.equal(element('cal-verdict').textContent, 'Calibrated');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].source, 'real');
  assert.equal(applied[0].metrics.responded, applied[0].metrics.trials);
  assert.equal(applied[0].metrics.missed, 0);
});
