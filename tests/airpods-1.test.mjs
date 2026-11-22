import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
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

test('the standalone Safari probe counts only Next Track while its audible player is active', async () => {
  const elements = new Map(['audio', 'start', 'stop', 'status', 'count'].map(id => ['check-' + id, {
    events: {}, addEventListener(event, fn) { this.events[event] = fn; },
  }]));
  const audio = elements.get('check-audio');
  audio.paused = true;
  audio.play = async () => { audio.paused = false; audio.events.playing(); };
  audio.pause = () => { audio.paused = true; audio.events.pause(); };
  const handlers = new Map();
  const mediaSession = { setActionHandler: (action, callback) => handlers.set(action, callback) };
  runInNewContext(readFileSync(new URL('../public/earbuds/airpods-1/check.mjs', import.meta.url), 'utf8'), {
    document: { getElementById: id => elements.get(id) }, navigator: { mediaSession },
  });
  elements.get('check-start').events.click();
  assert.equal(mediaSession.playbackState, 'playing');
  handlers.get('nexttrack')();
  assert.equal(elements.get('check-count').textContent, 'Next Track received: 1');
  elements.get('check-stop').events.click();
  handlers.get('nexttrack')();
  assert.equal(elements.get('check-count').textContent, 'Next Track received: 1');
});
