import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { createHub } from '../hub/server.mjs';
import { createEmulator, createMediaInput, DEFAULT_TIMING } from '../public/input.mjs';
import { createNetworkLink } from '../public/network.mjs';

function frames(socket, settings) {
  const link = createNetworkLink(socket, settings);
  const seen = [];
  const observers = new Set();
  link.onMessage(frame => {
    seen.push(frame);
    for (const observe of observers) observe(frame);
  });
  return {
    link, seen,
    async when(predicate, timeout = 5000, label = 'frame', after = 0) {
      const existing = seen.slice(after).find(predicate);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observers.delete(observe);
          reject(new Error('Timed out waiting for ' + label));
        }, timeout);
        function observe(frame) {
          if (!predicate(frame)) return;
          clearTimeout(timer);
          observers.delete(observe);
          resolve(frame);
        }
        observers.add(observe);
      });
    },
    onFrame(fn) { observers.add(fn); },
    async opened() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
    },
  };
}

async function fetchAsset(base, path) {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-type'), /^audio\//, path);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.ok(buffer.length > 500 && (buffer.subarray(0, 3).equals(Buffer.from('ID3')) || buffer[0] === 0xff), path);
  return buffer;
}

async function seatClient(url, seat, settings, raw, failures) {
  const query = new URL('/ws?role=seat&sim=1&seat=' + seat, url);
  const client = frames(new WebSocket(query.href.replace(/^http/, 'ws')), settings.net);
  const cache = new Map();
  const played = [];
  let mode = settings.mode;
  let sequence = 0;
  const received_signals = [];
  const input = createMediaInput({
    mode, timing: settings.timing,
    onRaw(event) { raw.push({ seat, ...event }); },
    onSignal(signal) {
      received_signals.push(signal);
      client.link.send({ type: 'signal', signal, id: seat + '-' + ++sequence });
    },
  });
  const emulator = createEmulator({ input, settings: settings.earbud });
  client.onFrame(frame => {
    if (frame.type === 'cache') {
      void Promise.all(frame.items.map(async ({ key, url: asset }) => [key, await fetchAsset(url, asset)]))
        .then(items => {
          cache.set(frame.activeId, new Map(items));
          client.link.send({ type: 'cache_ready', activeId: frame.activeId });
        }).catch(error => failures.push(error));
    } else if (frame.type === 'audio') {
      void (async () => {
        let asset;
        if (frame.key) {
          asset = cache.get(frame.activeId)?.get(frame.key);
          assert.ok(asset, 'fixed messages are read from decoded/cache manifest only');
        } else if (frame.url) asset = await fetchAsset(url, frame.url);
        if (frame.messageId && asset) {
          if (settings.cueLeadMs > 0) await delay(settings.cueLeadMs);
          played.push({ ...frame, nominalOnsetAt: Date.now() });
          client.link.send({ type: 'heard', messageId: frame.messageId });
        }
      })().catch(error => failures.push(error));
    }
  });
  await client.opened();
  client.link.send({ type: 'configure', mode: settings.mode });
  for (const step of ['voice', 'earbuds', 'calibrate', 'ready']) client.link.send({ type: 'setup', step, complete: true });
  return {
    ...client, played, emulator, received_signals,
    gesture(signal) { emulator.signal(signal, mode); },
    setMode(next_mode) {
      mode = next_mode;
      input.configure({ mode });
      client.link.send({ type: 'configure', mode });
    },
    close() { emulator.reset(); input.dispose(); client.link.close(); },
  };
}

function stateFor(predicate) {
  return frame => frame.type === 'state' && predicate(frame.state);
}

function messageIn(state, text) {
  return state.log.find(item => item.kind === 'message' && item.text === text);
}

async function pitch(run, { fast }) {
  const raw = [];
  const failures = [];
  const seed = 695 + run * 121;
  const timing = fast
    ? { closeMs: 140, duplicateMs: 10, fastMaxMs: 70, slowMinMs: 85, slowMaxMs: 125, mixedMaxMs: 125 }
    : DEFAULT_TIMING;
  const earbud = fast
    ? { delayMs: 12, jitterMs: 5, fastGapMs: 43, slowGapMs: 104, mixedGapMs: 45, duplicateGapMs: 6 }
    : {};
  const net = fast
    ? { delayMs: 8, jitterMs: 4, retryMs: 28 }
    : {};
  const hub = createHub({
    env: {},
    settings: { roomSenseMs: fast ? 100 : 15_000, cannedTimeScale: fast ? 0.1 : 1 },
  });
  const { stageUrl } = await hub.start({ port: 0, host: '127.0.0.1' });
  const ws_url = new URL('/ws?role=stage', stageUrl).href.replace(/^http/, 'ws');
  const stage = frames(new WebSocket(ws_url));
  let a;
  let b;
  try {
    await stage.opened();
    [a, b] = await Promise.all(['A', 'B'].map((seat, i) => seatClient(stageUrl, seat, {
      mode: 2, timing, cueLeadMs: fast ? 20 : 200,
      net: { ...net, enabled: true, seed: seed + i, dropRate: 0.08 },
      earbud: { ...earbud, seed: seed + i, doubleRate: 0.16, missRate: 0 },
    }, raw, failures)));
    await stage.when(stateFor(state => state.canBegin), 7000, 'both seats and both caches ready');
    stage.link.send({ type: 'operator', action: 'begin' });
    await stage.when(stateFor(state => state.phase === 'live'), 5000, 'live');
    a.link.send({ type: 'sim_transcript', text: 'This is the Telepath pitch. Let me explain how it works.', level: 0.18 });

    b.emulator.configure({ missRate: 1 });
    b.gesture('R1');
    b.emulator.configure({ missRate: 0 });
    await delay(timing.closeMs + (fast ? 45 : 160));
    assert.equal(b.received_signals.length, 0, 'the purposely missed tap never reaches the recognizer');
    b.gesture('R1');
    const slow = await stage.when(stateFor(state => messageIn(state, 'Slow down')), 4000, 'fixed coaching whisper');
    const slow_id = messageIn(slow.state, 'Slow down').messageId;
    const playback_deadline = Date.now() + 4500;
    while (!a.played.some(frame => frame.messageId === slow_id) && Date.now() < playback_deadline) await delay(15);
    assert.ok(a.played.some(frame => frame.messageId === slow_id), 'recipient acknowledged the cached audio');
    a.gesture('R1');
    await stage.when(stateFor(state => state.log.some(entry => entry.kind === 'receipt' && entry.messageId === slow_id)), 4000, 'receipt from A');

    b.gesture('R2');
    await stage.when(stateFor(state => messageIn(state, 'One minute left')), 5000, 'two-right timed message');
    const recipients_before = a.seen.filter(frame => frame.type === 'audio' && frame.text === 'The judge on the left looks lost').length;
    b.link.send({ type: 'sim_transcript', text: 'The judge on the left looks lost.', level: 0.19 });
    const draft = await b.when(stateFor(state => state.seats.B.pending?.text === 'The judge on the left looks lost'), fast ? 5000 : 20_000, 'coach-only draft');
    const draft_id = draft.state.seats.B.pending.id;
    assert.equal(a.seen.filter(frame => frame.type === 'audio' && frame.text === 'The judge on the left looks lost').length, recipients_before);
    const heard = await stage.when(stateFor(state => state.log.some(entry => entry.kind === 'preview_playback' && entry.draftId === draft_id)), 5000, 'emulated draft onset');
    const preview_ms = heard.state.log.find(entry => entry.kind === 'preview_playback' && entry.draftId === draft_id).latencyMs;
    assert.ok(preview_ms < 2000);

    b.gesture('R1');
    const confirmed = await stage.when(stateFor(state => messageIn(state, 'The judge on the left looks lost')), 4000, 'release after confirmation');
    assert.equal(messageIn(confirmed.state, 'The judge on the left looks lost').messageKind, 'smart');
    b.gesture('OUT');
    await stage.when(stateFor(state => messageIn(state, 'Wrap it up now')), 4000, 'earbud removal urgent whisper');
    b.gesture('BACK');
    await stage.when(stateFor(state => state.log.some(entry => entry.kind === 'back')), 4000, 'earbud insertion');
    stage.link.send({ type: 'operator', action: 'reveal' });
    const reveal = await stage.when(stateFor(state => state.phase === 'reveal'), 4000, 'reveal');
    assert.equal(reveal.state.bits, 7);
    assert.deepEqual(reveal.state.log.filter(entry => entry.kind === 'message').map(entry => entry.text),
      ['Slow down', 'One minute left', 'The judge on the left looks lost', 'Wrap it up now']);
    assert.equal(reveal.state.seats.A.transcript.length, 1);
    assert.equal(reveal.state.seats.B.transcript.length, 1);
    assert.deepEqual(failures, []);
    const stats = {
      raw: raw.length,
      misses: a.emulator.stats.missed + b.emulator.stats.missed,
      duplicates: a.emulator.stats.doubled + b.emulator.stats.doubled,
      lostAttempts: a.link.stats.dropped + b.link.stats.dropped,
      recovered: a.link.stats.retried + b.link.stats.retried,
      previewMs: preview_ms,
      fixedAndSmart: reveal.state.log.filter(entry => entry.kind === 'message').length,
      bits: reveal.state.bits,
    };
    assert.equal(stats.misses, 1);
    assert.ok(stats.recovered > 0);
    return stats;
  } finally {
    a?.close();
    b?.close();
    stage.link.close();
    await hub.close();
  }
}

async function verifyCanned(fast) {
  const hub = createHub({ env: {}, settings: { cannedTimeScale: fast ? 0.1 : 1 } });
  const { stageUrl } = await hub.start({ port: 0, host: '127.0.0.1' });
  const stage = frames(new WebSocket(new URL('/ws?role=stage', stageUrl).href.replace(/^http/, 'ws')));
  try {
    await stage.opened();
    stage.link.send({ type: 'operator', action: 'canned' });
    const done = await stage.when(stateFor(state => state.canned && state.phase === 'reveal'), 24_000, 'canned reveal without seats');
    const audio = stage.seen.filter(frame => frame.type === 'audio');
    assert.equal(done.state.bits, 7);
    assert.equal(audio.length, 5);
    assert.equal(audio.find(frame => frame.cue === 'draft')?.voiceRole, 'assistant');
    for (const frame of audio) {
      assert.ok(frame.url, 'operator fallback includes playable URL');
      await fetchAsset(stageUrl, frame.url);
    }
  } finally {
    stage.link.close();
    await hub.close();
  }
}

export async function rehearse({ runs = 5, fast = false } = {}) {
  const results = [];
  for (let run = 1; run <= runs; run++) {
    const result = await pitch(run, { fast });
    results.push(result);
    console.log('Pitch ' + run + '/' + runs + ' ' + JSON.stringify(result));
  }
  await verifyCanned(fast);
  console.log('Canned reveal passed with zero seats and no cloud access.');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = process.argv.find(value => value.startsWith('--runs='));
  const runs = option ? Number(option.split('=')[1]) : 5;
  await rehearse({ runs, fast: process.argv.includes('--fast') });
}
