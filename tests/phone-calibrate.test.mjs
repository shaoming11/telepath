import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { build_plan, createCalibration } from '../public/calibrate.mjs';
import { DEFAULT_EMULATOR, DEFAULT_TIMING, patternFor } from '../public/input.mjs';
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
    append() {}, replaceChildren() {}, querySelector: () => null,
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

function make_services({ respond, classify = true }) {
  const applied = [];
  const exits = [];
  const settings = {
    mode: 2,
    timing: { ...DEFAULT_TIMING },
    emulator: { ...DEFAULT_EMULATOR },
    app: {
      ...APP_TIMING, calibrationLeadMs: 5, calibrationWindowMs: 1200, calibrationRemovalWindowMs: 1200,
      calibrationSettleMs: 500, calibrationRemovalSettleMs: 50, calibrationRestMs: 5,
    },
  };
  let trial = 0;
  const plan = build_plan('mode', 2);
  const holder = {};
  const services = {
    input: { configure() {}, reset() {}, flush() {} },
    emulator: { reset() {}, gesture() {} },
    audio: {
      play_cue(name) {
        if (name !== 'system') return performance.now();
        const step = plan[trial];
        trial += 1;
        if (respond) {
          const pattern = patternFor(step.signal, step.mode, settings.emulator);
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
  return { services, applied, exits, calibration: holder.calibration };
}

async function run_to_result() {
  element('cal-start').listeners.click[0]();
  for (let step = 0; step < 40000 && element('cal-result').hidden; step += 1) {
    await world.flush();
    world.advance(5);
  }
  assert.equal(element('cal-result').hidden, false, 'the run finished');
}

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
