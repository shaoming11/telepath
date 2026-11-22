export const CUE_NAMES = Object.freeze(['soft', 'urgent', 'draft', 'sent', 'receipt', 'error', 'system', 'back']);
export const CUE_LEVELS = Object.freeze({
  soft: 1.28, urgent: 0.60, draft: 0.91, sent: 2.25,
  receipt: 0.43, error: 0.90, system: 1.0, back: 0.46,
});

const START_MARGIN_S = 0.03;
const QUEUE_TAIL_S = 0.08;
const LOAD_ATTEMPTS = 3;
const MANIFEST_CONCURRENCY = 4;
const RESUME_WAIT_MS = 350;
const ACK_EPSILON_S = 0.002;
const IMMEDIATE_CUES = new Set(['sent', 'receipt', 'error']);
const PREVIEW_START_LIMIT_MS = 6000;
const ANNOUNCEMENT_START_LIMIT_MS = 8000;
const HEARD_RETRY_MS = 5000;
const HEARD_RETRY_TICK_MS = 250;

// Private previews use the AI decision timestamp to set their start window.
export function is_preview(frame) {
  return Boolean(frame?.messageId) && frame.decisionAt != null;
}

// Tracks the seat's private draft. It reports retired draft ids so queued preview audio can be
// dropped, and expires the draft locally if the hub's clearing state frame never arrives.
export function createDraftTracker({
  set_timer = setTimeout, clear_timer = clearTimeout, grace_ms = 1500, fallback_ms = PREVIEW_START_LIMIT_MS,
  on_retire,
} = {}) {
  let id = null;
  let expiry_key = '';
  let timer = null;
  let expired = null;

  function disarm() {
    if (timer) clear_timer(timer);
    timer = null;
  }

  function retire(retired_id, reason) {
    disarm();
    id = null;
    expiry_key = '';
    if (retired_id != null) on_retire?.(retired_id, reason);
  }

  return {
    observe(pending) {
      const next = pending?.id ?? null;
      if (id !== null && id !== next) retire(id, next === null ? 'cleared' : 'replaced');
      if (next === null) {
        expired = null;
        return;
      }
      if (expired === next) return;
      const window_ms = Number(pending.expiresAt) - Number(pending.heardAt ?? pending.decisionAt);
      const key = next + ':' + pending.expiresAt + ':' + (pending.heardAt ?? '');
      if (key === expiry_key) return;
      id = next;
      expiry_key = key;
      disarm();
      const wait = (Number.isFinite(window_ms) && window_ms > 0 ? window_ms : fallback_ms) + grace_ms;
      timer = set_timer(() => {
        timer = null;
        expired = next;
        retire(next, 'expired');
      }, wait);
    },
    visible(pending) { return Boolean(pending) && pending.id !== expired; },
    can_approve(pending) {
      return Boolean(pending) && pending.id !== expired && Number.isFinite(Number(pending.heardAt)) && pending.heardAt != null;
    },
    reset() {
      disarm();
      id = null;
      expiry_key = '';
      expired = null;
    },
  };
}

async function map_limit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createAudioEngine({ volumes, timing, on_status, on_heard }) {
  const cues = new Map();
  const cache_banks = new Map();
  const sources = new Map();
  const cue_channels = new Map();
  const acks = new Set();
  const retired = new Set();
  const heard_backlog = new Map();
  let backlog_timer = null;
  let session_generation = 0;
  let announcement_generation = 0;
  const shared_buffers = new Map();
  let context = null;
  let cue_gain = null;
  let voice_gain = null;
  let levels = { ...volumes };
  let app_timing = timing;
  let playhead = 0;
  let manifest_sequence = 0;

  const report = (key, text) => on_status?.({ key, text });

  function ensure_context() {
    if (context) return context;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) return null;
    context = new Context({ latencyHint: 'interactive' });
    cue_gain = context.createGain();
    voice_gain = context.createGain();
    cue_gain.connect(context.destination);
    voice_gain.connect(context.destination);
    for (const [name, level] of Object.entries(CUE_LEVELS)) {
      const channel = context.createGain();
      channel.gain.value = level;
      channel.connect(cue_gain);
      cue_channels.set(name, channel);
    }
    cue_gain.gain.value = levels.cue;
    voice_gain.gain.value = levels.voice;
    context.addEventListener?.('statechange', () => {
      report('context', context.state === 'running' ? '' : 'Audio is paused. Tap anywhere to resume.');
      if (context.state === 'running') for (const ack of [...acks]) ack.check();
    });
    return context;
  }

  function resume_briefly() {
    if (!context) return Promise.resolve(false);
    if (context.state === 'running') return Promise.resolve(true);
    return Promise.race([
      context.resume().then(() => context.state === 'running').catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(context.state === 'running'), RESUME_WAIT_MS)),
    ]);
  }

  function unlock() {
    const active = ensure_context();
    if (!active) {
      report('context', 'This browser cannot play Web Audio.');
      return Promise.resolve(false);
    }
    const silent = active.createBufferSource();
    silent.buffer = active.createBuffer(1, 1, active.sampleRate);
    silent.connect(active.destination);
    silent.start(0);
    return resume_briefly();
  }

  function decode(array_buffer) {
    return new Promise((resolve, reject) => {
      const decoding = context.decodeAudioData(array_buffer, resolve, reject);
      decoding?.catch?.(reject);
    });
  }

  async function fetch_decode(url) {
    if (!ensure_context()) throw new Error('Web Audio unavailable');
    let last_error;
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, app_timing.audioRetryMs * attempt));
      try {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error('Audio asset returned ' + response.status);
        return await decode(await response.arrayBuffer());
      } catch (error) {
        last_error = error;
      }
    }
    throw last_error;
  }

  function load_shared(url) {
    const resolved = new URL(url, location.href).href;
    if (!shared_buffers.has(resolved)) {
      const pending = fetch_decode(resolved).catch(error => {
        shared_buffers.delete(resolved);
        throw error;
      });
      shared_buffers.set(resolved, pending);
    }
    return shared_buffers.get(resolved);
  }

  async function preload_cues() {
    const results = await Promise.allSettled(CUE_NAMES.map(async name => {
      cues.set(name, await load_shared('/assets/cue-' + name + '.mp3'));
    }));
    const missing = CUE_NAMES.filter((_, index) => results[index].status === 'rejected');
    report('cues', missing.length ? 'Missing sounds: ' + missing.join(', ') + '.' : '');
    return missing;
  }

  async function load_manifest(frame) {
    const generation = session_generation;
    const sequence = ++manifest_sequence;
    const items = Array.isArray(frame.items) ? frame.items : [];
    try {
      const decoded = await map_limit(items, MANIFEST_CONCURRENCY, async item => [
        item.key, await load_shared(item.url),
      ]);
      if (generation !== session_generation) return false;
      cache_banks.set(frame.activeId, new Map(decoded));
      if (sequence === manifest_sequence) report('cache', '');
      return true;
    } catch {
      if (generation === session_generation && sequence === manifest_sequence) report('cache', 'Fixed messages did not cache.');
      return false;
    }
  }

  function start_source(buffer, destination, at, rate = 1, meta = {}) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(destination);
    sources.set(source, { at, end: at + buffer.duration / rate, ...meta });
    source.addEventListener('ended', () => sources.delete(source), { once: true });
    source.start(at);
    return source;
  }

  function recompute_playhead() {
    let end = 0;
    for (const meta of sources.values()) if (meta.serial) end = Math.max(end, meta.end);
    playhead = end ? end + QUEUE_TAIL_S : 0;
  }

  function deliver_heard(message_id) {
    if (!on_heard) return;
    if (on_heard(message_id) !== false) return;
    heard_backlog.set(message_id, performance.now());
    backlog_timer ??= setInterval(flush_heard, HEARD_RETRY_TICK_MS);
  }

  // The hub starts its receipt clock from this ack, so a dropped send is retried, not forgotten.
  function flush_heard() {
    for (const [message_id, since] of [...heard_backlog]) {
      if (performance.now() - since > HEARD_RETRY_MS || retired.has(message_id) || on_heard?.(message_id) !== false) {
        heard_backlog.delete(message_id);
      }
    }
    if (!heard_backlog.size && backlog_timer) {
      clearInterval(backlog_timer);
      backlog_timer = null;
    }
  }

  // The ack follows the audio clock, not the wall clock: a suspended context holds currentTime still,
  // so a timer that fires while audio is paused re-arms on resume instead of giving up.
  function arm_heard(message_id, at, source) {
    const generation = session_generation;
    const ack = { message_id, source, timer: null };
    const check = () => {
      clearTimeout(ack.timer);
      ack.timer = null;
      if (generation !== session_generation || !acks.has(ack)) return;
      const remaining = at - context.currentTime;
      if (remaining > ACK_EPSILON_S) {
        if (context.state === 'running') ack.timer = setTimeout(check, remaining * 1000);
        else report('playback', 'Audio stopped before the message played.');
        return;
      }
      acks.delete(ack);
      deliver_heard(message_id);
    };
    ack.check = check;
    acks.add(ack);
    ack.timer = setTimeout(check, Math.max(0, (at - context.currentTime) * 1000));
  }

  function drop_ack(source) {
    for (const ack of acks) {
      if (ack.source !== source) continue;
      clearTimeout(ack.timer);
      acks.delete(ack);
    }
  }

  // Stops audio that has not begun yet. Audio already playing is left to finish.
  function cancel_unstarted(match) {
    if (!context) return 0;
    let stopped = 0;
    for (const [source, meta] of [...sources]) {
      if (meta.at <= context.currentTime || !match(meta)) continue;
      try { source.stop(); } catch {}
      sources.delete(source);
      drop_ack(source);
      stopped += 1;
    }
    if (stopped) recompute_playhead();
    return stopped;
  }

  function cancel_previews({ message_id } = {}) {
    if (message_id != null) retired.add(message_id);
    return cancel_unstarted(meta => meta.preview && (message_id == null || meta.message_id === message_id));
  }

  function cancel_announcements() {
    announcement_generation += 1;
    return cancel_unstarted(meta => meta.announcement);
  }

  function schedule(frame, cue, speech, guard) {
    const earliest = context.currentTime + START_MARGIN_S;
    const serial = Boolean(speech) || !IMMEDIATE_CUES.has(frame.cue);
    const cue_at = serial ? Math.max(earliest, playhead) : earliest;
    const cue_audible = Boolean(cue) && levels.cue > 0;
    const voice_audible = Boolean(speech) && levels.voice > 0;
    const first_speech_at = cue_at + (cue_audible && voice_audible ? cue.duration + app_timing.cueGapMs / 1000 : 0);
    if (guard.deadline != null && (first_speech_at - context.currentTime) * 1000 > guard.deadline - performance.now()) return;
    const meta = { message_id: frame.messageId ?? null, preview: guard.preview, announcement: guard.announcement != null, serial };
    let cursor = cue_at;

    let cue_source = null;
    if (cue_audible) {
      cue_source = start_source(cue, cue_channels.get(frame.cue) ?? cue_gain, cue_at, 1, meta);
      cursor += cue.duration + (speech ? app_timing.cueGapMs / 1000 : 0);
    }
    let speech_at = null;
    let speech_source = null;
    if (voice_audible) {
      speech_at = cursor;
      const rate = Number.isFinite(frame.rate) ? Math.max(0.8, Math.min(1.2, frame.rate)) : 1;
      speech_source = start_source(speech, voice_gain, speech_at, rate, meta);
      cursor += speech.duration / rate;
    }
    if (serial) playhead = cursor + QUEUE_TAIL_S;

    if (speech && !voice_audible) report('playback', 'Voice volume is at zero, so this message was not heard.');
    else if (!speech && !cue_audible) report('playback', cue ? 'Sound volume is at zero.' : 'That sound is not loaded.');
    else report('playback', '');

    if (!frame.messageId) return;
    if (speech_at !== null) arm_heard(frame.messageId, speech_at, speech_source);
    else if (!speech && frame.cue === 'urgent' && cue_audible) arm_heard(frame.messageId, cue_at, cue_source);
  }

  function start(frame, cue, speech, guard) {
    const alive = () => guard.generation === session_generation
      && (guard.announcement == null || guard.announcement === announcement_generation)
      && !(frame.messageId && retired.has(frame.messageId))
      && !(guard.deadline != null && performance.now() > guard.deadline);
    if (!alive()) return;
    if (context?.state === 'running') {
      schedule(frame, cue, speech, guard);
      return;
    }
    resume_briefly().then(running => {
      if (guard.generation !== session_generation) return;
      if (!alive()) return;
      if (running) schedule(frame, cue, speech, guard);
      else report('playback', 'Audio is not running, so this message was not heard. Tap to resume.');
    });
  }

  function play(frame) {
    if (frame.messageId && retired.has(frame.messageId)) return;
    const preview = is_preview(frame);
    const announcement = frame.kind === 'announcement';
    const window_ms = Number(frame.expiresAt) - Number(frame.decisionAt);
    const guard = {
      generation: session_generation,
      preview,
      announcement: announcement ? announcement_generation : null,
      deadline: announcement
        ? performance.now() + (Number.isFinite(frame.expiresAfterMs) ? frame.expiresAfterMs : ANNOUNCEMENT_START_LIMIT_MS)
        : preview
        ? performance.now() + (Number.isFinite(window_ms) && window_ms > 0 ? window_ms : PREVIEW_START_LIMIT_MS)
        : null,
    };
    const cue = cues.get(frame.cue) ?? null;
    if (frame.key) {
      const buffer = cache_banks.get(frame.activeId)?.get(frame.key);
      if (!buffer) {
        report('playback', 'A message arrived that is not cached yet.');
        return;
      }
      start(frame, cue, buffer, guard);
      return;
    }
    if (frame.url) {
      fetch_decode(new URL(frame.url, location.href).href)
        .then(buffer => start(frame, cue, buffer, guard))
        .catch(() => report('playback', 'A live message could not load.'));
      return;
    }
    start(frame, cue, null, guard);
  }

  function play_cue(name) {
    const cue = cues.get(name);
    if (!cue || !context || context.state !== 'running' || levels.cue <= 0) return null;
    const at = context.currentTime + START_MARGIN_S;
    start_source(cue, cue_channels.get(name) ?? cue_gain, at);
    return performance.now() + START_MARGIN_S * 1000;
  }

  async function test_side(side) {
    if (!await resume_briefly()) return 'Audio is not running. Tap again.';
    if (levels.voice <= 0) return 'Voice volume is at zero.';
    if (!context.createStereoPanner) return 'This browser cannot pan left and right.';
    try {
      const sample = await load_shared('/assets/test-' + side + '.mp3');
      const panner = context.createStereoPanner();
      panner.pan.value = side === 'left' ? -1 : 1;
      panner.connect(voice_gain);
      const source = start_source(sample, panner, context.currentTime + START_MARGIN_S);
      source.onended = () => panner.disconnect();
      return '';
    } catch {
      return 'The test whisper did not load.';
    }
  }

  function clear_session() {
    session_generation += 1;
    playhead = 0;
    cache_banks.clear();
    shared_buffers.clear();
    for (const source of sources.keys()) {
      try { source.stop(); } catch {}
    }
    sources.clear();
    for (const ack of acks) clearTimeout(ack.timer);
    acks.clear();
    retired.clear();
    heard_backlog.clear();
    clearInterval(backlog_timer);
    backlog_timer = null;
  }

  return {
    context: ensure_context,
    unlock,
    resume: resume_briefly,
    preload_cues,
    load_manifest,
    clear_session,
    cancel_previews,
    cancel_announcements,
    flush_heard,
    play,
    play_cue,
    test_side,
    configure({ volumes: next_volumes, timing: next_timing }) {
      if (next_timing) app_timing = next_timing;
      if (!next_volumes) return;
      levels = { ...levels, ...next_volumes };
      if (cue_gain) cue_gain.gain.value = levels.cue;
      if (voice_gain) voice_gain.gain.value = levels.voice;
    },
    get running() { return context?.state === 'running'; },
    has_cue(name) { return cues.has(name); },
  };
}
