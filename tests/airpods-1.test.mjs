import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCountTrials, createAirPods1Input, fitCountTiming } from '../public/earbuds/airpods-1/input.mjs';

test('AirPods 1 counts next events using its own timing and ignores other media actions', () => {
  let now = 0;
  let fire;
  const signals = [];
  const input = createAirPods1Input({
    now: () => now, setTimer: fn => { fire = fn; }, clearTimer: () => { fire = null; },
    onSignal: signal => signals.push(signal),
  });
  input.configure({ countWindowMs: 1800 });
  input.receive('nexttrack');
  now = 1000;
  input.receive('previoustrack');
  input.receive('nexttrack');
  fire();
  assert.deepEqual(signals, ['R2']);
});

test('AirPods 1 owns the double and triple trial plan and the personal timing fit', () => {
  assert.deepEqual(buildCountTrials(2, 3).map(step => step.signal), ['R2', 'R2', 'R2', 'L1', 'L1', 'L1']);
  assert.deepEqual(fitCountTiming([700, 800, 910]), { countMedianMs: 800, countWindowMs: 1130 });
});
