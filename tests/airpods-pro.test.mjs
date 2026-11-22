import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAirPodsProInput, PRO_CHECKS, proCheckAction } from '../public/earbuds/airpods-pro/input.mjs';

test('AirPods Pro translates each Safari event immediately without a timing profile', () => {
  const signals = [];
  const input = createAirPodsProInput({ now: () => 42, onSignal: (signal, trace) => signals.push([signal, trace[0]]) });
  for (const action of ['pause', 'play', 'nexttrack', 'previoustrack', 'seekforward']) input.receive(action);
  assert.deepEqual(signals.map(([signal]) => signal), ['R1', 'R1', 'R2', 'L1']);
  assert.ok(signals.every(([, event]) => event.squeeze && event.at === 42));
  assert.deepEqual(Object.keys(PRO_CHECKS), ['pause', 'nexttrack', 'previoustrack']);
  assert.equal(proCheckAction('play'), 'pause');
});
