// One shared room microphone (the MacBook's), split into per-person transcripts.
//
// The Stage-side page streams 16 kHz PCM here. We keep one ElevenLabs Scribe
// realtime socket with diarization on (only `scribe_v3_live` supports it) and
// turn each `diarized_transcript` into runs of words by speaker. Speaker ids are
// anonymous (speaker_0, speaker_1, ...) but stable for the life of the socket, so
// the first two voices are auto-assigned to seats A and B and the operator can
// reassign or swap them. `speakers_merged` events are applied in arrival order.

export const ROOM_MIC_MODEL = 'scribe_v3_live';
const SEATS = ['A', 'B'];
const MAX_LINES = 60;
const MAX_QUEUE_CHARS = 128_000;

// Pure helpers, exported for tests.

export function resolveSpeaker(merges, id) {
  let current = id;
  for (let hops = 0; current != null && merges.has(current) && hops < 64; hops += 1) current = merges.get(current);
  return current;
}

// Group a diarized segment's words into consecutive runs by speaker. Words with
// no speaker id join the run before them (or the next one at the very start).
export function splitRuns(words, merges = new Map()) {
  const runs = [];
  let pending = '';
  for (const word of Array.isArray(words) ? words : []) {
    const text = typeof word?.text === 'string' ? word.text : '';
    if (!text || word.type === 'audio_event') continue;
    const speaker = word.speaker_id == null ? null : resolveSpeaker(merges, String(word.speaker_id));
    if (word.type === 'spacing') {
      if (runs.length) runs.at(-1).text += text;
      continue;
    }
    if (speaker == null) {
      if (runs.length) runs.at(-1).text += (needsSpace(runs.at(-1).text) ? ' ' : '') + text;
      else pending += (pending ? ' ' : '') + text;
      continue;
    }
    const last = runs.at(-1);
    if (last && last.speaker === speaker) last.text += (needsSpace(last.text) ? ' ' : '') + text;
    else {
      runs.push({ speaker, text: pending ? pending + ' ' + text : text });
      pending = '';
    }
  }
  if (pending && !runs.length) runs.push({ speaker: null, text: pending });
  return runs.map(run => ({ ...run, text: run.text.replace(/\s+/g, ' ').trim() })).filter(run => run.text);
}

function needsSpace(text) {
  return text.length > 0 && !/\s$/.test(text);
}

export function createRoomMic({
  env = process.env,
  WebSocketImpl,
  wsBase = 'wss://api.elevenlabs.io',
  vadSilenceSecs = 0.6,
  now = () => Date.now(),
  onLine,
  onChange,
} = {}) {
  let ws = null;
  let open = false;
  let generation = 0;
  let status = 'off';
  let detail = '';
  let queue = [];
  let queued = 0;
  let lines = [];
  let level = 0;
  const merges = new Map();
  const speakers = new Map(); // speaker id -> { seat, words, last }

  const changed = () => { try { onChange?.(); } catch {} };
  const setStatus = (next, text = '') => {
    if (status === next && detail === text) return;
    status = next;
    detail = text;
    changed();
  };

  function seatFor(id) {
    if (id == null) return null;
    let entry = speakers.get(id);
    if (!entry) {
      const taken = new Set([...speakers.values()].map(value => value.seat).filter(Boolean));
      entry = { seat: SEATS.find(seat => !taken.has(seat)) ?? null, words: 0, last: '' };
      speakers.set(id, entry);
    }
    return entry.seat;
  }

  function applyMerge(from, to) {
    if (from == null || to == null || from === to) return;
    merges.set(String(from), String(to));
    const source = speakers.get(String(from));
    const target = resolveSpeaker(merges, String(to));
    if (source) {
      const dest = speakers.get(target);
      if (!dest) speakers.set(target, source);
      else {
        dest.words += source.words;
        if (!dest.seat) dest.seat = source.seat;
      }
      speakers.delete(String(from));
    }
    const seat = speakers.get(target)?.seat ?? null;
    for (const line of lines) {
      if (line.speaker === String(from)) Object.assign(line, { speaker: target, seat });
    }
    changed();
  }

  function receive(message) {
    const type = message?.message_type;
    if (type === 'session_started') {
      open = true;
      const pending = queue;
      queue = [];
      queued = 0;
      for (const chunk of pending) sendChunk(chunk);
      setStatus('live');
      return;
    }
    if (type === 'speakers_merged') return applyMerge(message.from_speaker_id, message.to_speaker_id);
    if (type === 'diarized_transcript') {
      for (const run of splitRuns(message.words, merges)) {
        const seat = seatFor(run.speaker);
        if (run.speaker != null) {
          const entry = speakers.get(run.speaker);
          entry.words += run.text.split(' ').length;
          entry.last = run.text;
        }
        const line = { at: now(), speaker: run.speaker, seat, text: run.text };
        lines.push(line);
        if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
        try { onLine?.(line); } catch {}
      }
      changed();
      return;
    }
    if (type && /error|invalid|exceeded|throttled|limited|unaccepted|insufficient/.test(type)) {
      setStatus('error', String(message.error ?? type));
    }
  }

  function sendChunk(b64) {
    try {
      ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: 16000 }));
    } catch {}
  }

  async function resolveWs() {
    if (WebSocketImpl) return WebSocketImpl;
    const mod = await import('ws');
    return mod.default ?? mod.WebSocket;
  }

  async function start() {
    const key = (env.ELEVENLABS_API_KEY || '').trim();
    if (!key) {
      setStatus('error', 'ELEVENLABS_API_KEY is not set');
      return false;
    }
    if (ws) return true;
    const gen = ++generation;
    setStatus('connecting');
    const WS = await resolveWs();
    if (gen !== generation) return false;
    const params = new URLSearchParams({
      model_id: ROOM_MIC_MODEL, audio_format: 'pcm_16000', commit_strategy: 'vad', diarize: 'true',
      vad_silence_threshold_secs: String(vadSilenceSecs),
    });
    const socket = new WS(`${wsBase}/v1/speech-to-text/realtime?${params}`, { headers: { 'xi-api-key': key } });
    ws = socket;
    const live = () => gen === generation && ws === socket;
    const on = (event, fn) => (typeof socket.on === 'function' ? socket.on(event, fn) : socket.addEventListener(event, fn));
    on('message', raw => {
      if (!live()) return;
      const data = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
      try { receive(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))); } catch {}
    });
    on('error', error => { if (live()) setStatus('error', String(error?.message ?? 'socket error')); });
    on('close', () => {
      if (!live()) return;
      ws = null;
      open = false;
      if (status !== 'error') setStatus('off', 'Transcription socket closed');
    });
    return true;
  }

  function stop() {
    generation += 1;
    const socket = ws;
    ws = null;
    open = false;
    queue = [];
    queued = 0;
    level = 0;
    try { socket?.close(); } catch {}
    setStatus('off');
  }

  function push(b64, frameLevel) {
    if (typeof b64 !== 'string' || !b64) return;
    if (Number.isFinite(frameLevel)) level = Math.min(1, Math.max(0, frameLevel));
    if (!ws) return;
    if (open) return sendChunk(b64);
    queue.push(b64);
    queued += b64.length;
    while (queued > MAX_QUEUE_CHARS && queue.length) queued -= queue.shift().length;
  }

  function assign(id, seat) {
    const entry = speakers.get(String(id));
    if (!entry || (seat !== null && !SEATS.includes(seat))) return;
    if (seat) for (const other of speakers.values()) if (other !== entry && other.seat === seat) other.seat = null;
    entry.seat = seat;
    relabel();
    changed();
  }

  function swap() {
    for (const entry of speakers.values()) {
      if (entry.seat === 'A') entry.seat = 'B';
      else if (entry.seat === 'B') entry.seat = 'A';
    }
    relabel();
    changed();
  }

  // Lines always follow their speaker's current seat.
  function relabel() {
    for (const line of lines) if (line.speaker != null) line.seat = speakers.get(line.speaker)?.seat ?? null;
  }

  function clear() {
    lines = [];
    speakers.clear();
    merges.clear();
    changed();
  }

  function snapshot() {
    return {
      status, detail, model: ROOM_MIC_MODEL, level,
      speakers: [...speakers.entries()].map(([id, entry]) => ({ id, ...entry })),
      lines: lines.slice(-40),
    };
  }

  return { start, stop, push, receive, assign, swap, clear, snapshot, get active() { return Boolean(ws); } };
}
