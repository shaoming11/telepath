// ElevenLabs-only audio adapter for the Telepathy hub.
//
// Every voice/audio feature here is an ElevenLabs call (TTS, voice clone, Scribe
// Realtime v2, sound effects at build time) or a pre-generated ElevenLabs file from
// public/assets. No browser synthesis, no OS speech. Sim seats read the bundled bank
// only and never touch the network.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announcementText, OPERATOR_ANNOUNCEMENTS } from '../public/announcements.mjs';

// ---------------------------------------------------------------- constants

export const CUES = Object.freeze(['soft', 'urgent', 'draft', 'sent', 'receipt', 'error', 'system', 'back']);
export const cueFile = (cue) => `cue-${cue}.mp3`;
export const cueUrl = (cue) => `/assets/${cueFile(cue)}`;
export const KEEPALIVE_URL = '/assets/keepalive.wav';
export const SIGNALS = Object.freeze(['R1', 'R2', 'L1', 'OUT']);

export const DEFAULT_BANK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
export const TTS_MODEL = 'eleven_flash_v2_5';
export const TTS_FORMAT = 'mp3_44100_64';
export const STT_MODEL = 'scribe_v2_realtime';

// Premade stock ElevenLabs voices used by the bundled bank (verified present on the
// account via GET /v1/voices). Assistant is the neutral voice for drafts, readouts, status.
export const STOCK_VOICES = Object.freeze({
  A: Object.freeze({ id: 'nPczCjzI2devNBz1zQrb', name: 'Brian' }),
  B: Object.freeze({ id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' }),
  assistant: Object.freeze({ id: 'SAz9YHcvj6GT2YYXdXww', name: 'River' }),
});

// Fixed codebook from docs/spec.md. Custom reuses Pitch.
export const CODEBOOK = Object.freeze({
  Pitch: Object.freeze({ R1: 'Slow down', R2: 'One minute left', L1: 'Show the demo now', OUT: 'Wrap it up now' }),
  Party: Object.freeze({ R1: 'Come find me', R2: 'Save me from this conversation', L1: "I'm good, stay", OUT: "Let's leave" }),
  Meeting: Object.freeze({ R1: 'Are you following?', R2: "Let's talk after", L1: 'I agree, back it up', OUT: "I'm stepping out" }),
});
export const BANK_PRESETS = Object.freeze(['Pitch', 'Party', 'Meeting']);

// Canned sim drafts: assistant says "Send: <x>?", the sender voice later says "<x>".
export const DEMO_DRAFTS = Object.freeze(['The judge on the left looks lost', 'Show the working demo now']);
export const draftPrompt = (text) => `Send: ${text}?`;

export const STATUS_LINES = Object.freeze({
  sounds_like_pitch: 'Sounds like a pitch. Use one gesture to switch.',
  sounds_like_party: 'Sounds like a party. Use one gesture to switch.',
  sounds_like_meeting: 'Sounds like a meeting. Use one gesture to switch.',
  switched: 'Preset switched.',
  test_left: 'This is the left earbud.',
  test_right: 'This is the right earbud.',
});

// Codebook readout (L2). Earbud mode matters: one-earbud mode has no L1. Spoken at
// READOUT_SPEED so the longest preset stays near the spec's 5 s budget.
export const READOUT_SPEED = 1.2;
const clause = (label, t) => (/[.?!]$/.test(t) ? `${label}, ${t}` : `${label}, ${t}.`);
const TWO_EAR_SHORT_READOUT = Object.freeze({
  Party: "Single, Find me. Double, Rescue me. Triple, I'm good. Out, Leave.",
  Meeting: "Single, Following? Double, Talk later. Triple, Back me up. Out, Stepping out.",
});
export function codebookReadout(preset, mode = 2) {
  if (mode === 2 && Object.hasOwn(TWO_EAR_SHORT_READOUT, preset)) return TWO_EAR_SHORT_READOUT[preset];
  const cb = CODEBOOK[BANK_PRESETS.includes(preset) ? preset : 'Pitch'];
  const parts = mode === 1 ? [['Tap', cb.R1], ['Double tap', cb.R2], ['Out', cb.OUT]] : [['Single', cb.R1], ['Double', cb.R2], ['Triple', cb.L1], ['Out', cb.OUT]];
  return parts.map(([label, t]) => clause(label, t)).join(' ');
}

// Single source of truth for every bundled speech line (used by build-bank + tests).
export function bankLines() {
  const lines = [];
  for (const seat of ['A', 'B']) {
    for (const preset of BANK_PRESETS) {
      for (const sig of SIGNALS) lines.push({ role: seat, kind: 'fixed', preset, signal: sig, text: CODEBOOK[preset][sig] });
    }
    for (const d of DEMO_DRAFTS) lines.push({ role: seat, kind: 'sent_draft', text: d });
  }
  for (const d of DEMO_DRAFTS) lines.push({ role: 'assistant', kind: 'draft', text: draftPrompt(d) });
  for (const preset of BANK_PRESETS) {
    for (const mode of [2, 1]) lines.push({ role: 'assistant', kind: 'codebook', preset, mode, speed: READOUT_SPEED, text: codebookReadout(preset, mode) });
  }
  for (const [id, text] of Object.entries(STATUS_LINES)) lines.push({ role: 'assistant', kind: 'status', id, text });
  for (const { id, text } of OPERATOR_ANNOUNCEMENTS) lines.push({ role: 'assistant', kind: 'announcement', id, text });
  return lines;
}

// Case, punctuation, apostrophe and whitespace insensitive. Deliberately keeps words
// (e.g. the "Send" prefix) so a draft prompt never matches the plain sender line.
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const bankFileName = (role, voiceId, text, speed = 1) =>
  `line-${role === 'assistant' ? 'asst' : role.toLowerCase()}-${sha(`${voiceId}|${TTS_MODEL}|${speed === 1 ? '' : `${speed}|`}${normalizeText(text)}`, 10)}.mp3`;

// ---------------------------------------------------------------- small utils

function sha(s, n = 16) {
  return createHash('sha256').update(s).digest('hex').slice(0, n);
}
const isSeat = (s) => s === 'A' || s === 'B';
const toBase64 = (audio) => {
  if (typeof audio === 'string') return audio.replace(/^data:[^,]*,/, '');
  if (audio instanceof ArrayBuffer) return Buffer.from(audio).toString('base64');
  if (ArrayBuffer.isView(audio)) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64');
  return '';
};

export class AudioError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'AudioError';
    this.status = status;
    this.code = code;
  }
}

function abortable(promise, signal, reason) {
  if (!signal) return promise;
  let abort;
  const canceled = new Promise((_, reject) => {
    abort = () => reject(reason());
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, canceled]).finally(() => signal.removeEventListener('abort', abort));
}

function requestAborted() {
  return new AudioError('Audio request expired', { code: 'aborted' });
}

function makeRedactor(env) {
  return (value) => {
    let s = String(value ?? '');
    const key = env.ELEVENLABS_API_KEY;
    if (key && key.length >= 6) s = s.split(key).join('[redacted]');
    s = s.replace(/xi-api-key["']?\s*[:=]\s*["']?[^\s"',}]+/gi, 'xi-api-key=[redacted]');
    s = s.replace(/\b(sk_|xi_)[A-Za-z0-9_-]{12,}/g, '[redacted]');
    return s.length > 300 ? `${s.slice(0, 300)}...` : s;
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- WAV inspection

// Parses RIFF/WAVE (PCM, float, extensible). Throws AudioError(code:'bad_wav') on anything
// unusable. Duration comes from the data chunk; streamed files with a 0/0xFFFFFFFF size
// use the remaining bytes.
export function inspectWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const bad = (msg) => new AudioError(`voice sample rejected: ${msg}`, { code: 'bad_wav' });
  if (buf.length < 44) throw bad('file too small to be a WAV');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw bad('not a RIFF/WAVE file');
  let pos = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + 16 > buf.length) throw bad('truncated fmt chunk');
      let tag = buf.readUInt16LE(body);
      if (tag === 0xfffe && size >= 26) tag = buf.readUInt16LE(body + 24);
      fmt = {
        tag,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      dataLen = size;
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt) throw bad('missing fmt chunk');
  if (dataStart < 0) throw bad('missing data chunk');
  if (![1, 3].includes(fmt.tag)) throw bad(`unsupported WAV encoding ${fmt.tag}`);
  if (!fmt.channels || !fmt.sampleRate || !fmt.blockAlign || !fmt.bits) throw bad('invalid fmt chunk');
  const bytesPerSample = fmt.bits / 8;
  if (![1, 2, 3, 4].includes(bytesPerSample) || (fmt.tag === 3 && bytesPerSample !== 4)) throw bad(`unsupported bit depth ${fmt.bits}`);
  const durationSec = dataLen / (fmt.sampleRate * fmt.blockAlign);
  const total = Math.floor(dataLen / bytesPerSample);
  const step = Math.max(1, Math.floor(total / 400000));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < total; i += step) {
    const o = dataStart + i * bytesPerSample;
    let v;
    if (fmt.tag === 3) v = buf.readFloatLE(o);
    else if (bytesPerSample === 1) v = (buf[o] - 128) / 128;
    else if (bytesPerSample === 2) v = buf.readInt16LE(o) / 32768;
    else if (bytesPerSample === 3) v = buf.readIntLE(o, 3) / 8388608;
    else v = buf.readInt32LE(o) / 2147483648;
    sum += v * v;
    n++;
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, durationSec, rms, bytes: buf.length };
}

// ---------------------------------------------------------------- ElevenLabs HTTP client

// Thin REST client shared by the hub adapter and scripts/build-bank.mjs. The API key is
// read from env at call time, sent only in the xi-api-key header and scrubbed from errors.
export function createClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.elevenlabs.io',
  ttsModel = TTS_MODEL,
  ttsTimeoutMs = 6000,
} = {}) {
  const redact = makeRedactor(env);

  function apiKey() {
    const key = (env.ELEVENLABS_API_KEY || '').trim();
    if (!key) throw new AudioError('ELEVENLABS_API_KEY is not set', { code: 'no_key' });
    return key;
  }

  function httpError(op, status, text) {
    let code = `http_${status}`;
    let message = '';
    try {
      const j = JSON.parse(text);
      const d = j?.detail ?? j;
      if (typeof d === 'string') message = d;
      else if (Array.isArray(d)) message = d.map((x) => x?.msg).filter(Boolean).join('; ');
      else if (d && typeof d === 'object') {
        code = d.status || d.code || code;
        message = d.message || '';
      }
    } catch {
      message = String(text || '').slice(0, 160);
    }
    return new AudioError(redact(`${op} failed (HTTP ${status} ${code})${message ? `: ${message}` : ''}`), { status, code });
  }

  async function request(op, pathname, { method = 'GET', json, form, query, timeoutMs = 15000, expect = 'json', signal } = {}) {
    if (signal?.aborted) throw requestAborted();
    const key = apiKey();
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const headers = { 'xi-api-key': key };
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const request_signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const run = async () => {
      let res;
      try {
        res = await fetchImpl(`${apiBase}${pathname}${qs}`, { method, headers, body, signal: request_signal });
        if (!res.ok) throw httpError(op, res.status, await res.text().catch(() => ''));
        if (expect === 'buffer') return Buffer.from(await res.arrayBuffer());
        const text = await res.text();
        if (expect === 'text') return text;
        return text ? JSON.parse(text) : {};
      } catch (err) {
        if (err instanceof AudioError) throw err;
        throw new AudioError(redact(`${op} network error: ${err?.message || err}`), { code: 'network' });
      }
    };
    try {
      return await abortable(run(), request_signal, () => deadline.signal.aborted
        ? new AudioError(`${op} timed out after ${timeoutMs} ms`, { code: 'timeout' })
        : requestAborted());
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    redact,
    request,
    hasKey: () => Boolean((env.ELEVENLABS_API_KEY || '').trim()),
    async tts(voiceId, text, { timeoutMs = ttsTimeoutMs, format = TTS_FORMAT, speed, signal, model = ttsModel } = {}) {
      if (!voiceId) throw new AudioError('no voice id', { code: 'no_voice' });
      const buffer = await request('tts', `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: 'POST',
        query: { output_format: format },
        json: { text, model_id: model, ...(speed && speed !== 1 ? { voice_settings: { speed } } : {}) },
        timeoutMs,
        signal,
        expect: 'buffer',
      });
      if (!buffer.length) throw new AudioError('tts returned empty audio', { code: 'empty_audio' });
      return buffer;
    },
    async sfx(text, { durationSeconds, promptInfluence = 0.5, timeoutMs = 60000 } = {}) {
      const buffer = await request('sound-generation', '/v1/sound-generation', {
        method: 'POST',
        query: { output_format: 'mp3_44100_128' },
        json: { text, duration_seconds: durationSeconds, prompt_influence: promptInfluence },
        timeoutMs,
        expect: 'buffer',
      });
      if (!buffer.length) throw new AudioError('sound-generation returned empty audio', { code: 'empty_audio' });
      return buffer;
    },
    voices: () => request('voices', '/v1/voices', { query: { show_legacy: 'false' } }),
    voice: (id) => request('voice', `/v1/voices/${encodeURIComponent(id)}`),
    deleteVoice: (id) => request('delete voice', `/v1/voices/${encodeURIComponent(id)}`, { method: 'DELETE', expect: 'text' }),
    subscription: () => request('subscription', '/v1/user/subscription'),
  };
}

// ---------------------------------------------------------------- bank manifest

export async function loadBank(dir = DEFAULT_BANK_DIR) {
  const index = new Map();
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'bank.json'), 'utf8'));
  } catch {
    return { manifest: null, index, lookup: () => null };
  }
  for (const line of manifest.lines || []) index.set(`${line.role}|${normalizeText(line.text)}`, line.file);
  return {
    manifest,
    index,
    lookup: (role, text) => {
      const file = index.get(`${role}|${normalizeText(text)}`);
      return file ? `/assets/${file}` : null;
    },
  };
}

// ---------------------------------------------------------------- adapter

const WS_BASE = 'wss://api.elevenlabs.io';

export function createAudio({
  assets = new Map(),
  allowBundledFallback = false,
  whisperModel = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  WebSocketImpl,
  bankDir = DEFAULT_BANK_DIR,
  now = () => Date.now(),
  apiBase = 'https://api.elevenlabs.io',
  wsBase = WS_BASE,
  ttsTimeoutMs = 6000,
  verifyTimeoutMs = 8000,
  cloneTimeoutMs = 30000,
  ttsConcurrency = 4,
  minVoiceSeconds = 5,
  maxVoiceSeconds = 360,
  minVoiceRms = 0.002,
  vadSilenceSecs, // optional Scribe vad_silence_threshold_secs
  maxQueuedChars = 128000, // ~3 s of PCM16/16 kHz as base64 while reconnecting
  queueMaxAgeMs = 4000,
  handshakeTimeoutMs = 8000,
  maxScribeBufferedBytes = 128000,
  scribePingMs = 10000,
  scribePongTimeoutMs = 3000,
  reconnectBaseMs = 500,
  reconnectMaxMs = 5000,
  ledgerPath,
  onFailure,
  onTranscriptionStatus,
} = {}) {
  const client = createClient({ env, fetchImpl, apiBase, ttsTimeoutMs });
  const { redact } = client;
  const epochBox = { n: 0 };
  const failureLog = [];
  const created = new Map(); // voiceId -> seat (app-created clones only)
  const seatVoice = new Map(); // seat -> latest app clone id
  const voiceReq = new Map(); // seat -> request counter (supersede check)
  const voice_creations = new Set();
  const voice_deletions = new Map();
  let voice_lifetime = new AbortController();
  const inflight = new Map();
  const owned = new Map(); // seat -> Map(activeId -> Set(asset ids))
  const ephemeral = []; // speech() asset ids, FIFO-capped
  const dynamicIds = new Set();
  const asset_holds = new Set();
  let cache_generations = null;
  let replay_asset = null;
  const leftovers = new Map(); // ledger ids a sweep could not delete yet
  let bankPromise;
  let reqCounter = 0;
  let ledgerIO = Promise.resolve();

  const envVoice = (seat) => (env[`TELEPATHY_VOICE_${seat}`] || '').trim() || null;
  const assistantVoiceId = () => (env.TELEPATHY_ASSISTANT_VOICE || '').trim() || STOCK_VOICES.assistant.id;
  const protectedIds = () => new Set([envVoice('A'), envVoice('B'), assistantVoiceId(), ...Object.values(STOCK_VOICES).map((v) => v.id)].filter(Boolean));
  const bank = () => (bankPromise ??= loadBank(bankDir));

  function fail(op, err, extra = {}) {
    const entry = {
      at: now(),
      op,
      ...extra,
      status: err?.status ?? 0,
      code: err?.code ?? 'error',
      detail: redact(err?.message ?? err),
    };
    failureLog.push(entry);
    if (failureLog.length > 50) failureLog.shift();
    try {
      onFailure?.(entry);
    } catch {
      /* callback errors never break audio */
    }
    return entry;
  }

  // ---- dynamic assets

  function putAsset(id, buffer, mime = 'audio/mpeg') {
    assets.set(id, { mime, buffer });
    dynamicIds.add(id);
    return `/assets/${id}`;
  }
  const assetId = (voiceId, text, speed, model) => `tts-${sha(`${voiceId}|${model}|${speed ?? 1}|${text}`, 20)}.mp3`;

  async function synth(voiceId, text, { timeoutMs = ttsTimeoutMs, speed, signal, model = TTS_MODEL, held } = {}) {
    if (signal?.aborted) throw requestAborted();
    const id = assetId(voiceId, text, speed, model);
    const epoch = epochBox.n;
    held.add(id);
    if (assets.has(id)) return { id, url: `/assets/${id}` };
    let pending = inflight.get(id);
    if (!pending) {
      pending = { controller: new AbortController(), consumers: 0 };
      const request_signal = pending.controller.signal;
      pending.promise = client
        .tts(voiceId, text, { timeoutMs: Math.max(ttsTimeoutMs, timeoutMs), speed, signal: request_signal, model })
        .then(buf => {
          if (epoch !== epochBox.n || request_signal.aborted) throw requestAborted();
          return { id, url: putAsset(id, buf) };
        })
        .finally(() => { if (inflight.get(id) === pending) inflight.delete(id); });
      inflight.set(id, pending);
    }
    pending.consumers++;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      const caller_signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      return await abortable(pending.promise, caller_signal, () => deadline.signal.aborted
        ? new AudioError(`tts timed out after ${timeoutMs} ms`, { code: 'timeout' })
        : requestAborted());
    } finally {
      clearTimeout(timer);
      pending.consumers--;
      if (!pending.consumers && inflight.get(id) === pending) {
        inflight.delete(id);
        pending.controller.abort();
      }
    }
  }

  async function speakLine(voiceId, text, { whisper = false, whisperTimeoutMs = 5000, timeoutMs, speed, signal, held } = {}) {
    const epoch = epochBox.n;
    if (whisper && whisperModel && whisperModel !== TTS_MODEL) {
      try {
        return await synth(voiceId, '[whispers] ' + text, { model: whisperModel, timeoutMs: whisperTimeoutMs, signal, held });
      } catch (error) {
        if (signal?.aborted || epoch !== epochBox.n) throw error;
      }
    }
    return synth(voiceId, text, { timeoutMs, speed, signal, held });
  }

  function pruneAssets() {
    const keep = new Set(ephemeral);
    if (replay_asset) keep.add(replay_asset);
    for (const caches of owned.values()) for (const ids of caches.values()) for (const id of ids) keep.add(id);
    for (const held of asset_holds) for (const id of held) keep.add(id);
    for (const id of dynamicIds) {
      if (!keep.has(id)) {
        assets.delete(id);
        dynamicIds.delete(id);
      }
    }
  }

  function retainReplayAsset(url) {
    const id = typeof url === 'string' && url.startsWith('/assets/') ? url.slice('/assets/'.length) : null;
    const next = dynamicIds.has(id) ? id : null;
    if (next === replay_asset) return;
    replay_asset = next;
    pruneAssets();
  }

  function setCacheGenerations(activeId, candidateId) {
    cache_generations = new Set([activeId, candidateId].filter(Boolean));
    for (const caches of owned.values()) {
      for (const id of caches.keys()) if (!cache_generations.has(id)) caches.delete(id);
    }
    pruneAssets();
  }

  function retain(seat, activeId, ids) {
    const caches = owned.get(seat) ?? new Map();
    owned.set(seat, caches);
    caches.set(activeId, ids);
    if (cache_generations === null) {
      while (caches.size > 2) caches.delete(caches.keys().next().value);
    }
  }

  function resolveVoice(seat, voice) {
    const id = typeof voice === 'string' ? voice : voice && voice.status !== 'error' ? voice.id : null;
    return (id && String(id).trim()) || envVoice(seat);
  }

  // ---- speech

  async function buildCache(speakerSeat, preset, messages = {}, { voice, sim = false, activeId = 'cache', signal } = {}) {
    const epoch = epochBox.n;
    const out = CUES.map((cue) => ({ key: `cue:${cue}`, url: cueUrl(cue) }));
    if (!isSeat(speakerSeat) || signal?.aborted) return out;
    const entries = Object.entries(messages || {}).filter(([, t]) => typeof t === 'string' && t.trim());
    const ids = new Set();
    const held = new Set();
    const voiceId = resolveVoice(speakerSeat, voice);
    const bundled = sim || allowBundledFallback && !voiceId;
    if (!bundled && !voiceId) {
      fail('cache', new AudioError('no voice available for seat', { code: 'no_voice' }), { seat: speakerSeat });
      return out;
    }
    asset_holds.add(held);
    try {
      let results;
      if (bundled) {
        const b = await bank();
        results = entries.map(([sig, text]) => {
          const url = b.lookup(speakerSeat, text);
          if (!url) fail('bank', new AudioError(`no bundled line for ${speakerSeat}:${preset}:${sig}`, { code: 'bank_miss' }), { seat: speakerSeat });
          return url;
        });
      } else {
        results = await pool(entries, ttsConcurrency, async ([, text]) => {
          if (epoch !== epochBox.n || signal?.aborted) return null;
          try {
            const r = await speakLine(voiceId, text, { whisper: true, signal, held });
            ids.add(r.id);
            return r.url;
          } catch (err) {
            if (!signal?.aborted) fail('cache', err, { seat: speakerSeat });
            return null;
          }
        });
      }
      if (epoch !== epochBox.n || signal?.aborted || cache_generations && !cache_generations.has(activeId)) return out;
      entries.forEach(([sig], i) => {
        if (results[i]) out.push({ key: `${speakerSeat}:${preset}:${sig}`, url: results[i] });
      });
      if (!bundled) retain(speakerSeat, activeId, ids);
      return out;
    } finally {
      asset_holds.delete(held);
      pruneAssets();
    }
  }

  async function speech(speakerSeat, text, { voice, sim = false, role = 'seat', timeoutMs, signal } = {}) {
    if (typeof text !== 'string' || !text.trim() || signal?.aborted) return null;
    const epoch = epochBox.n;
    const assistant = ['assistant', 'system', 'draft', 'status', 'codebook', 'announcement'].includes(role);
    const can_speed = role === 'codebook';
    const real_voice = assistant ? assistantVoiceId() : resolveVoice(speakerSeat, voice);
    const bundled_voice = !assistant && !real_voice && allowBundledFallback && STOCK_VOICES[speakerSeat]?.id;
    const stock_clip = (can_speed || role === 'announcement') && real_voice === STOCK_VOICES.assistant.id;
    if (sim || bundled_voice || stock_clip) {
      const url = (await bank()).lookup(assistant ? 'assistant' : speakerSeat, text);
      if (epoch !== epochBox.n || signal?.aborted) return null;
      if (url) return { url, source: 'bank' };
      if (sim) {
        fail('speech', new AudioError('no bundled line for text', { code: 'bank_miss' }), { seat: speakerSeat });
        return null;
      }
    }
    const voiceId = real_voice || bundled_voice;
    if (!voiceId) {
      fail('speech', new AudioError('no voice available', { code: 'no_voice' }), { seat: speakerSeat });
      return null;
    }
    const held = new Set();
    asset_holds.add(held);
    try {
      const r = await speakLine(voiceId, text, {
        whisper: !assistant && role !== 'voice-preview', whisperTimeoutMs: 2100, timeoutMs, speed: can_speed ? READOUT_SPEED : undefined, signal, held,
      });
      if (epoch !== epochBox.n || signal?.aborted) return null;
      ephemeral.push(r.id);
      if (ephemeral.length > 60) ephemeral.shift();
      return { url: r.url, source: 'live' };
    } catch (err) {
      if (!signal?.aborted) fail('speech', err, { seat: speakerSeat });
      return null;
    } finally {
      asset_holds.delete(held);
      pruneAssets();
    }
  }

  async function announcement(text, { sim = false, signal } = {}) {
    const line = announcementText(text);
    const preset = OPERATOR_ANNOUNCEMENTS.some(item => item.text === line);
    if (!line || sim && !preset) return null;
    return speech(null, line, { sim, signal, role: preset ? 'announcement' : 'assistant' });
  }

  // ---- voice cloning

  function ledgerWrite() {
    if (!ledgerPath) return Promise.resolve();
    ledgerIO = ledgerIO.then(async () => {
      const rows = [...created, ...leftovers].map(([id, seat]) => ({ id, seat }));
      const next = ledgerPath + '.next';
      if (!rows.length) {
        await Promise.all([rm(ledgerPath, { force: true }), rm(next, { force: true })]);
        return;
      }
      await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
      await writeFile(next, JSON.stringify(rows), { mode: 0o600 });
      await rename(next, ledgerPath);
    }).catch(err => { fail('ledger', err); });
    return ledgerIO;
  }

  async function performDelete(id) {
    if (!created.has(id) || protectedIds().has(id)) return { removed: false, reason: 'not an app-created clone' };
    try {
      await client.deleteVoice(id);
    } catch (err) {
      if (!(err.status === 404 || /not_found/.test(err.code))) {
        fail('delete voice', err);
        return { removed: false, reason: redact(err.message) };
      }
    }
    const seat = created.get(id);
    created.delete(id);
    if (seatVoice.get(seat) === id) seatVoice.delete(seat);
    await ledgerWrite();
    return { removed: true };
  }

  function deleteClone(id) {
    if (voice_deletions.has(id)) return voice_deletions.get(id);
    const deleting = performDelete(id).finally(() => voice_deletions.delete(id));
    voice_deletions.set(id, deleting);
    return deleting;
  }

  function fallbackResult(seat, reason) {
    const id = envVoice(seat);
    if (!id) return allowBundledFallback
      ? { id: null, status: 'fallback', detail: 'Using the bundled ElevenLabs demo voice. ' + reason }
      : { id: null, status: 'error', detail: reason };
    return { id, status: 'fallback', detail: `fallback voice ${id} (TELEPATHY_VOICE_${seat}, not a clone of this speaker): ${reason}` };
  }

  function obsoleteVoice() {
    return { id: null, status: 'error', detail: 'voice request superseded by a newer request or reset' };
  }

  function makeVoice(seat, wav, requestId, { signal } = {}) {
    const creating = createVoice(seat, wav, requestId, signal).finally(() => voice_creations.delete(creating));
    voice_creations.add(creating);
    return creating;
  }

  async function createVoice(seat, wav, requestId, signal) {
    if (!isSeat(seat)) return { id: null, status: 'error', detail: 'unknown seat' };
    const lifetime = signal ? AbortSignal.any([signal, voice_lifetime.signal]) : voice_lifetime.signal;
    if (lifetime.aborted) return obsoleteVoice();
    const epoch = epochBox.n;
    const reqNo = ++reqCounter;
    voiceReq.set(seat, reqNo);
    const stale = () => lifetime.aborted || epoch !== epochBox.n || voiceReq.get(seat) !== reqNo;

    let info;
    try {
      const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(toBase64(wav), 'base64');
      info = inspectWav(buf);
      if (info.durationSec < minVoiceSeconds) throw new AudioError(`voice sample rejected: ${info.durationSec.toFixed(1)} s is shorter than ${minVoiceSeconds} s`, { code: 'bad_wav' });
      if (info.durationSec > maxVoiceSeconds) throw new AudioError(`voice sample rejected: ${info.durationSec.toFixed(0)} s is longer than ${maxVoiceSeconds} s`, { code: 'bad_wav' });
      if (info.rms < minVoiceRms) throw new AudioError('voice sample rejected: recording is silent', { code: 'bad_wav' });
      wav = buf;
    } catch (err) {
      fail('voice', err, { seat, requestId });
      return { id: null, status: 'error', detail: redact(err.message) };
    }

    let cloneId = null;
    try {
      const form = new FormData();
      form.append('name', `TELEPATHY-APP-${seat}-${String(requestId ?? reqNo).replace(/[^\w-]/g, '').slice(0, 16)}-${now()}`);
      form.append('description', 'Telepathy demo clone. App-created from a consented seat recording; deleted on reset.');
      form.append('files', new Blob([wav], { type: 'audio/wav' }), 'sample.wav');
      const added = await client.request('voice clone', '/v1/voices/add', { method: 'POST', form, timeoutMs: cloneTimeoutMs });
      cloneId = added?.voice_id || null;
      if (!cloneId) throw new AudioError('voice clone returned no voice_id', { code: 'no_voice' });
      created.set(cloneId, seat);
      await ledgerWrite();
      if (stale()) {
        await deleteClone(cloneId);
        return obsoleteVoice();
      }
      if (added.requires_verification || added.library_voice_match) {
        throw new AudioError('clone requires voice verification (matched a protected voice)', { status: 401, code: 'voice_requires_verification' });
      }
      // verification: a real test TTS with the new clone; this is what catches 401 detected_captcha_voice
      await client.tts(cloneId, 'Voice check.', { timeoutMs: verifyTimeoutMs, signal: lifetime });
      if (stale()) {
        await deleteClone(cloneId);
        return obsoleteVoice();
      }
      const previous = seatVoice.get(seat);
      seatVoice.set(seat, cloneId);
      if (previous && previous !== cloneId) await deleteClone(previous);
      if (stale()) {
        await deleteClone(cloneId);
        return obsoleteVoice();
      }
      return { id: cloneId, status: 'ready', detail: `clone verified by test speech (${info.durationSec.toFixed(1)} s sample)` };
    } catch (err) {
      if (!stale()) fail('voice', err, { seat, requestId });
      if (cloneId) await deleteClone(cloneId); // an unusable clone must not linger
      if (stale()) return obsoleteVoice();
      return fallbackResult(seat, redact(err.message));
    }
  }

  async function removeVoice(voice) {
    const id = typeof voice === 'string' ? voice : voice?.id;
    if (!id) return { removed: false, reason: 'no id' };
    return deleteClone(id);
  }

  // Deletes ledger leftovers from a crashed run, only if the voice is named TELEPATHY-APP-*.
  async function sweepLedger() {
    if (!ledgerPath) return { removed: [] };
    const candidates = new Map();
    for (const file of [ledgerPath, ledgerPath + '.next']) {
      try {
        const rows = JSON.parse(await readFile(file, 'utf8'));
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          if (typeof row?.id === 'string' && row.id && isSeat(row.seat)) candidates.set(row.id, row.seat);
        }
      } catch {}
    }
    if (!candidates.size) return { removed: [] };
    const removed = [];
    for (const [id, seat] of candidates) {
      leftovers.delete(id);
      if (protectedIds().has(id) || created.has(id)) continue;
      try {
        const v = await client.voice(id);
        if (!String(v?.name || '').startsWith('TELEPATHY-APP-') || v.category !== 'cloned') continue;
        await client.deleteVoice(id);
        removed.push(id);
      } catch (err) {
        if (err.status === 404 || /not_found/.test(err.code)) removed.push(id);
        else {
          leftovers.set(id, seat);
          fail('sweep', err, { seat });
        }
      }
    }
    await ledgerWrite();
    return { removed };
  }

  // ---- realtime transcription (Scribe v2 Realtime, one socket per seat)

  const stt = new Map();
  const sttState = (seat) => {
    let s = stt.get(seat);
    if (!s) {
      s = {
        enabled: undefined, gen: 0, ws: null, open: false, connecting: false, handshake_timer: null,
        queue: [], queued: 0, attempts: 0, nextAt: 0, fatal: null, cb: null, lastPartial: '',
        status: 'off', status_code: null, reportedNoKey: false, last_pong_at: 0, ping_at: null,
      };
      stt.set(seat, s);
    }
    return s;
  };

  const normalizeCb = (cb) => {
    if (typeof cb === 'function') return { committed: cb, partial: null };
    if (cb && typeof cb === 'object') return { committed: cb.committed ?? cb.onCommitted ?? null, partial: cb.partial ?? cb.onPartial ?? null };
    return null;
  };

  function transcriptionStatus(seat, s, status, code = null) {
    if (s.status === status && s.status_code === code) return;
    s.status = status;
    s.status_code = code;
    try { onTranscriptionStatus?.({ seat, status, ...(code ? { code } : {}) }); } catch {}
  }

  function clearSttConnection(s) {
    clearTimeout(s.handshake_timer);
    s.handshake_timer = null;
    s.ws = null;
    s.open = false;
    s.connecting = false;
    s.queue = [];
    s.queued = 0;
    s.lastPartial = '';
    s.last_pong_at = 0;
    s.ping_at = null;
  }

  function closeSttSocket(ws) {
    try {
      if (typeof ws?.terminate === 'function') ws.terminate();
      else ws?.close();
    } catch {}
  }

  function teardownStt(seat, enabled) {
    const s = sttState(seat);
    s.gen++;
    const ws = s.ws;
    clearSttConnection(s);
    s.attempts = 0;
    s.nextAt = 0;
    s.fatal = null;
    s.enabled = enabled;
    if (!enabled) s.cb = null;
    closeSttSocket(ws);
    transcriptionStatus(seat, s, enabled ? 'waiting' : 'off');
  }

  const FATAL_STT = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request']);

  function sendChunk(ws, b64) {
    const chunk = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: 16000 });
    if ((ws.bufferedAmount ?? 0) + Buffer.byteLength(chunk) > maxScribeBufferedBytes) {
      throw new AudioError('Transcription upload buffer is full', { code: 'buffer_full' });
    }
    ws.send(chunk);
  }

  async function resolveWs() {
    if (WebSocketImpl) return WebSocketImpl;
    try {
      const mod = await import('ws');
      return mod.default ?? mod.WebSocket;
    } catch {
      if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket; // Node's undici client also accepts {headers}
      throw new AudioError('no WebSocket implementation (install ws)', { code: 'ws_unavailable' });
    }
  }

  const on = (ws, evt, fn) => (typeof ws.addEventListener === 'function' ? ws.addEventListener(evt, fn) : ws.on(evt, fn));

  function sttDisconnected(seat, s, code, { fatal = false, close = true } = {}) {
    const ws = s.ws;
    clearSttConnection(s);
    if (fatal) s.fatal = code;
    s.nextAt = now() + Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** s.attempts++);
    if (close) closeSttSocket(ws);
    transcriptionStatus(seat, s, fatal ? 'unavailable' : 'recovering', code);
  }

  function sendSttChunk(seat, s, b64) {
    try {
      sendChunk(s.ws, b64);
      return true;
    } catch (err) {
      const error = err instanceof AudioError ? err : new AudioError(redact(err.message), { code: 'network' });
      fail('stt', error, { seat });
      sttDisconnected(seat, s, error.code);
      return false;
    }
  }

  function checkSttHeartbeat(seat, s) {
    if (!scribePingMs || typeof s.ws.ping !== 'function') return true;
    const at = now();
    if (s.ping_at !== null) {
      if (at - s.ping_at < scribePongTimeoutMs) return true;
      const error = new AudioError('Scribe connection stopped responding', { code: 'heartbeat_timeout' });
      fail('stt', error, { seat });
      sttDisconnected(seat, s, error.code);
      return false;
    }
    if (at - s.last_pong_at >= scribePingMs) {
      try {
        s.ping_at = at;
        s.ws.ping();
      } catch (err) {
        fail('stt', new AudioError(redact(err.message), { code: 'network' }), { seat });
        sttDisconnected(seat, s, 'network');
        return false;
      }
    }
    return true;
  }

  async function connectStt(seat) {
    const s = sttState(seat);
    if (s.connecting || s.ws || s.fatal || s.enabled === false) return;
    s.connecting = true;
    const gen = s.gen;
    transcriptionStatus(seat, s, 'connecting');
    let WS;
    try {
      if (!client.hasKey()) throw new AudioError('ELEVENLABS_API_KEY is not set', { code: 'no_key' });
      WS = await resolveWs();
    } catch (err) {
      if (gen === s.gen) {
        fail('stt', err, { seat });
        sttDisconnected(seat, s, err.code, { fatal: true });
      }
      return;
    }
    if (gen !== s.gen) return;
    const params = new URLSearchParams({ model_id: STT_MODEL, audio_format: 'pcm_16000', commit_strategy: 'vad' });
    if (vadSilenceSecs) params.set('vad_silence_threshold_secs', String(vadSilenceSecs));
    let ws;
    try {
      ws = new WS(`${wsBase}/v1/speech-to-text/realtime?${params}`, {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY.trim() }, handshakeTimeout: handshakeTimeoutMs,
      });
    } catch (err) {
      fail('stt', new AudioError(redact(`stt connect failed: ${err.message}`), { code: 'network' }), { seat });
      sttDisconnected(seat, s, 'network');
      return;
    }
    s.ws = ws;
    const live = () => gen === s.gen && s.ws === ws;
    s.handshake_timer = setTimeout(() => {
      if (!live()) return;
      fail('stt', new AudioError('Scribe did not start the session', { code: 'handshake_timeout' }), { seat });
      sttDisconnected(seat, s, 'handshake_timeout');
    }, handshakeTimeoutMs);
    s.handshake_timer.unref?.();

    on(ws, 'message', (ev) => {
      if (!live()) return;
      const raw = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev;
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
      } catch {
        return;
      }
      const type = msg?.message_type;
      if (type === 'session_started') {
        if (s.open) return;
        clearTimeout(s.handshake_timer);
        s.handshake_timer = null;
        s.open = true;
        s.connecting = false;
        s.last_pong_at = now();
        const cutoff = now() - queueMaxAgeMs;
        const pending = s.queue.filter(q => q.at >= cutoff);
        s.queue = [];
        s.queued = 0;
        for (const q of pending) if (!sendSttChunk(seat, s, q.b64)) return;
        s.attempts = 0;
        transcriptionStatus(seat, s, 'live');
      } else if (type === 'partial_transcript' && s.open) {
        const text = String(msg.text ?? '').trim();
        if (!text || text === s.lastPartial) return; // partials double as keepalives
        s.lastPartial = text;
        s.cb?.partial?.(text, { partial: true, level: s.level });
      } else if (type === 'committed_transcript' && s.open) {
        const text = String(msg.text ?? '').trim();
        s.lastPartial = '';
        if (text) s.cb?.committed?.(text, { partial: false, level: s.level });
      } else if (type && type !== 'committed_transcript_with_timestamps' && (FATAL_STT.has(type) || /error|exceeded|throttled|limited|overflow|exhausted|insufficient/.test(type))) {
        fail('stt', new AudioError(`scribe ${type}: ${msg.error ?? ''}`, { code: type }), { seat });
        if (FATAL_STT.has(type)) sttDisconnected(seat, s, type, { fatal: true });
      }
    });
    on(ws, 'error', (ev) => {
      if (!live()) return;
      const err = new AudioError(redact(`stt socket error: ${ev?.message || ev?.error?.message || 'connection error'}`), { code: 'network' });
      if (/\b(401|403)\b/.test(err.message)) err.code = 'auth_error';
      fail('stt', err, { seat });
      sttDisconnected(seat, s, err.code, { fatal: err.code === 'auth_error' });
    });
    on(ws, 'close', () => {
      if (live()) sttDisconnected(seat, s, 'socket_closed', { close: false });
    });
    const pong = () => {
      if (!live() || !s.open || s.ping_at === null) return;
      s.ping_at = null;
      s.last_pong_at = now();
    };
    if (typeof ws.on === 'function') ws.on('pong', pong);
    else on(ws, 'pong', pong);
  }

  async function listen(seat, enabled, onTranscript) {
    if (!isSeat(seat)) return { listening: false };
    const s = sttState(seat);
    if (!enabled) {
      teardownStt(seat, false);
      return { listening: false };
    }
    if (!client.hasKey() || s.fatal) {
      transcriptionStatus(seat, s, 'unavailable', s.fatal ?? 'no_key');
      return { listening: false };
    }
    if (s.enabled !== true) teardownStt(seat, true);
    const cb = normalizeCb(onTranscript);
    if (cb) s.cb = cb;
    return { listening: true }; // the socket opens on the first real mic frame
  }

  async function mic(seat, audio, level, onTranscript, opts = {}) {
    if (!isSeat(seat) || opts?.sim) return { sent: false };
    const s = sttState(seat);
    if (s.enabled === false || s.fatal) return { sent: false };
    if (s.enabled === undefined) s.enabled = true;
    if (typeof level === 'number') s.level = level;
    const cb = normalizeCb(onTranscript);
    if (cb) s.cb = cb;
    const b64 = toBase64(audio);
    if (!b64) return { sent: false };
    if (!client.hasKey()) {
      if (!s.reportedNoKey) {
        s.reportedNoKey = true;
        fail('stt', new AudioError('ELEVENLABS_API_KEY is not set', { code: 'no_key' }), { seat });
      }
      return { sent: false };
    }
    if (s.open && s.ws && checkSttHeartbeat(seat, s)) return { sent: sendSttChunk(seat, s, b64) };
    // reconnecting or not yet connected: bounded queue, drop oldest
    s.queue.push({ at: now(), b64 });
    s.queued += b64.length;
    while (s.queued > maxQueuedChars && s.queue.length) s.queued -= s.queue.shift().b64.length;
    if (!s.ws && !s.connecting && now() >= s.nextAt) await connectStt(seat);
    return { sent: false, queued: true };
  }

  // ---- lifecycle

  async function reset() {
    epochBox.n++;
    const pending_creations = [...voice_creations];
    voice_lifetime.abort();
    voice_lifetime = new AbortController();
    for (const seat of ['A', 'B']) teardownStt(seat, false);
    for (const id of dynamicIds) assets.delete(id);
    dynamicIds.clear();
    owned.clear();
    ephemeral.length = 0;
    replay_asset = null;
    asset_holds.clear();
    for (const pending of inflight.values()) pending.controller.abort();
    inflight.clear();
    voiceReq.clear();
    const removed = [];
    const failed = [];
    await Promise.all([
      ...[...created.keys()].map(async (id) => {
        const r = await deleteClone(id);
        (r.removed ? removed : failed).push(id);
      }),
      ...pending_creations,
    ]);
    return { removed, failed };
  }

  return {
    makeVoice,
    buildCache,
    setCacheGenerations,
    retainReplayAsset,
    speech,
    announcement,
    removeVoice,
    mic,
    listen,
    reset,
    shutdown: reset,
    sweepLedger,
    failures: () => failureLog.slice(),
    createdVoices: () => [...created.keys()],
    bank,
  };
}
