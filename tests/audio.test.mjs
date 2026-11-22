// Deterministic tests for hub/audio.mjs and scripts/build-bank.mjs.
// No network: fetch and WebSocket are fakes. Bank-integrity tests read the real bundled files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEBOOK,
  CUES,
  DEFAULT_BANK_DIR,
  DEMO_DRAFTS,
  STOCK_VOICES,
  bankLines,
  codebookReadout,
  createAudio,
  inspectWav,
  loadBank,
  normalizeText,
} from '../hub/audio.mjs';
import { buildBank, planBank, silenceWav } from '../scripts/build-bank.mjs';

const KEY = 'sk_test_SECRETKEY1234567890abcdef';
const baseEnv = (extra = {}) => ({ ELEVENLABS_API_KEY: KEY, ...extra });
const ANNOUNCEMENT_LINES = ['Sound check. Can you hear me?', 'Show the working demo now.', 'Thirty seconds left.', 'Time to bring up the reveal.'];
const noNetwork = async () => {
  throw new Error('network must not be used');
};

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      path: u.pathname,
      query: u.searchParams,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
      json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  f.calls = calls;
  return f;
}
const audioRes = (text = 'x') => new Response(Buffer.from(`ID3-${text}`), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function makeWav(seconds, { amp = 0.3, rate = 16000 } = {}) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * amp * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

class FakeWS {
  static instances = [];
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.sent = [];
    this.listeners = {};
    this.closeCalls = 0;
    FakeWS.instances.push(this);
  }
  addEventListener(t, f) {
    (this.listeners[t] ||= []).push(f);
  }
  send(d) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closeCalls++;
    this.emit('close', {});
  }
  emit(t, ev) {
    for (const f of this.listeners[t] || []) f(ev);
  }
  open() {
    this.emit('open', {});
    this.message({ message_type: 'session_started' });
  }
  message(obj) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

// ------------------------------------------------------------------ text + bank

test('normalizeText is case/punctuation/apostrophe insensitive but keeps the Send prefix', () => {
  assert.equal(normalizeText('Send: The judge on the left looks lost?'), 'send the judge on the left looks lost');
  assert.equal(normalizeText("  I'm   GOOD, stay! "), normalizeText('Im good stay'));
  assert.notEqual(normalizeText('The judge on the left looks lost'), normalizeText('Send: The judge on the left looks lost?'));
});

test('bundled bank: eight distinct mp3 cues, silent keepalive, manifest matches files', async () => {
  const { manifest } = await loadBank(DEFAULT_BANK_DIR);
  assert.ok(manifest, 'bank.json present');
  assert.deepEqual(Object.keys(manifest.cues).sort(), [...CUES].sort());
  const hashes = new Set();
  for (const cue of CUES) {
    const buf = await readFile(path.join(DEFAULT_BANK_DIR, `cue-${cue}.mp3`));
    assert.ok(buf.length > 2000, `${cue} not empty`);
    assert.ok(buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0), `${cue} is mp3`);
    assert.equal(createHash('sha256').update(buf).digest('hex'), manifest.cues[cue].sha256, `${cue} hash matches manifest`);
    hashes.add(manifest.cues[cue].sha256);
  }
  assert.equal(hashes.size, 8, 'all eight cues are different files');

  const ka = await readFile(path.join(DEFAULT_BANK_DIR, 'keepalive.wav'));
  const info = inspectWav(ka);
  assert.ok(info.durationSec >= 0.5);
  assert.equal(info.rms, 0);
  assert.ok(ka.subarray(44).every((b) => b === 0), 'keepalive data is all zero samples');

  for (const line of manifest.lines) {
    const buf = await readFile(path.join(DEFAULT_BANK_DIR, line.file));
    assert.equal(createHash('sha256').update(buf).digest('hex'), line.sha256);
  }
  // every canonical line resolves for its voice role
  const b = await loadBank(DEFAULT_BANK_DIR);
  for (const l of bankLines()) assert.ok(b.lookup(l.role, l.text), `bank has ${l.role}/${l.kind}: ${l.text}`);
  assert.equal(manifest.lines.filter((l) => l.kind === 'fixed' && l.role === 'A').length, 12);
  assert.equal(manifest.lines.filter((l) => l.kind === 'fixed' && l.role === 'B').length, 12);
  assert.equal(manifest.voices.A.id, STOCK_VOICES.A.id);
  assert.notEqual(manifest.voices.A.id, manifest.voices.B.id);
});

test('canonical lines match the spec codebook and readouts differ by earbud mode', () => {
  assert.equal(CODEBOOK.Pitch.R1, 'Slow down');
  assert.equal(CODEBOOK.Party.OUT, "Let's leave");
  assert.equal(CODEBOOK.Meeting.L1, 'I agree, back it up');
  assert.match(codebookReadout('Pitch', 2), /Triple, Show the demo now/);
  assert.doesNotMatch(codebookReadout('Pitch', 1), /Show the demo now/);
  assert.equal(codebookReadout('Custom', 2), codebookReadout('Pitch', 2));
});

test('the bank plans each neutral operator announcement preset', () => {
  const announcements = bankLines().filter(line => line.kind === 'announcement');
  assert.deepEqual(announcements.map(line => line.text), ANNOUNCEMENT_LINES);
  assert.ok(announcements.every(line => line.role === 'assistant'));
  assert.equal(new Set(announcements.map(line => line.id)).size, ANNOUNCEMENT_LINES.length);
});

// ------------------------------------------------------------------ sim = bank only

test('sim buildCache uses the bank, never the network, and omits unknown lines', async () => {
  const assets = new Map();
  const a = createAudio({ assets, env: baseEnv(), fetchImpl: noNetwork, WebSocketImpl: FakeWS });
  const messages = { R1: 'Slow down', R2: 'One minute left', L1: 'Show the demo now', OUT: 'Wrap it up now' };
  const cache = await a.buildCache('A', 'Pitch', messages, { sim: true, activeId: 'g1' });
  assert.deepEqual(cache.filter((c) => c.key.startsWith('cue:')).map((c) => c.key), CUES.map((c) => `cue:${c}`));
  assert.equal(cache.find((c) => c.key === 'cue:soft').url, '/assets/cue-soft.mp3');
  for (const sig of ['R1', 'R2', 'L1', 'OUT']) {
    const hit = cache.find((c) => c.key === `A:Pitch:${sig}`);
    assert.match(hit.url, /^\/assets\/line-a-[0-9a-f]{10}\.mp3$/);
  }
  assert.equal(assets.size, 0, 'sim does not create dynamic assets');

  // Custom reuses Pitch text; text outside the bank is omitted, never replaced by another line
  const custom = await a.buildCache('B', 'Custom', { ...messages, R2: 'Something the bank never heard' }, { sim: true });
  assert.ok(custom.find((c) => c.key === 'B:Custom:R1'));
  assert.equal(custom.find((c) => c.key === 'B:Custom:R2'), undefined);
  assert.notEqual(custom.find((c) => c.key === 'B:Custom:R1').url, cache.find((c) => c.key === 'A:Pitch:R1').url, 'seat B uses its own stock voice');
  assert.ok(a.failures().some((f) => f.code === 'bank_miss'));
});

test('sim speech: exact or normalized text, per voice role, null on miss, zero network', async () => {
  const a = createAudio({ env: baseEnv(), fetchImpl: noNetwork, WebSocketImpl: FakeWS });
  const [d1, d2] = DEMO_DRAFTS;
  const exact = await a.speech('A', 'Send: Show the working demo now?', { sim: true, role: 'assistant' });
  const loose = await a.speech('A', 'send show the working demo now', { sim: true, role: 'assistant' });
  assert.ok(exact.url);
  assert.equal(exact.url, loose.url);
  const sender = await a.speech('B', d2, { sim: true });
  assert.ok(sender.url && sender.url !== exact.url, 'sender line is a different clip from the assistant prompt');
  assert.equal(await a.speech('A', 'Send: a sentence nobody recorded?', { sim: true, role: 'assistant' }), null);
  assert.equal(await a.speech('A', d1, { sim: true, role: 'assistant' }), null, 'plain sender text must not match the assistant prompt');
  const readout = await a.speech('A', codebookReadout('Party', 2), { sim: true, role: 'assistant' });
  assert.ok(readout.url);
  assert.equal(await a.mic('A', 'AAAA', 0.1, () => {}, { sim: true }).then((r) => r.sent), false);
  assert.equal(FakeWS.instances.length, 0, 'sim mic opens no socket');
});

test('operator announcements use prepared clips offline and the assistant whisper voice live', async () => {
  const bankDir = await mkdtemp(path.join(tmpdir(), 'tp-announcement-bank-'));
  const preset = ANNOUNCEMENT_LINES[0];
  await writeFile(path.join(bankDir, 'bank.json'), JSON.stringify({
    lines: [
      { role: 'assistant', text: preset, file: 'announcement.mp3' },
      { role: 'assistant', text: 'Preset switched.', file: 'status.mp3' },
    ],
  }));
  const fetchImpl = mockFetch(call => audioRes(call.json.text));
  const audio = createAudio({ env: baseEnv(), fetchImpl, bankDir, whisperModel: 'eleven_v4_turbo' });
  const bundled = { url: '/assets/announcement.mp3', source: 'bank' };
  assert.deepEqual(await audio.announcement(preset, { sim: true }), bundled);
  assert.equal((await audio.announcement(preset)).source, 'live');
  assert.equal(await audio.announcement('Preset switched.', { sim: true }), null, 'other bank clips are not operator presets');
  assert.equal(await audio.announcement('A custom line with no clip.', { sim: true }), null);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].json.text, '[whispers] ' + preset);

  const custom = await audio.announcement('Coach, ready at the front.');
  assert.equal(custom.source, 'live');
  assert.equal(fetchImpl.calls[1].path, '/v1/text-to-speech/' + STOCK_VOICES.assistant.id);
  assert.deepEqual(fetchImpl.calls[1].json, {
    text: '[whispers] Coach, ready at the front.', model_id: 'eleven_v4_turbo',
  });

  const override = createAudio({ env: baseEnv({ TELEPATHY_ASSISTANT_VOICE: 'customNeutral' }), fetchImpl, bankDir });
  assert.deepEqual(await override.announcement(preset, { sim: true }), bundled);
  assert.equal((await override.announcement(preset)).source, 'live');
  assert.equal(fetchImpl.calls.at(-1).path, '/v1/text-to-speech/customNeutral');
});

// ------------------------------------------------------------------ real TTS

test('real buildCache: per-line Flash TTS, key only in header, dedup, partial failure omitted', async () => {
  const f = mockFetch((c) => {
    if (c.json.text === 'One minute left') return jsonRes({ detail: { status: 'internal_error', message: `boom ${KEY}` } }, 500);
    return audioRes(c.json.text);
  });
  const assets = new Map();
  const a = createAudio({ assets, env: baseEnv(), fetchImpl: f });
  const messages = { R1: 'Slow down', R2: 'One minute left', L1: 'Show the demo now', OUT: 'Wrap it up now' };
  const cache = await a.buildCache('A', 'Pitch', messages, { voice: 'cloneA', activeId: 'g1' });
  assert.equal(f.calls.length, 4);
  for (const c of f.calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.path, '/v1/text-to-speech/cloneA');
    assert.equal(c.headers['xi-api-key'], KEY);
    assert.ok(!c.url.includes(KEY));
    assert.equal(c.json.model_id, 'eleven_flash_v2_5');
  }
  assert.deepEqual(cache.filter((c) => !c.key.startsWith('cue:')).map((c) => c.key).sort(), ['A:Pitch:L1', 'A:Pitch:OUT', 'A:Pitch:R1']);
  const url = cache.find((c) => c.key === 'A:Pitch:R1').url;
  const id = url.replace('/assets/', '');
  assert.match(id, /^tts-[0-9a-f]{20}\.mp3$/);
  assert.equal(assets.get(id).mime, 'audio/mpeg');
  assert.ok(Buffer.isBuffer(assets.get(id).buffer));
  assert.ok(a.failures().every((x) => !x.detail.includes(KEY)), 'failure details never contain the key');
  assert.ok(a.failures().some((x) => x.status === 500));

  const before = f.calls.length;
  await a.buildCache('A', 'Pitch', { R1: 'Slow down', L1: 'Show the demo now' }, { voice: 'cloneA', activeId: 'g2' });
  assert.equal(f.calls.length, before, 'already-synthesized lines are not requested again');
});

test('parallel seat builds and generation drops never delete assets still in use', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = mockFetch(async (c) => {
    if (c.path === '/v1/text-to-speech/cloneB' && c.json.text === 'Come find me') await gate;
    return audioRes(c.json.text);
  });
  const assets = new Map();
  const a = createAudio({ assets, env: baseEnv(), fetchImpl: f });
  const pa = a.buildCache('A', 'Pitch', { R1: 'Slow down' }, { voice: 'cloneA', activeId: 'a1' });
  const pb = a.buildCache('B', 'Party', { R1: 'Come find me', R2: "Let's leave" }, { voice: 'cloneB', activeId: 'b1' });
  const A1 = await pa; // A finishes while B still has a clip in flight
  release();
  const B1 = await pb;
  for (const c of [...A1, ...B1].filter((x) => !x.key.startsWith('cue:'))) assert.ok(assets.has(c.url.replace('/assets/', '')), `${c.key} still stored`);

  // three generations for A: the oldest is evicted, ids shared with newer generations survive
  const g2 = await a.buildCache('A', 'Pitch', { R1: 'Slow down', R2: 'One minute left' }, { voice: 'cloneA', activeId: 'a2' });
  const g3 = await a.buildCache('A', 'Pitch', { R2: 'One minute left' }, { voice: 'cloneA', activeId: 'a3' });
  const has = (u) => assets.has(u.replace('/assets/', ''));
  assert.ok(has(g3.find((c) => c.key === 'A:Pitch:R2').url));
  assert.ok(has(g2.find((c) => c.key === 'A:Pitch:R1').url), 'previous generation still available while the client switches');
  for (const c of B1.filter((x) => !x.key.startsWith('cue:'))) assert.ok(has(c.url), 'other seat untouched');
  const g4 = await a.buildCache('A', 'Pitch', { R2: 'One minute left' }, { voice: 'cloneA', activeId: 'a4' });
  assert.ok(has(g4.find((c) => c.key === 'A:Pitch:R2').url));
  assert.equal(has(A1.find((c) => c.key === 'A:Pitch:R1').url), false, 'line used only by dropped generations is evicted');
});

test('real buildCache falls back to env voice ids and does nothing without a voice', async () => {
  const f = mockFetch((c) => audioRes(c.json.text));
  const a = createAudio({ env: baseEnv({ TELEPATHY_VOICE_B: 'fallbackB' }), fetchImpl: f });
  await a.buildCache('B', 'Pitch', { R1: 'Slow down' }, { activeId: 'g1' });
  assert.equal(f.calls[0].path, '/v1/text-to-speech/fallbackB');
  const out = await a.buildCache('A', 'Pitch', { R1: 'Slow down' }, { activeId: 'g1' });
  assert.equal(out.length, CUES.length, 'cues only, no wrong-voice speech');
  assert.equal(f.calls.length, 1);
  const err = await a.buildCache('A', 'Pitch', { R1: 'Slow down' }, { voice: { id: null, status: 'error' } });
  assert.equal(err.length, CUES.length);
});

test('speech: assistant voice env override and default stock, seat voice, timeout returns null', async () => {
  const f = mockFetch((c) => audioRes(c.json.text));
  const a = createAudio({ env: baseEnv({ TELEPATHY_ASSISTANT_VOICE: 'asstX' }), fetchImpl: f });
  const r = await a.speech('A', 'Send: Slow down?', { role: 'assistant' });
  assert.match(r.url, /^\/assets\/tts-/);
  assert.equal(f.calls[0].path, '/v1/text-to-speech/asstX');
  const b = createAudio({ env: baseEnv(), fetchImpl: f });
  await b.speech('A', 'Preset switched.', { role: 'assistant' });
  assert.equal(f.calls[1].path, `/v1/text-to-speech/${STOCK_VOICES.assistant.id}`);
  await b.speech('A', 'Slow down', { voice: { id: 'cloneA', status: 'ready' } });
  assert.equal(f.calls[2].path, '/v1/text-to-speech/cloneA');

  const slow = createAudio({ env: baseEnv(), fetchImpl: () => new Promise(() => {}), ttsTimeoutMs: 25 });
  assert.equal(await slow.speech('A', 'Slow down', { voice: 'cloneA' }), null);
  const last = slow.failures().at(-1);
  assert.equal(last.code, 'timeout');
});

test('no api key and network errors fail quietly without leaking secrets', async () => {
  const a = createAudio({ env: {}, fetchImpl: noNetwork });
  assert.equal(await a.speech('A', 'Hi', { voice: 'v' }), null);
  assert.equal(a.failures().at(-1).code, 'no_key');
  const b = createAudio({
    env: baseEnv(),
    fetchImpl: async () => {
      throw new Error(`socket hang up while sending xi-api-key: ${KEY}`);
    },
  });
  assert.equal(await b.speech('A', 'Hi', { voice: 'v' }), null);
  const d = b.failures().at(-1).detail;
  assert.ok(!d.includes(KEY) && !d.includes('SECRETKEY'), d);
});

// ------------------------------------------------------------------ voice clone

test('makeVoice rejects unusable recordings before spending anything', async () => {
  const a = createAudio({ env: baseEnv(), fetchImpl: noNetwork });
  const short = await a.makeVoice('A', makeWav(1).toString('base64'), 'r1');
  assert.equal(short.status, 'error');
  assert.match(short.detail, /shorter/);
  const silent = await a.makeVoice('A', makeWav(8, { amp: 0 }).toString('base64'), 'r2');
  assert.equal(silent.status, 'error');
  assert.match(silent.detail, /silent/);
  const junk = await a.makeVoice('A', Buffer.from('not a wav at all, definitely not a wav file really').toString('base64'), 'r3');
  assert.equal(junk.status, 'error');
  assert.equal((await a.makeVoice('Z', 'x', 'r4')).status, 'error');
  const info = inspectWav(makeWav(6.5));
  assert.ok(Math.abs(info.durationSec - 6.5) < 0.01);
});

function cloneFetch({ addBody = { voice_id: 'clone1', requires_verification: false }, ttsStatus = 200, voiceIds = ['clone1', 'clone2'] } = {}) {
  let n = 0;
  return mockFetch((c) => {
    if (c.path === '/v1/voices/add') return jsonRes({ ...addBody, voice_id: voiceIds[n++] ?? `clone${n}` });
    if (c.path.startsWith('/v1/text-to-speech/')) {
      return ttsStatus === 200 ? audioRes('check') : jsonRes({ detail: { status: 'detected_captcha_voice', message: 'This voice requires verification.' } }, ttsStatus);
    }
    if (c.method === 'DELETE') return new Response('{}', { status: 200 });
    return jsonRes({}, 404);
  });
}

test('makeVoice happy path: multipart add, test TTS, ready; only app clones are removable', async () => {
  const f = cloneFetch();
  const a = createAudio({ env: baseEnv({ TELEPATHY_VOICE_A: 'envA', TELEPATHY_VOICE_B: 'envB' }), fetchImpl: f });
  const r = await a.makeVoice('A', makeWav(6).toString('base64'), 'req-9');
  assert.deepEqual({ id: r.id, status: r.status }, { id: 'clone1', status: 'ready' });
  const add = f.calls[0];
  assert.equal(add.path, '/v1/voices/add');
  assert.ok(add.body instanceof FormData);
  assert.match(add.body.get('name'), /^TELEPATHY-APP-A-req-9-/);
  assert.equal(add.body.get('files').type, 'audio/wav');
  assert.equal(add.headers['xi-api-key'], KEY);
  assert.equal(f.calls[1].path, '/v1/text-to-speech/clone1', 'verified with a real test TTS');
  assert.deepEqual(a.createdVoices(), ['clone1']);

  assert.equal((await a.removeVoice('envA')).removed, false);
  assert.equal((await a.removeVoice('somebody-elses-voice')).removed, false);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);

  const r2 = await a.makeVoice('A', makeWav(6).toString('base64'), 'req-10');
  assert.equal(r2.id, 'clone2');
  const deletes = f.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  assert.deepEqual(deletes, ['/v1/voices/clone1'], 're-record replaces the old app clone');

  const res = await a.reset();
  assert.deepEqual(res.removed, ['clone2']);
  assert.ok(f.calls.filter((c) => c.method === 'DELETE').every((c) => !/env[AB]/.test(c.path)));
  assert.deepEqual(a.createdVoices(), []);
});

test('makeVoice: captcha 401 deletes the clone and returns a labeled fallback, or error without one', async () => {
  const f = cloneFetch({ ttsStatus: 401 });
  const a = createAudio({ env: baseEnv({ TELEPATHY_VOICE_A: 'envA' }), fetchImpl: f });
  const r = await a.makeVoice('A', makeWav(6).toString('base64'), 'x');
  assert.equal(r.status, 'fallback');
  assert.equal(r.id, 'envA');
  assert.match(r.detail, /fallback voice envA/);
  assert.match(r.detail, /detected_captcha_voice/);
  assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/voices/clone1'));
  assert.deepEqual(a.createdVoices(), []);

  const g = cloneFetch({ ttsStatus: 401 });
  const b = createAudio({ env: baseEnv(), fetchImpl: g });
  const e = await b.makeVoice('B', makeWav(6).toString('base64'), 'x');
  assert.equal(e.status, 'error');
  assert.equal(e.id, null);

  const v = cloneFetch({ addBody: { requires_verification: true } });
  const c = createAudio({ env: baseEnv({ TELEPATHY_VOICE_B: 'envB' }), fetchImpl: v });
  const rv = await c.makeVoice('B', makeWav(6).toString('base64'), 'y');
  assert.equal(rv.status, 'fallback');
  assert.equal(v.calls.filter((x) => x.path.startsWith('/v1/text-to-speech')).length, 0, 'no TTS spend on a clone that needs verification');
});

test('makeVoice: a newer request for the same seat supersedes the older one', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let n = 0;
  const f = mockFetch(async (c) => {
    if (c.path === '/v1/voices/add') {
      const mine = ++n;
      if (mine === 1) await gate;
      return jsonRes({ voice_id: `clone${mine}`, requires_verification: false });
    }
    if (c.path.startsWith('/v1/text-to-speech/')) return audioRes();
    return new Response('{}', { status: 200 });
  });
  const a = createAudio({ env: baseEnv(), fetchImpl: f });
  const first = a.makeVoice('A', makeWav(6).toString('base64'), 'old');
  await new Promise((r) => setTimeout(r, 5));
  const second = await a.makeVoice('A', makeWav(6).toString('base64'), 'new');
  release();
  const firstRes = await first;
  assert.equal(second.status, 'ready');
  assert.equal(firstRes.status, 'error');
  assert.match(firstRes.detail, /superseded/);
  assert.deepEqual(a.createdVoices(), [second.id]);
});

test('reset deletes app clones only and never env or stock voice ids', async () => {
  const f = cloneFetch();
  const a = createAudio({ env: baseEnv({ TELEPATHY_VOICE_A: 'clone1' }), fetchImpl: f }); // env id collides with a clone id on purpose
  const r = await a.makeVoice('A', makeWav(6).toString('base64'), 'q');
  assert.equal(r.status, 'ready');
  const out = await a.reset();
  assert.deepEqual(out.removed, []);
  assert.ok(f.calls.every((c) => c.method !== 'DELETE'), 'a protected id is never deleted');
  assert.equal((await a.removeVoice(STOCK_VOICES.A.id)).removed, false);
});

test('ledger sweep only removes TELEPATHY-APP clones left by a crashed run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-ledger-'));
  const ledgerPath = path.join(dir, 'voices.json');
  await writeFile(ledgerPath, JSON.stringify([{ id: 'orphan', seat: 'A' }, { id: 'envA', seat: 'A' }, { id: 'stranger', seat: 'B' }]));
  const f = mockFetch((c) => {
    if (c.method === 'DELETE') return new Response('{}', { status: 200 });
    if (c.path === '/v1/voices/orphan') return jsonRes({ voice_id: 'orphan', name: 'TELEPATHY-APP-A-1', category: 'cloned' });
    if (c.path === '/v1/voices/stranger') return jsonRes({ voice_id: 'stranger', name: 'My real voice', category: 'cloned' });
    return jsonRes({}, 404);
  });
  const a = createAudio({ env: baseEnv({ TELEPATHY_VOICE_A: 'envA' }), fetchImpl: f, ledgerPath });
  await a.sweepLedger();
  assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/v1/voices/orphan']);
  await assert.rejects(readFile(ledgerPath, 'utf8'), { code: 'ENOENT' });
});

// ------------------------------------------------------------------ realtime STT

async function sttRig(opts = {}) {
  FakeWS.instances.length = 0;
  let t = 1000;
  const clock = { advance: (ms) => (t += ms) };
  const a = createAudio({ env: baseEnv(), fetchImpl: noNetwork, WebSocketImpl: FakeWS, now: () => t, ...opts });
  return { a, clock };
}

test('STT: shared room microphone has its own stream and reset rejects late transcripts', async () => {
  const { a } = await sttRig();
  const received = [];
  await a.listen('room', true, { committed: text => received.push(text), partial: text => received.push('partial:' + text) });
  await a.mic('room', 'QUJD', 0.2);
  const socket = FakeWS.instances[0];
  socket.open();
  socket.message({ message_type: 'partial_transcript', text: 'Who buys' });
  socket.message({ message_type: 'committed_transcript', text: 'Who buys it?' });
  assert.deepEqual(received, ['partial:Who buys', 'Who buys it?']);
  await a.reset();
  socket.message({ message_type: 'committed_transcript', text: 'late' });
  assert.equal(received.length, 2);
});

test('STT: lazy socket per seat, PCM16 16 kHz + vad, committed text delivered, partials opt-in', async () => {
  const { a } = await sttRig();
  const gotA = [];
  const gotB = [];
  await a.listen('A', true, (t) => gotA.push(t));
  assert.equal(FakeWS.instances.length, 0, 'no socket until real mic audio');
  await a.mic('A', 'QUJD', 0.2);
  await a.mic('B', 'REVG', 0.2, (t) => gotB.push(t));
  assert.equal(FakeWS.instances.length, 2, 'independent socket per seat');
  const [wa, wb] = FakeWS.instances;
  const url = new URL(wa.url);
  assert.equal(url.host, 'api.elevenlabs.io');
  assert.equal(url.pathname, '/v1/speech-to-text/realtime');
  assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(url.searchParams.get('audio_format'), 'pcm_16000');
  assert.equal(url.searchParams.get('commit_strategy'), 'vad');
  assert.equal(wa.opts.headers['xi-api-key'], KEY);
  assert.ok(!wa.url.includes(KEY));
  wa.open();
  wb.open();
  assert.deepEqual(wa.sent[0], { message_type: 'input_audio_chunk', audio_base_64: 'QUJD', commit: false, sample_rate: 16000 });
  await a.mic('A', 'Zm9v', 0.2);
  assert.equal(wa.sent.length, 2);
  wa.message({ message_type: 'partial_transcript', text: 'hel' });
  wa.message({ message_type: 'committed_transcript', text: ' hello there ' });
  wa.message({ message_type: 'committed_transcript_with_timestamps', text: 'hello there', words: [] });
  wb.message({ message_type: 'committed_transcript', text: 'other room' });
  assert.deepEqual(gotA, ['hello there'], 'one callback per commit, no timestamp duplicate, no partial');
  assert.deepEqual(gotB, ['other room']);
});

test('STT: partial callback dedups repeats and empty keepalives', async () => {
  const { a } = await sttRig();
  const partials = [];
  const committed = [];
  await a.listen('A', true, { partial: (t) => partials.push(t), committed: (t) => committed.push(t) });
  await a.mic('A', 'QUJD', 0.2);
  const w = FakeWS.instances[0];
  w.open();
  for (const text of ['', 'he', 'he', '', 'hell']) w.message({ message_type: 'partial_transcript', text });
  w.message({ message_type: 'committed_transcript', text: 'hello' });
  assert.deepEqual(partials, ['he', 'hell']);
  assert.deepEqual(committed, ['hello']);
});

test('STT: listen(false) and reset close sockets, drop late frames and clear state', async () => {
  const { a } = await sttRig();
  const got = [];
  await a.listen('A', true, (t) => got.push(t));
  await a.mic('A', 'QUJD', 0.2);
  const w = FakeWS.instances[0];
  w.open();
  await a.listen('A', false);
  assert.equal(w.closeCalls, 1);
  w.message({ message_type: 'committed_transcript', text: 'late words' });
  assert.deepEqual(got, [], 'nothing delivered after listen(false)');
  assert.equal((await a.mic('A', 'QUJD', 0.2)).sent, false);
  assert.equal(FakeWS.instances.length, 1, 'no reconnect after listen(false)');

  await a.listen('B', true, (t) => got.push(t));
  await a.mic('B', 'QUJD', 0.2);
  const wb = FakeWS.instances[1];
  wb.open();
  await a.reset();
  assert.equal(wb.closeCalls, 1);
  wb.message({ message_type: 'committed_transcript', text: 'after reset' });
  assert.deepEqual(got, []);
  assert.equal((await a.mic('B', 'QUJD', 0.2)).sent, false, 'late mic after reset is ignored until listen(true)');
});

test('STT: reconnect with backoff, bounded and age-limited queue while down', async () => {
  const { a, clock } = await sttRig({ maxQueuedChars: 8, queueMaxAgeMs: 1500, reconnectBaseMs: 500 });
  const got = [];
  await a.listen('A', true, (t) => got.push(t));
  await a.mic('A', 'AAAA', 0.2);
  const w1 = FakeWS.instances[0];
  w1.open();
  w1.emit('close', {}); // server dropped us
  await a.mic('A', 'BBBB', 0.2);
  await a.mic('A', 'CCCC', 0.2);
  await a.mic('A', 'DDDD', 0.2);
  assert.equal(FakeWS.instances.length, 1, 'still backing off');
  clock.advance(600);
  await a.mic('A', 'EEEE', 0.2);
  assert.equal(FakeWS.instances.length, 2, 'reconnected after backoff');
  const w2 = FakeWS.instances[1];
  w2.open();
  // queue cap is 8 chars: only the newest two chunks survive (DDDD, EEEE)
  assert.deepEqual(w2.sent.map((s) => s.audio_base_64), ['DDDD', 'EEEE']);
  w2.message({ message_type: 'committed_transcript', text: 'back online' });
  assert.deepEqual(got, ['back online']);
});

test('STT: fatal auth/quota errors stop reconnecting and never leak the key', async () => {
  const { a, clock } = await sttRig();
  await a.listen('A', true, () => {});
  await a.mic('A', 'AAAA', 0.2);
  const w = FakeWS.instances[0];
  w.open();
  w.message({ message_type: 'auth_error', error: `bad key ${KEY}` });
  clock.advance(60000);
  await a.mic('A', 'BBBB', 0.2);
  assert.equal(FakeWS.instances.length, 1);
  const f = a.failures().at(-1);
  assert.equal(f.code, 'auth_error');
  assert.ok(!f.detail.includes(KEY));

  const { a: b } = await sttRig();
  await b.listen('A', true, () => {});
  await b.mic('A', 'AAAA', 0.2);
  const w2 = FakeWS.instances[0];
  w2.emit('error', { message: `Unexpected server response: 401 ${KEY}` });
  w2.emit('close', {});
  assert.ok(!b.failures().at(-1).detail.includes(KEY));
  assert.equal(b.failures().at(-1).code, 'auth_error');
});

test('STT: transient scribe errors reconnect; no key means no socket', async () => {
  const { a, clock } = await sttRig();
  await a.listen('A', true, () => {});
  await a.mic('A', 'AAAA', 0.2);
  const w = FakeWS.instances[0];
  w.open();
  w.message({ message_type: 'insufficient_audio_activity', error: 'idle' });
  w.emit('close', {});
  clock.advance(600);
  await a.mic('A', 'BBBB', 0.2);
  assert.equal(FakeWS.instances.length, 2);

  FakeWS.instances.length = 0;
  const nk = createAudio({ env: {}, fetchImpl: noNetwork, WebSocketImpl: FakeWS });
  await nk.listen('A', true, () => {});
  assert.equal((await nk.mic('A', 'AAAA', 0.2)).sent, false);
  assert.equal(FakeWS.instances.length, 0);
  assert.equal(nk.failures().at(-1).code, 'no_key');
});

// ------------------------------------------------------------------ bank builder

function bankFetch() {
  return mockFetch((c) => {
    if (c.path === '/v1/sound-generation') return audioRes(`sfx-${c.json.text}`);
    if (c.path.startsWith('/v1/text-to-speech/')) return audioRes(`tts-${c.path}-${c.json.text}`);
    if (c.path === '/v1/voices') return jsonRes({ voices: Object.values(STOCK_VOICES).map((v) => ({ voice_id: v.id })) });
    if (c.path === '/v1/user/subscription') return jsonRes({ character_count: 1 });
    return jsonRes({}, 404);
  });
}

test('build-bank: dry run spends nothing, run is one request per file, rerun is a no-op', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-bank-'));
  const quiet = () => {};
  const none = mockFetch(() => jsonRes({}, 500));
  const dry = await buildBank({ dir, dryRun: true, env: baseEnv(), fetchImpl: none, log: quiet });
  assert.equal(none.calls.length, 0);
  assert.equal(dry.sfxRequests, 8);
  const expectedLines = (await planBank(dir)).lines.length;
  assert.equal(dry.ttsRequests, expectedLines);

  const f = bankFetch();
  await buildBank({ dir, env: baseEnv(), fetchImpl: f, log: quiet });
  assert.equal(f.calls.filter((c) => c.path === '/v1/sound-generation').length, 8);
  assert.equal(f.calls.filter((c) => c.path.startsWith('/v1/text-to-speech/')).length, expectedLines);
  const announcement_calls = f.calls.filter(call => ANNOUNCEMENT_LINES.includes(call.json?.text));
  assert.equal(announcement_calls.length, ANNOUNCEMENT_LINES.length);
  assert.ok(announcement_calls.every(call => call.path === '/v1/text-to-speech/' + STOCK_VOICES.assistant.id
    && call.json.model_id === 'eleven_flash_v2_5'));
  for (const c of f.calls.filter((x) => x.path === '/v1/sound-generation')) assert.ok(c.json.duration_seconds >= 0.5 && c.json.duration_seconds <= 2, 'short explicit durations');
  assert.ok(f.calls.every((c) => !c.url.includes(KEY)));
  const files = await readdir(dir);
  assert.ok(files.includes('keepalive.wav') && files.includes('bank.json'));
  assert.equal(files.filter((n) => n.startsWith('cue-')).length, 8);

  const g = bankFetch();
  await buildBank({ dir, env: baseEnv(), fetchImpl: g, log: quiet });
  assert.equal(g.calls.filter((c) => c.path === '/v1/sound-generation' || c.path.startsWith('/v1/text-to-speech/')).length, 0, 'existing files are never regenerated');

  const h = bankFetch();
  await buildBank({ dir, env: baseEnv(), fetchImpl: h, log: quiet, only: 'cues', regen: ['back'] });
  assert.equal(h.calls.filter((c) => c.path === '/v1/sound-generation').length, 1, 'explicit single-cue regen only');
});

test('build-bank: failures never include the api key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-bank-'));
  const f = mockFetch(() => jsonRes({ detail: { status: 'invalid_api_key', message: `key ${KEY} rejected` } }, 401));
  await assert.rejects(
    () => buildBank({ dir, env: baseEnv(), fetchImpl: f, log: () => {} }),
    (err) => {
      assert.ok(!err.message.includes(KEY), err.message);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test('silenceWav is a valid WAV whose samples are all zero', () => {
  const w = silenceWav();
  const info = inspectWav(w);
  assert.equal(info.rms, 0);
  assert.equal(info.bits, 16);
  assert.ok(w.subarray(44).every((b) => b === 0));
});

test('hub can use the named bundled ElevenLabs fallback without a cloned voice or API key', async () => {
  const audio = createAudio({ env: {}, fetchImpl: noNetwork, allowBundledFallback: true });
  const manifest = await audio.buildCache('B', 'Pitch', CODEBOOK.Pitch);
  assert.ok(manifest.some(item => item.key === 'B:Pitch:R1' && item.url.startsWith('/assets/line-b-')));
  const speech = await audio.speech('B', 'The judge on the left looks lost');
  assert.equal(speech.source, 'bank');
  assert.equal((await audio.listen('B', true)).listening, false);
});

test('tagged ElevenLabs whisper is used for real seat speech and falls back within ElevenLabs', async () => {
  const fetch_impl = mockFetch(call => call.json.model_id === 'eleven_v4_turbo' && call.json.text.includes('Slow down')
    ? jsonRes({ detail: { status: 'model_unavailable' } }, 400)
    : audioRes(call.json.text));
  const audio = createAudio({ env: baseEnv(), fetchImpl: fetch_impl, whisperModel: 'eleven_v4_turbo' });
  const cache = await audio.buildCache('B', 'Pitch', { R1: 'Slow down' }, { voice: 'coachClone' });
  assert.ok(cache.some(item => item.key === 'B:Pitch:R1'));
  assert.deepEqual(fetch_impl.calls.map(call => [call.path, call.json.model_id, call.json.text]), [
    ['/v1/text-to-speech/coachClone', 'eleven_v4_turbo', '[whispers] Slow down'],
    ['/v1/text-to-speech/coachClone', 'eleven_flash_v2_5', 'Slow down'],
  ]);
  await audio.speech('B', 'Send: Wrap up?', { role: 'assistant' });
  assert.equal(fetch_impl.calls.at(-1).json.model_id, 'eleven_v4_turbo');
  assert.equal(fetch_impl.calls.at(-1).json.text, '[whispers] Send: Wrap up?');
});

test('superseding one TTS caller does not cancel a cache build for the same line', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetch_impl = mockFetch(async () => {
    await gate;
    return audioRes('slow down');
  });
  const assets = new Map();
  const audio = createAudio({ assets, env: baseEnv(), fetchImpl: fetch_impl });
  const previous = new AbortController();
  const current = new AbortController();
  const messages = { R1: 'Slow down' };
  const obsolete_build = audio.buildCache('A', 'Pitch', messages, { voice: 'cloneA', activeId: 'old', signal: previous.signal });
  const live_build = audio.buildCache('A', 'Pitch', messages, { voice: 'cloneA', activeId: 'new', signal: current.signal });
  previous.abort();
  release();
  const [old_cache, new_cache] = await Promise.all([obsolete_build, live_build]);
  const line = new_cache.find(item => item.key === 'A:Pitch:R1');
  assert.ok(line, 'the current cache may still use the shared result');
  assert.ok(assets.has(line.url.slice('/assets/'.length)));
  assert.equal(old_cache.some(item => item.key === 'A:Pitch:R1'), false);
  assert.equal(fetch_impl.calls.length, 1);
});

test('an active cache can be served after multiple candidate generations are abandoned', async () => {
  const assets = new Map();
  const audio = createAudio({ assets, env: baseEnv(), fetchImpl: mockFetch(() => audioRes()) });
  audio.setCacheGenerations?.(null, 'active');
  const options = { voice: 'cloneA', activeId: 'active' };
  const old = await audio.buildCache('A', 'Pitch', { R1: 'Slow down' }, options);
  const old_asset = old.find(item => item.key === 'A:Pitch:R1').url.slice('/assets/'.length);
  audio.setCacheGenerations?.('active', null);
  for (const generation of ['candidate1', 'candidate2', 'candidate3']) {
    audio.setCacheGenerations?.('active', generation);
    const candidate = await audio.buildCache('A', 'Party', { R1: generation }, { ...options, activeId: generation });
    const asset = candidate.find(item => item.key === 'A:Party:R1').url.slice('/assets/'.length);
    audio.setCacheGenerations?.('active', null);
    assert.ok(assets.has(old_asset), 'a reconnect can still fetch the last acknowledged generation');
    if (generation === 'candidate3') assert.deepEqual([...assets.keys()], [old_asset], 'abandoned assets can be reclaimed');
    assert.notEqual(asset, old_asset);
  }
});

test('last delivered audio can replay across a cache swap and releases on the next delivery', async () => {
  const assets = new Map();
  const audio = createAudio({ assets, env: baseEnv(), fetchImpl: mockFetch(() => audioRes()) });
  audio.setCacheGenerations('old', 'next');
  const old_cache = await audio.buildCache('A', 'Pitch', { R1: 'Slow down', R2: 'One minute left' }, { voice: 'cloneA', activeId: 'old' });
  const delivered = old_cache.find(item => item.key === 'A:Pitch:R1').url;
  const skipped = old_cache.find(item => item.key === 'A:Pitch:R2').url;
  const next_cache = await audio.buildCache('A', 'Party', { R1: 'Come find me' }, { voice: 'cloneA', activeId: 'next' });
  const current = next_cache.find(item => item.key === 'A:Party:R1').url;
  audio.retainReplayAsset?.(delivered);
  audio.setCacheGenerations('next', null);
  assert.ok(assets.has(delivered.slice('/assets/'.length)), 'last delivered audio stays available');
  assert.equal(assets.has(skipped.slice('/assets/'.length)), false, 'other audio from the retired cache is released');
  audio.retainReplayAsset?.('/assets/line-bundled.mp3');
  assert.deepEqual([...assets.keys()], [current.slice('/assets/'.length)]);
  await audio.reset();
  assert.equal(assets.size, 0);
});

test('reset awaits an in-flight clone create and deletes its resulting ID once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetch_impl = mockFetch(async call => {
    if (call.path === '/v1/voices/add') {
      await gate;
      return jsonRes({ voice_id: 'lateClone' });
    }
    return jsonRes({});
  });
  const audio = createAudio({ env: baseEnv(), fetchImpl: fetch_impl });
  const creating = audio.makeVoice('A', makeWav(6), 'upload-during-reset');
  let complete = false;
  const resetting = audio.reset().then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  const reset_finished_early = complete;
  release();
  const result = await creating;
  await resetting;
  assert.equal(reset_finished_early, false, 'shutdown waits for known remote cleanup');
  assert.equal(result.status, 'error');
  assert.deepEqual(audio.createdVoices(), []);
  assert.deepEqual(fetch_impl.calls.map(call => [call.method, call.path]), [
    ['POST', '/v1/voices/add'],
    ['DELETE', '/v1/voices/lateClone'],
  ]);
});

test('reset aborts clone verification and coalesces concurrent deletion of that clone', async () => {
  let verification_started;
  const verifying = new Promise(resolve => { verification_started = resolve; });
  let release;
  const deletion_gate = new Promise(resolve => { release = resolve; });
  const fetch_impl = mockFetch(async call => {
    if (call.path === '/v1/voices/add') return jsonRes({ voice_id: 'verifyingClone' });
    if (call.path === '/v1/text-to-speech/verifyingClone') {
      verification_started();
      return new Promise(() => {});
    }
    await deletion_gate;
    return jsonRes({});
  });
  const audio = createAudio({ env: baseEnv(), fetchImpl: fetch_impl });
  const creating = audio.makeVoice('A', makeWav(6), 'verification-race');
  await verifying;
  const resetting = audio.reset();
  const removing = audio.removeVoice('verifyingClone');
  release();
  const [clone] = await Promise.all([creating, resetting, removing]);
  assert.equal(clone.status, 'error');
  assert.deepEqual(audio.createdVoices(), []);
  assert.equal(fetch_impl.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('clone recovery reads the interrupted ledger write and ignores invalid ledger rows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-ledger-interrupted-'));
  const ledger_path = path.join(dir, 'voices.json');
  await writeFile(ledger_path, JSON.stringify({ invalid: 'old data' }));
  await writeFile(ledger_path + '.next', JSON.stringify([null, { id: 'stranded', seat: 'A' }]));
  const fetch_impl = mockFetch(call => {
    if (call.method === 'DELETE') return jsonRes({});
    return jsonRes({ name: 'TELEPATHY-APP-A-stranded', category: 'cloned' });
  });
  const audio = createAudio({ env: baseEnv(), fetchImpl: fetch_impl, ledgerPath: ledger_path });
  assert.deepEqual(await audio.sweepLedger(), { removed: ['stranded'] });
  assert.deepEqual(fetch_impl.calls.map(call => [call.method, call.path]), [
    ['GET', '/v1/voices/stranded'],
    ['DELETE', '/v1/voices/stranded'],
  ]);
  await assert.rejects(readFile(ledger_path + '.next', 'utf8'), { code: 'ENOENT' });
});

test('STT: open socket without Scribe session acceptance times out and retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const statuses = [];
  const { a, clock } = await sttRig({ handshakeTimeoutMs: 200, onTranscriptionStatus: entry => statuses.push(entry) });
  await a.listen('A', true, () => {});
  await a.mic('A', 'AAAA', 0.2);
  const stalled = FakeWS.instances[0];
  stalled.emit('open', {});
  t.mock.timers.tick(201);
  clock.advance(800);
  await a.mic('A', 'BBBB', 0.2);
  assert.equal(FakeWS.instances.length, 2, 'subsequent mic frames open a new session after backoff');
  assert.equal(stalled.closeCalls, 1);
  assert.equal(stalled.sent.length, 0, 'private PCM waits for a Scribe session');
  const recovered = FakeWS.instances[1];
  recovered.emit('open', {});
  recovered.message({ message_type: 'session_started' });
  assert.deepEqual(recovered.sent.map(chunk => chunk.audio_base_64), ['BBBB']);
  assert.deepEqual(statuses.map(entry => entry.status), ['waiting', 'connecting', 'recovering', 'connecting', 'live']);
  await a.reset();
});

test('STT: a queue flush send failure detaches the socket and reconnects', async () => {
  const { a, clock } = await sttRig();
  await a.listen('A', true, () => {});
  await a.mic('A', 'AAAA', 0.2);
  const failed = FakeWS.instances[0];
  failed.send = () => { throw new Error('socket closed during send'); };
  assert.doesNotThrow(() => failed.open());
  assert.equal(failed.closeCalls, 1);
  clock.advance(600);
  await a.mic('A', 'BBBB', 0.2);
  assert.equal(FakeWS.instances.length, 2);
  await a.reset();
});

test('STT: a previously live socket that stops replying to heartbeat recovers', async () => {
  const { a, clock } = await sttRig({ scribePingMs: 1000, scribePongTimeoutMs: 500 });
  await a.listen('B', true, () => {});
  await a.mic('B', 'AAAA', 0.2);
  const stalled = FakeWS.instances[0];
  let pings = 0;
  stalled.ping = () => { pings++; };
  stalled.open();
  clock.advance(1010);
  await a.mic('B', 'BBBB', 0.2);
  assert.equal(pings, 1);
  stalled.emit('pong', {});
  clock.advance(1010);
  await a.mic('B', 'CCCC', 0.2);
  assert.equal(pings, 2);
  clock.advance(501);
  await a.mic('B', 'DDDD', 0.2);
  assert.equal(stalled.closeCalls, 1);
  assert.deepEqual(stalled.sent.map(chunk => chunk.audio_base_64), ['AAAA', 'BBBB', 'CCCC']);
  clock.advance(501);
  await a.mic('B', 'EEEE', 0.2);
  assert.equal(FakeWS.instances.length, 2);
  const recovered = FakeWS.instances[1];
  recovered.open();
  assert.deepEqual(recovered.sent.map(chunk => chunk.audio_base_64), ['DDDD', 'EEEE']);
  await a.reset();
});
