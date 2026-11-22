import assert from 'node:assert/strict';
import test from 'node:test';
import { channelMonitorView, mountChannelMonitor } from '../public/channel-monitor.mjs';
import { Session } from '../hub/session.mjs';

const snapshot = {
  sharedRoom: 'A',
  agent: { phase: 'drafting', summary: 'Preparing a preview', preset: 'Pitch' },
  seats: {
    A: { name: 'Presenter', online: true, listening: false, transcription: 'unavailable',
      context: { count: 1, excerpt: 'Digest' }, output: { phase: 'queued', title: 'First cue' } },
    B: { name: 'Coach', online: true, listening: true, transcription: 'live', input: [0.25],
      recentRuns: [{ label: 'Judge', text: 'Show the demo.' }], output: { phase: 'paused', title: 'Second cue' } },
  },
};

test('Stage keeps a single shared-room projection and distinguishes failure from muted input', () => {
  const view = channelMonitorView(['A', 'B'], snapshot);
  assert.equal(view.phase, 'Preparing a cue');
  assert.equal(view.sharedRoom, 'A');
  assert.equal(view.seats[0].mic.label, 'Shared Mac microphone');
  assert.equal(view.seats[0].mic.status, 'Transcription unavailable');
  assert.equal(view.seats[0].mic.active, false);
  assert.equal(view.seats[0].output.status, 'Queued');
  assert.equal(view.seats[1].mic, null);
  assert.deepEqual(view.seats[1].recent, []);
  assert.equal(view.seats[1].output.status, 'Paused');
});

test('a phone projects only its lane and prefers the local playback clock', () => {
  const view = channelMonitorView(['B'], snapshot, { B: { phase: 'playing', title: 'Local audio', bars: [1] } });
  assert.deepEqual(view.seats.map(lane => lane.seat), ['B']);
  assert.equal(view.seats[0].mic.label, 'Shared Mac microphone');
  assert.equal(view.seats[0].mic.status, 'Transcribing');
  assert.equal(view.seats[0].recent[0].text, 'Show the demo.');
  assert.equal(view.seats[0].output.label, 'This phone’s audio');
  assert.equal(view.seats[0].output.status, 'Playing');
  assert.equal(view.seats[0].output.bars.at(-1), 100);
  assert.equal(view.seats[0].audioTitle, 'Local audio');
});

test('the React bridge emits changed views without replacing the mounted section', () => {
  const host = new EventTarget();
  host.dataset = { channelOwner: 'react' };
  const received = [];
  host.addEventListener('telepathy:channel-monitor', event => received.push(event.detail));
  const bridge = mountChannelMonitor(host, ['A']);
  bridge.update(snapshot);
  bridge.update(snapshot);
  bridge.update(null);
  assert.deepEqual(received.map(view => view.phase), ['Preparing a cue', 'Waiting for context']);
});

test('Begin announces the Live phase before delivering its first monitor frame', async t => {
  const frames = [];
  const session = new Session({ emitStage: frame => frames.push(frame), emitSeat() {}, audio: {}, codec: null });
  t.after(() => session.close());
  session.isReady = () => true;
  await session.handleStage({ action: 'begin' });
  assert.equal(frames[0].state.phase, 'live');
  assert.equal(frames[1].type, 'monitor');
  assert.deepEqual(Object.keys(frames[1].monitor.seats), ['A', 'B']);
});
