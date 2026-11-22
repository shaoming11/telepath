#!/usr/bin/env node
// Builds the bundled ElevenLabs audio bank in public/assets:
//   cue-*.mp3      eight sound-effect cues (ElevenLabs /v1/sound-generation, one request each)
//   line-*.mp3     stock-voice speech for the sim seats + assistant lines (ElevenLabs TTS)
//   keepalive.wav  silence-only media anchor (local, zero-valued PCM; not a cue or voice)
//   bank.json      manifest read by hub/audio.mjs
//
// Idempotent and spend-aware: existing files are never regenerated, requests are one per
// missing file, no re-rolls. Run:
//   node --env-file-if-exists=.env.local scripts/build-bank.mjs --dry-run
//   node --env-file-if-exists=.env.local scripts/build-bank.mjs
// The API key comes from process.env.ELEVENLABS_API_KEY only and is never printed.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CUES,
  DEFAULT_BANK_DIR,
  STOCK_VOICES,
  TTS_FORMAT,
  TTS_MODEL,
  bankFileName,
  bankLines,
  createClient,
  cueFile,
  normalizeText,
} from '../hub/audio.mjs';

export const CUE_SPECS = Object.freeze({
  soft: { seconds: 1.0, prompt: 'Soft gentle two-note glass chime notification, warm and quiet, clean tone, no background noise' },
  urgent: { seconds: 1.2, prompt: 'Urgent sharp triple bell alert chime, rising pitch, bright and insistent, short, no background noise' },
  draft: { seconds: 0.9, prompt: 'Curious questioning marimba blip, two soft rising notes like a polite question, short, no background noise' },
  sent: { seconds: 0.5, prompt: 'Tiny crisp dry tick click confirmation, very short and subtle, no reverb' },
  receipt: { seconds: 0.8, prompt: 'Two clear audible bright soft pops, upbeat acknowledgement, prominent mid-range bubble notes, full volume, short' },
  error: { seconds: 0.7, prompt: 'Short low dull descending error buzz, harsh and flat, negative feedback tone, no background noise' },
  system: { seconds: 1.0, prompt: 'Neutral clean single mid-pitch bell tone system notice, simple and calm, no background noise' },
  back: { seconds: 0.8, prompt: 'A single short smooth upward swipe whoosh, soft and clean, rising in pitch, no glitch, no buzz, no clicks' },
});

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

export function silenceWav({ seconds = 1, sampleRate = 8000 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2); // zero-valued PCM16 mono
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function writeAtomic(file, buf) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
}

// Plan = what exists vs what must be requested. Pure, so the dry run and tests share it.
export async function planBank(dir = DEFAULT_BANK_DIR) {
  const cues = [];
  for (const cue of CUES) cues.push({ cue, file: cueFile(cue), ...CUE_SPECS[cue], missing: !(await exists(path.join(dir, cueFile(cue)))) });
  const seen = new Map();
  const lines = [];
  for (const line of bankLines()) {
    const voice = STOCK_VOICES[line.role];
    const dedupe = `${line.role}|${normalizeText(line.text)}`;
    if (seen.has(dedupe)) continue; // same words, same voice: one file
    const file = bankFileName(line.role, voice.id, line.text, line.speed);
    const entry = { ...line, voiceId: voice.id, voiceName: voice.name, file, missing: !(await exists(path.join(dir, file))) };
    seen.set(dedupe, entry);
    lines.push(entry);
  }
  return { cues, lines, keepaliveMissing: !(await exists(path.join(dir, 'keepalive.wav'))) };
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 429 || err.status >= 500 || err.code === 'timeout' || err.code === 'network') return fn(); // transport-level only
    throw err;
  }
}

export async function buildBank({ dir = DEFAULT_BANK_DIR, dryRun = false, only, regen = [], prune = false, env = process.env, fetchImpl, log = console.log } = {}) {
  await mkdir(dir, { recursive: true });
  const plan = await planBank(dir);
  const wantCues = only !== 'speech';
  const wantSpeech = only !== 'cues';
  // regen: explicit re-roll of named cues only (e.g. a measured-silent file); everything else is never regenerated
  const needCues = wantCues ? plan.cues.filter((c) => c.missing || regen.includes(c.cue)) : [];
  const needLines = wantSpeech ? plan.lines.filter((l) => l.missing) : [];
  const chars = needLines.reduce((n, l) => n + l.text.length, 0);
  const sfxSeconds = needCues.reduce((n, c) => n + c.seconds, 0);
  log(`plan: ${needCues.length} SFX requests (${sfxSeconds.toFixed(1)} s), ${needLines.length} TTS requests (${chars} chars, ${TTS_MODEL}), keepalive.wav ${plan.keepaliveMissing ? 'to write (local)' : 'present'}`);
  const summary = { dryRun, sfxRequests: needCues.length, ttsRequests: needLines.length, ttsChars: chars, sfxSeconds, creditsBefore: null, creditsAfter: null };
  if (dryRun) return summary;

  if (plan.keepaliveMissing) await writeAtomic(path.join(dir, 'keepalive.wav'), silenceWav());

  const client = createClient({ env, fetchImpl, ttsTimeoutMs: 30000 });
  if (needCues.length || needLines.length) {
    summary.creditsBefore = (await client.subscription()).character_count;
    if (needLines.length) {
      const have = new Set((await client.voices()).voices.map((v) => v.voice_id));
      for (const [role, v] of Object.entries(STOCK_VOICES)) if (!have.has(v.id)) throw new Error(`stock voice ${role} (${v.name}) is not available on this account`);
    }
  }

  for (const c of needCues) {
    const buf = await withRetry(() => client.sfx(c.prompt, { durationSeconds: c.seconds }));
    await writeAtomic(path.join(dir, c.file), buf);
    log(`cue ${c.cue}: ${buf.length} bytes`);
  }
  for (const l of needLines) {
    const buf = await withRetry(() => client.tts(l.voiceId, l.text, { timeoutMs: 30000, format: TTS_FORMAT, speed: l.speed }));
    await writeAtomic(path.join(dir, l.file), buf);
    log(`line ${l.role}/${l.kind}: ${buf.length} bytes`);
  }

  if (prune) {
    const keep = new Set([...plan.lines.map((l) => l.file), ...plan.cues.map((c) => c.file), 'keepalive.wav', 'bank.json']);
    for (const f of await readdir(dir)) if (/^(line-|cue-).*\.mp3$/.test(f) && !keep.has(f)) await unlink(path.join(dir, f));
  }

  // manifest from what is actually on disk
  const manifest = {
    version: 1,
    generated: 'ElevenLabs only: cues via /v1/sound-generation, speech via TTS with premade stock voices',
    model: TTS_MODEL,
    voices: Object.fromEntries(Object.entries(STOCK_VOICES).map(([k, v]) => [k, { id: v.id, name: v.name, label: 'stock voice (simulated seat), not a clone' }])),
    keepalive: 'keepalive.wav',
    cues: {},
    lines: [],
  };
  for (const c of plan.cues) {
    const p = path.join(dir, c.file);
    if (await exists(p)) {
      const b = await readFile(p);
      manifest.cues[c.cue] = { file: c.file, bytes: b.length, sha256: sha256(b), prompt: c.prompt, seconds: c.seconds };
    }
  }
  for (const l of plan.lines) {
    const p = path.join(dir, l.file);
    if (!(await exists(p))) continue;
    const b = await readFile(p);
    const { missing, voiceName, ...rest } = l;
    manifest.lines.push({ ...rest, bytes: b.length, sha256: sha256(b) });
  }
  await writeAtomic(path.join(dir, 'bank.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  if (summary.creditsBefore !== null) {
    summary.creditsAfter = (await client.subscription()).character_count;
    log(`usage: character_count ${summary.creditsBefore} -> ${summary.creditsAfter} (delta ${summary.creditsAfter - summary.creditsBefore} credits)`);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const only = args.includes('--cues-only') ? 'cues' : args.includes('--speech-only') ? 'speech' : undefined;
  const rg = args.find((a) => a.startsWith('--regen='));
  buildBank({ dryRun: args.includes('--dry-run'), only, prune: args.includes('--prune'), regen: rg ? rg.slice(8).split(',').filter(Boolean) : [] }).catch((err) => {
    const redact = createClient().redact;
    console.error(`build-bank failed: ${redact(err.message)}`);
    process.exit(1);
  });
}
