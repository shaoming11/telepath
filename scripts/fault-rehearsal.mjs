import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { get as httpsGet } from 'node:https';
import { WebSocket } from 'ws';

const AUDIO_WAIT_MS = 6500;

function readOptions(args) {
  const options = { cycles: 1, minutes: 0, seed: 1207, fast: false, mission: false, tls: false, root: process.cwd(), out: null };
  for (const arg of args) {
    if (arg === '--fast') { options.fast = true; continue; }
    if (arg === '--mission') { options.mission = true; continue; }
    if (arg === '--tls') { options.tls = true; continue; }
    const match = /^--(cycles|minutes|seed|root|out)=(.+)$/.exec(arg);
    if (!match) throw new Error('Unknown option: ' + arg);
    const [, key, value] = match;
    options[key] = ['cycles', 'minutes', 'seed'].includes(key) ? Number(value) : value;
  }
  for (const key of ['cycles', 'minutes', 'seed']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0 && key !== 'minutes' || !Number.isInteger(options[key]) && key !== 'minutes') {
      throw new Error('Invalid ' + key);
    }
  }
  if (options.minutes < 0) throw new Error('Invalid minutes');
  return options;
}

async function until(see, name, ms = 6500) {
  const end = performance.now() + ms;
  let found;
  while (!(found = see()) && performance.now() < end) await delay(12);
  assert.ok(found, 'Timed out: ' + name);
  return found;
}

function httpsAsset(url, ca) {
  return new Promise((resolve_bytes, reject) => {
    const request = httpsGet(url, { ca, timeout: 2500 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve_bytes({
        status: response.statusCode, mime: response.headers['content-type'], data: Buffer.concat(chunks),
      }));
    });
    request.once('timeout', () => request.destroy(new Error('Timed out downloading HTTPS audio')));
    request.once('error', reject);
  });
}

async function urlLoaded(base, asset, timing, ca) {
  const start = performance.now();
  const url = new URL(asset, base);
  let result;
  if (ca) result = await httpsAsset(url, ca);
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    result = { status: response.status, mime: response.headers.get('content-type'), data: Buffer.from(await response.arrayBuffer()) };
  }
  assert.equal(result.status, 200, asset);
  assert.match(result.mime, /^audio\//, asset);
  const { data } = result;
  assert.ok(data.length > 500 && (data.subarray(0, 3).equals(Buffer.from('ID3')) || data[0] === 0xff), asset);
  timing?.push(performance.now() - start);
}

function meter() {
  globalThis.gc?.();
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external };
}

function summarize(values) {
  if (values.length === 0) return null;
  const sort = values.toSorted((a, b) => a - b);
  const nth = fraction => Math.round(sort[Math.min(sort.length - 1, Math.ceil(sort.length * fraction) - 1)]);
  return { median: nth(0.5), p95: nth(0.95), max: nth(1), count: sort.length };
}

function frameKind(frame, kind) {
  return frame.type === 'audio' && frame.cue === kind;
}

async function connect(base, profile, { createNetworkLink }) {
  const socket = new WebSocket(new URL('/ws?' + new URLSearchParams(profile.query), base).href.replace(/^http/, 'ws'),
    profile.ca ? { ca: profile.ca } : {});
  const link = createNetworkLink(socket, profile.network);
  const messages = [];
  const observers = new Set();
  let state;
  let closed = false;
  link.onMessage(frame => {
    if (frame.type === 'state') state = frame.state;
    else messages.push(frame);
    for (const observe of observers) observe(frame);
  });
  socket.once('error', () => {});
  socket.once('close', () => { closed = true; });
  await until(() => socket.readyState === WebSocket.OPEN, 'socket opened');
  return {
    link, socket, messages, observers,
    get state() { return state; },
    get closed() { return closed; },
    send(frame) { assert.equal(link.send(frame), true, 'Unable to send ' + frame.type); },
    close() { if (!closed) link.close(); },
    waitAudio(check, name, from = 0) {
      return until(() => messages.slice(from).find(frame => frame.type === 'audio' && check(frame)), name, AUDIO_WAIT_MS);
    },
  };
}

async function connectSeat(base, seat, profile, api, metrics, seed) {
  const net = {
    enabled: true, seed, dropRate: 0.03 + seed % 5 * 0.02,
    delayMs: profile.fast ? 9 : 22 + seed % 4 * 9,
    jitterMs: profile.fast ? 6 : 18 + seed % 5 * 5,
    retryMs: profile.fast ? 30 : 115, maxRetries: 7,
  };
  const client = await connect(base, { query: { role: 'seat', sim: '1', seat }, network: net, ca: profile.ca }, api);
  const cache = new Map();
  const delayed_acks = new Set();
  const pending = new Set();
  const failures = [];
  let sequence = 0;
  let hold_cache = false;
  const input = api.createMediaInput({
    timing: profile.timing,
    onSignal: signal => {
      client.link.send({ type: 'signal', signal, id: seat + '-' + seed + '-' + ++sequence });
    },
  });
  const emulator = api.createEmulator({
    input,
    settings: {
      ...profile.earbud,
      seed,
      missRate: 0,
      doubleRate: 0.14,
    },
  });
  async function cacheFrames({ activeId, items }) {
    if (cache.has(activeId)) return;
    await Promise.all(items.map(({ url }) => urlLoaded(base, url, metrics.assetMs, profile.ca)));
    if (client.closed) return;
    cache.set(activeId, new Set(items.map(({ key }) => key)));
    if (hold_cache) delayed_acks.add(activeId);
    else client.send({ type: 'cache_ready', activeId });
  }
  client.observers.add(frame => {
    if (frame.type !== 'cache') return;
    const job = cacheFrames(frame).catch(error => failures.push(error.message)).finally(() => pending.delete(job));
    pending.add(job);
  });
  for (const frame of client.messages.filter(frame => frame.type === 'cache')) await cacheFrames(frame);
  client.send({ type: 'configure', mode: 2, drafts: true });
  for (const step of ['voice', 'earbuds', 'calibrate', 'ready']) client.send({ type: 'setup', step, complete: true });
  return {
    client, cache, delayed_acks, failures,
    play(signal) { emulator.signal(signal, 2); },
    setHold(value) {
      hold_cache = value;
      if (!value) {
        for (const activeId of delayed_acks) client.send({ type: 'cache_ready', activeId });
        delayed_acks.clear();
      }
    },
    heard(frame) { client.send({ type: 'heard', messageId: frame.messageId }); },
    async close() {
      input.dispose();
      emulator.reset();
      client.close();
      await Promise.allSettled(pending);
      metrics.links.push({ ...client.link.stats });
    },
  };
}

async function runCycle(base, stage, profile, api, metrics, number, seed) {
  const issues = [];
  const started = performance.now();
  let a, b;
  const waitStage = (fn, label) => until(() => stage.state && fn(stage.state) && stage.state, label);
  const waitSeats = () => waitStage(state => state.canBegin, 'seats cached and ready');
  const step = async (label, run) => {
    try { return await run(); }
    catch (error) { error.message = label + ': ' + error.message; throw error; }
  };
  try {
    const initial = stage.state?.sessionId;
    stage.send({ type: 'operator', action: 'reset' });
    await waitStage(state => state.phase === 'lobby' && state.sessionId !== initial && !state.canned && !state.log.length, 'clean state after reset');
    [a, b] = await Promise.all(['A', 'B'].map((seat, index) => connectSeat(base, seat, profile, api, metrics, seed + index)));
    await waitSeats();
    if (profile.mission) {
      await step('mission operator sound check', async () => {
        stage.send({ type: 'operator', action: 'announce', text: 'Sound check. Can you hear me?' });
        const [clip_a, clip_b] = await Promise.all([a, b].map(seat =>
          seat.client.waitAudio(frame => frame.kind === 'announcement', 'operator system line')));
        assert.equal(clip_a.url, clip_b.url);
        assert.equal(clip_a.messageId, clip_b.messageId);
        await urlLoaded(base, clip_a.url, metrics.assetMs, profile.ca);
        a.heard(clip_a);
        await waitStage(state => state.announcement?.heard.length === 1, 'the first playback separately visible to the operator');
        b.heard(clip_b);
        await waitStage(state => state.announcement?.status === 'played', 'both seats confirmed');
        assert.equal(stage.state.bits, 0);
      });
    }
    stage.send({ type: 'operator', action: 'begin' });
    await waitStage(state => state.phase === 'live', 'live');

    if (number % 3 === 0) {
      await step('offline seat recovery', async () => {
        await b.close();
        await waitStage(state => !state.online.B, 'stage marks B offline');
        const from = a.client.messages.length;
        a.play('R2');
        await a.client.waitAudio(frame => frameKind(frame, 'error'), 'offline error', from);
        assert.ok(!stage.state.log.some(event => event.kind === 'message'), 'offline signal cannot send a whisper');
        if (profile.mission) {
          const mark = a.client.messages.length;
          stage.send({ type: 'operator', action: 'announce', text: 'Time to bring up the reveal.' });
          const clip = await a.client.waitAudio(frame => frame.kind === 'announcement', 'system line to remaining seat', mark);
          assert.equal(clip.text, 'Time to bring up the reveal.');
          await urlLoaded(base, clip.url, metrics.assetMs, profile.ca);
          a.heard(clip);
          const partial = await waitStage(state => state.announcement?.status === 'partial', 'explicit report for missing seat');
          assert.deepEqual(partial.announcement.heard, ['A']);
        }
        b = await connectSeat(base, 'B', profile, api, metrics, seed + 900);
        await waitSeats();
      });
    }

    await step('cached send and receipt', async () => {
      b.play('R1');
      const fixed = await a.client.waitAudio(frame => frame.text === 'Slow down' && frame.messageId, 'fixed Pitch line');
      assert.ok(a.cache.get(fixed.activeId)?.has(fixed.key), 'fixed line must match an acknowledged local key');
      a.heard(fixed);
      a.play('R1');
      await waitStage(state => state.log.some(event => event.kind === 'receipt' && event.messageId === fixed.messageId), 'exactly the delivered message received a receipt');
    });

    await step('draft preview and send', async () => {
      b.play('LR');
      const preview = await b.client.waitAudio(frame => frameKind(frame, 'draft'), 'private draft');
      const log = () => stage.state.log;
      assert.ok(!a.client.messages.some(frame => frame.text === preview.text), 'draft audio is private');
      b.play('R1');
      const seen = await waitStage(state => state.log.some(event => event.kind === 'signal' && event.seat === 'B' && event.signal === 'R1' && event.at >= preview.decisionAt), 'R1 reached hub before preview ack');
      if (seen.log.some(event => event.kind === 'confirm' && event.draftId === preview.messageId)) {
        issues.push('unheard_draft_confirmed');
        await waitStage(state => state.log.some(event => event.kind === 'message' && event.messageKind === 'smart'), 'baseline released unheard draft');
      } else {
        b.heard(preview);
        const acked = await waitStage(state => state.log.some(event => event.kind === 'preview_playback' && event.draftId === preview.messageId), 'server recorded scheduled onset');
        const latency = acked.log.find(event => event.kind === 'preview_playback' && event.draftId === preview.messageId)?.latencyMs;
        if (Number.isFinite(latency)) metrics.decisionAckMs.push(latency);
        b.play('R1');
        await waitStage(state => state.log.some(event => event.kind === 'message' && event.messageKind === 'smart'), 'approved smart whisper');
        assert.equal(log().filter(event => event.kind === 'confirm' && event.draftId === preview.messageId).length, 1);
      }
      await a.client.waitAudio(frame => frame.text === preview.text && frame.messageId && frame.cue === 'soft', 'recipient receives approved voice');
    });

    await step('cache generation rollover', async () => {
      b.setHold(true);
      stage.send({ type: 'operator', action: 'preset', preset: 'Party' });
      await until(() => b.delayed_acks.size, 'B simulated cache decode lag');
      assert.equal(stage.state.preset, 'Pitch');
      const from = a.client.messages.length;
      b.play('R2');
      const during = await a.client.waitAudio(frame => frame.text === 'One minute left', 'old preset until both ACK', from);
      assert.ok(a.cache.get(during.activeId)?.has(during.key));
      b.setHold(false);
      await waitStage(state => state.preset === 'Party', 'both ACK activate new preset');
      b.play('R2');
      const after = await a.client.waitAudio(frame => frame.text === 'Save me from this conversation', 'new cached line');
      assert.ok(a.cache.get(after.activeId)?.has(after.key));
    });

    await step('frozen reveal', async () => {
      stage.send({ type: 'operator', action: 'reveal' });
      await waitStage(state => state.phase === 'reveal', 'reveal');
      b.client.send({ type: 'sim_transcript', text: 'After reveal test marker.' });
      await delay(profile.fast ? 135 : 335);
      if (stage.state.seats.B.transcript.some(line => line.text === 'After reveal test marker.')) issues.push('transcript_mutated_after_reveal');
      assert.equal(stage.state.log.filter(event => event.kind === 'message').length, 4);
      assert.equal(stage.state.bits, 7);
      assert.deepEqual([...a.failures, ...b.failures], []);
    });
  } catch (error) {
    issues.push(error.message);
  } finally {
    await Promise.all([a?.close(), b?.close()]);
  }
  return { kind: 'cycle', number, seed, elapsedMs: Math.round(performance.now() - started), issues };
}

async function main(options) {
  const { root, out, fast, minutes, cycles, seed } = options;
  const use = path => import(pathToFileURL(resolve(root, path)).href);
  const [{ createHub }, input, network, { resolveTLS }] = await Promise.all([
    use('hub/server.mjs'), use('public/input.mjs'), use('public/network.mjs'), use('hub/tls.mjs'),
  ]);
  const api = { ...input, ...network };
  const runtime = options.tls ? mkdtempSync(join(tmpdir(), 'telepathy-wss-')) : null;
  const tls = runtime ? resolveTLS({}, runtime, '127.0.0.1') : null;
  const profile = {
    fast, mission: options.mission,
    ca: runtime ? readFileSync(join(runtime, 'tls', 'root.pem')) : null,
    timing: fast ? { closeMs: 150, duplicateMs: 18, fastMaxMs: 75, slowMinMs: 90, slowMaxMs: 120, mixedMaxMs: 130 } : input.DEFAULT_TIMING,
    earbud: fast ? { delayMs: 12, jitterMs: 4, fastGapMs: 42, slowGapMs: 104, mixedGapMs: 49, duplicateGapMs: 7 } : {},
  };
  const hub = createHub({ env: {}, tls, settings: { roomSenseMs: fast ? 100 : 15_000 } });
  const file = out ? createWriteStream(out, { flags: 'wx', mode: 0o600 }) : null;
  const metrics = { links: [], assetMs: [], decisionAckMs: [], issueCounts: {} };
  const started = performance.now();
  const histogram = [];
  let runs = 0;
  let clean = 0;
  let stage;
  let stop = false;
  const interrupt = () => { stop = true; };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  function record(item) {
    const line = JSON.stringify(item);
    if (file) file.write(line + '\n');
    if (!file || item.kind !== 'cycle' || item.number === 1 || item.number % 10 === 0) console.log(line);
  }

  try {
    const { stageUrl, joinUrl } = await hub.start({ port: 0, tlsPort: 0, host: '127.0.0.1' });
    assert.equal(new URL(joinUrl).protocol, options.tls ? 'https:' : 'http:');
    stage = await connect(stageUrl, { query: { role: 'stage' } }, api);
    await until(() => stage.state, 'initial stage state');
    record({ kind: 'start', utc: new Date().toISOString(), configuredMinutes: minutes, cycles, fast, mission: options.mission,
      transport: options.tls ? 'wss' : 'ws', seed, initial: meter() });
    const deadline = minutes ? started + minutes * 60_000 : Infinity;
    while (!stop && (minutes ? performance.now() < deadline : runs < cycles)) {
      const result = await runCycle(joinUrl, stage, profile, api, metrics, ++runs, seed + runs * 107);
      clean += Number(result.issues.length === 0);
      for (const issue of result.issues) metrics.issueCounts[issue] = (metrics.issueCounts[issue] ?? 0) + 1;
      if (runs % 10 === 0) {
        const sample = meter();
        histogram.push({ at: runs, ...sample });
        result.memory = sample;
      }
      record(result);
    }
    const packet = key => metrics.links.reduce((sum, stats) => sum + stats[key], 0);
    record({
      kind: 'summary', utc: new Date().toISOString(), elapsedSeconds: Math.round((performance.now() - started) / 1000),
      runs, clean, issueCounts: metrics.issueCounts, packetAttempts: packet('attempts'), droppedAttempts: packet('dropped'),
      retries: packet('retried'), finalLosses: packet('lost'), assetMs: summarize(metrics.assetMs),
      previewAckMs: summarize(metrics.decisionAckMs), finalMemory: meter(), memorySamples: histogram,
    });
    if (runs !== clean) process.exitCode = 1;
  } finally {
    stage?.close();
    await hub.close();
    if (runtime) rmSync(runtime, { recursive: true, force: true });
    if (file) await new Promise((done, reject) => { file.once('error', reject); file.end(done); });
  }
}

main(readOptions(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
