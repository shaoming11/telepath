/*
 * Telepathy stage screen: lobby, live board, reveal, plus hidden operator controls.
 * The stage is a view of the hub. It renders state and sends operator frames.
 * The operator's canned take can play bundled ElevenLabs clips.
 */

import { createAudioEngine } from './phone-audio.mjs';
import { mountChannelMonitor } from './channel-monitor.mjs';
import { createCapture } from './capture.mjs';
import { APP_TIMING, SIGNAL_LABELS } from './phone-data.mjs';
import { announcementText, OPERATOR_ANNOUNCEMENTS } from './announcements.mjs';

export const SEATS = Object.freeze(['A', 'B']);
export const PHASES = Object.freeze(['lobby', 'live', 'reveal']);
export const SIGNALS = Object.freeze(['R1', 'R2', 'L1', 'L2', 'LR', 'OUT', 'BACK']);
export const PRESETS = Object.freeze(['Pitch', 'Party', 'Meeting', 'Custom']);
const FIXED_SIGNALS = new Set(['R1', 'R2', 'L1', 'OUT']);
const LIVE_TRANSCRIPT_LINES = 12;
const PITCH_BEATS = Object.freeze(['opening', 'problem', 'demo', 'closing']);
const COACH_STATUSES = Object.freeze(['idle', 'asking', 'ready', 'sent']);
const COACH_SOURCES = Object.freeze({
  maritime: 'Maritime agent', 'maritime-assisted': 'Maritime · OpenAI-assisted', 'maritime-rules': 'Maritime rules fallback', local: 'Local fallback',
});
export const OPERATOR_ACTIONS = Object.freeze([
  'begin', 'preset', 'inject', 'replay', 'canned', 'reset', 'reveal', 'announce', 'coach_ask', 'coach_send',
]);

const SIGNAL_ROLES = Object.freeze({
  R1: 'fixed 1 · confirms a draft',
  R2: 'fixed 2',
  L1: 'fixed 3 · discards a draft',
  L2: 'hear the codebook',
  LR: 'ask for a smart message',
  OUT: 'earbud out · urgent',
  BACK: 'earbud back',
});

const KIND_LABELS = Object.freeze({
  signal: 'signal', draft: 'draft', message: 'message', receipt: 'receipt',
  error: 'error', system: 'system', preset: 'preset', canned: 'canned',
  discard: 'discarded', expire: 'expired', situation: 'situation', preview_playback: 'preview playback',
  confirm: 'confirmed', preset_suggestion: 'suggestion', replay: 'replay',
  back: 'earbud back', cache_error: 'cache error', announcement: 'announcement',
  answer_evidence: 'answer evidence', pitch_help: 'private pitch cue',
});

/* ── shapes: the hub is the source of truth, so every field is read defensively ── */

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const asList = value => (Array.isArray(value) ? value : []);

function asText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

function asNumber(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function asBool(value) {
  return value === true ? true : value === false ? false : null;
}

function seatKey(value) {
  const text = asText(value);
  if (!text) return null;
  const upper = text.toUpperCase();
  return SEATS.includes(upper) ? upper : upper.slice(0, 6);
}

function normalizeEvent(value) {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) {
    return { id: null, kind: null, seat: null, to: null, signal: null, text: null, at: null, bits: null, canned: false, urgent: false };
  }
  if (typeof value === 'string') {
    const text = asText(value);
    return text ? { id: null, kind: null, seat: null, to: null, signal: null, text, at: null, bits: null, canned: false, urgent: false } : null;
  }
  if (typeof value !== 'object') return null;
  if (!isObject(value)) return null;
  const signal = firstText(value.signal);
  const source = firstText(value.source, value.via, value.origin);
  return {
    id: firstText(value.id, value.messageId),
    kind: firstText(value.kind, value.type),
    seat: seatKey(value.seat ?? value.from),
    to: seatKey(value.to),
    signal,
    text: firstText(value.text, value.message, value.meaning, value.label, value.detail),
    at: asNumber(value.at ?? value.time),
    expiresAt: asNumber(value.expiresAt),
    heardAt: asNumber(value.heardAt),
    bits: asNumber(value.bits),
    playedAt: asNumber(value.playedAt),
    latencyMs: Number.isFinite(value.latencyMs) ? value.latencyMs : null,
    canned: value.canned === true || source === 'canned',
    urgent: signal === 'OUT' || firstText(value.cue) === 'urgent',
  };
}

function normalizeCanned(value) {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return { active: true, label: null, at: null };
  const text = asText(value);
  if (text) return { active: true, label: text, at: null };
  if (!isObject(value)) return null;
  for (const flag of ['active', 'playing', 'running', 'started', 'enabled']) {
    if (typeof value[flag] === 'boolean') {
      return value[flag] ? { active: true, label: firstText(value.label, value.name, value.take, value.id, value.text), at: asNumber(value.at ?? value.startedAt) } : null;
    }
  }
  // an availability-only shape says a take exists, not that it is playing
  if (typeof value.available === 'boolean' || typeof value.ready === 'boolean') return null;
  return { active: true, label: firstText(value.label, value.name, value.take, value.id, value.text), at: asNumber(value.at ?? value.startedAt) };
}

function normalizeCodebook(value, preset) {
  const book = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const signal = firstText(item?.signal, item?.key);
      const meaning = firstText(item?.meaning, item?.text, item?.message);
      if (signal && meaning) book[signal] = meaning;
    }
    return book;
  }
  if (!isObject(value)) return book;
  let source = value;
  if (preset && isObject(value[preset])) source = value[preset];
  else if (!SIGNALS.some(signal => signal in value)) {
    const nested = Object.values(value).find(isObject);
    if (nested) source = nested;
  }
  for (const [signal, meaning] of Object.entries(source)) {
    const text = typeof meaning === 'string' ? asText(meaning) : firstText(meaning?.meaning, meaning?.text, meaning?.message);
    if (text) book[signal] = text;
  }
  return book;
}

function normalizePresetPending(value) {
  if (value === true) return 'pending';
  const text = asText(value);
  if (text) return text;
  if (isObject(value)) return firstText(value.preset, value.to, value.next, value.label);
  return null;
}

function normalizeSeat(key, value, onlineMap) {
  const seat = isObject(value) ? value : {};
  const earbudsLabel = typeof seat.earbuds === 'string' ? asText(seat.earbuds) : null;
  return {
    key,
    name: firstText(seat.name) ?? 'Seat ' + key,
    online: asBool(seat.online) ?? asBool(onlineMap?.[key]) ?? false,
    sim: asBool(seat.sim) ?? false,
    mode: asNumber(seat.mode),
    drafts: asBool(seat.drafts),
    listening: asBool(seat.listening),
    transcription: firstText(seat.transcription),
    voice: firstText(seat.voice),
    earbuds: { done: asBool(seat.earbuds), label: earbudsLabel },
    calibrated: asBool(seat.calibrated),
    ready: asBool(seat.ready),
    situation: firstText(seat.situation),
    transcript: asList(seat.transcript)
      .map(line => ({ at: asNumber(line?.at), text: firstText(line?.text, line) }))
      .filter(line => line.text),
    pending: normalizeEvent(seat.pending),
    lastIn: normalizeEvent(seat.lastIn),
    lastOut: normalizeEvent(seat.lastOut),
  };
}

function normalizeCoach(value) {
  if (!isObject(value)) return null;
  return {
    available: value.available === true,
    status: COACH_STATUSES.includes(value.status) ? value.status : 'idle',
    beat: PITCH_BEATS.includes(value.beat) ? value.beat : null,
    id: firstText(value.id),
    text: firstText(value.text),
    reason: firstText(value.reason),
    source: Object.hasOwn(COACH_SOURCES, value.source) ? value.source : null,
    announcementId: firstText(value.announcementId),
  };
}

export function normalizeState(raw) {
  const source = isObject(raw) ? raw : {};
  const onlineMap = isObject(source.online) ? source.online : {};
  const seatsRaw = isObject(source.seats) ? source.seats : {};
  const preset = firstText(source.preset);
  const log = asList(source.log)
    .map(entry => {
      const normalized = normalizeEvent(entry);
      return normalized && (normalized.kind || normalized.text || normalized.signal) ? normalized : null;
    })
    .filter(Boolean)
    .map((entry, index) => ({ ...entry, key: entry.id ?? 'index:' + index }));
  return {
    phase: PHASES.includes(source.phase) ? source.phase : 'lobby',
    hubId: firstText(source.hubId),
    sessionId: firstText(source.sessionId, source.id),
    cacheId: firstText(source.cacheId, source.activeId),
    preset,
    presetPending: normalizePresetPending(source.presetPending),
    context: firstText(source.context),
    canBegin: asBool(source.canBegin),
    bits: asNumber(source.bits),
    startedAt: asNumber(source.startedAt),
    canned: normalizeCanned(source.canned),
    announcement: isObject(source.announcement) ? source.announcement : null,
    references: asList(source.references),
    referencesLoading: source.referencesLoading === true,
    questionAnswering: source.questionAnswering === true,
    questionState: isObject(source.questionState) ? source.questionState : { status: 'idle' },
    roomInput: source.roomInput ?? 'phones',
    room: isObject(source.room) ? source.room : { listening: false, transcription: 'off', transcript: [] },
    answerHistory: asList(source.log).filter(entry => ['answer_evidence', 'pitch_help'].includes(entry?.kind)),
    coach: normalizeCoach(source.coach),
    codebook: normalizeCodebook(source.codebook, preset),
    seats: { A: normalizeSeat('A', seatsRaw.A, onlineMap), B: normalizeSeat('B', seatsRaw.B, onlineMap) },
    log,
  };
}

/* ── pure views ─────────────────────────────────────── */

export function formatOffset(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return String(minutes).padStart(2, '0') + ':' + seconds;
  return String(Math.floor(minutes / 60)) + ':' + String(minutes % 60).padStart(2, '0') + ':' + seconds;
}

export function timelineBase(state) {
  // the hub logs preset and cache errors before Begin, so startedAt wins and
  // anything older is clamped to 00:00 rather than shifting every offset.
  const started = asNumber(state?.startedAt);
  if (started !== null) return started;
  const times = asList(state?.log).map(entry => entry.at).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

export function offsetFrom(base, at) {
  return base === null || !Number.isFinite(at) ? null : Math.max(0, at - base);
}

export function timelineRows(state) {
  const log = asList(state?.log);
  const messages = log.filter(entry => entry.kind === 'message');
  const rows = messages.length ? messages : log.filter(entry => entry.text || entry.signal);
  const base = timelineBase(state);
  const times = rows.map(entry => entry.at).filter(Number.isFinite);
  const span = times.length && base !== null ? Math.max(...times) - base : 0;
  return rows.map((entry, index) => {
    const offsetMs = offsetFrom(base, entry.at);
    const fallback = rows.length > 1 ? index / (rows.length - 1) : 0;
    const ratio = span > 0 && offsetMs !== null ? offsetMs / span : fallback;
    return { ...entry, offsetMs, offsetLabel: formatOffset(offsetMs), position: Math.min(1, Math.max(0, ratio)) };
  });
}

export function operatorFrame(action, options = {}) {
  if (!OPERATOR_ACTIONS.includes(action)) return null;
  const frame = { type: 'operator', action };
  if (action === 'preset') {
    const preset = firstText(options.preset);
    if (!preset) return null;
    frame.preset = preset;
    const context = firstText(options.context);
    if (context) frame.context = context;
  }
  if (action === 'inject') {
    const seat = seatKey(options.seat);
    const signal = firstText(options.signal);
    if (!seat || !FIXED_SIGNALS.has(signal)) return null;
    frame.seat = seat;
    frame.signal = signal;
  }
  if (action === 'announce') {
    const text = announcementText(options.text);
    if (!text) return null;
    frame.text = text;
  }
  if (action === 'coach_ask') {
    if (!PITCH_BEATS.includes(options.beat)) return null;
    frame.beat = options.beat;
  }
  if (action === 'coach_send') {
    const id = typeof options.coachId === 'string' ? asText(options.coachId) : null;
    if (!id) return null;
    frame.coachId = id;
  }
  return frame;
}

export function joinGuidance(info) {
  if (!isObject(info)) return null;
  const joinUrl = firstText(info.joinUrl);
  const secure = asBool(info.secure);
  let scheme = null;
  let host = null;
  if (joinUrl) {
    try {
      const url = new URL(joinUrl);
      scheme = url.protocol.replace(':', '');
      host = url.hostname.replace(/^\[|\]$/g, '');
    } catch { /* an address the hub printed by hand is still worth showing */ }
  }
  if (secure === true || scheme === 'wss' || scheme === 'https') {
    const certificate = firstText(info.certificateUrl);
    return certificate
      ? 'Served with a local certificate. Install it on each phone once from ' + certificate + ', then open the join address and the microphone works.'
      : 'Served with a local certificate. Each phone has to accept the certificate warning once; after that the microphone opens normally.';
  }
  if (secure === false || scheme === 'ws' || scheme === 'http') {
    if (host && ['localhost', '127.0.0.1', '::1'].includes(host)) return null;
    return 'Insecure origin at ' + (host ?? 'this address') + '. Browsers only open the microphone on a secure origin or on localhost, so start the hub with local TLS and share that address with the phones.';
  }
  return null;
}

export function seatReadout(seat) {
  if (!seat) return [];
  const modeLabel = seat.mode === 1 ? 'one earbud' : seat.mode === 2 ? 'two earbuds' : null;
  return [
    { label: 'Connection', value: (seat.online ? 'online' : 'offline') + (seat.sim ? ' · rehearsal' : ''), tone: seat.online ? 'ok' : 'wait' },
    { label: 'Voice', value: seat.voice ?? 'not started', tone: seat.voice === 'ready' || seat.voice === 'fallback' ? 'ok' : seat.voice === 'error' ? 'flag' : 'wait' },
    {
      label: 'Earbuds',
      value: [
        seat.earbuds.done === true ? 'tested' : seat.earbuds.done === false ? 'not tested' : seat.earbuds.label ?? 'unknown',
        modeLabel,
      ].filter(Boolean).join(' · '),
      tone: seat.earbuds.done === true ? 'ok' : 'wait',
    },
    { label: 'Calibrated', value: seat.calibrated === true ? 'taught' : seat.calibrated === false ? 'not taught' : 'unknown', tone: seat.calibrated === true ? 'ok' : 'wait' },
    { label: 'Room', value: roomStatus(seat), tone: seat.transcription === 'live' || seat.sim ? 'ok' : 'wait' },
    { label: 'Ready', value: seat.ready === true ? 'ready' : seat.ready === false ? 'waiting' : 'unknown', tone: seat.ready === true ? 'flag' : 'wait' },
  ];
}

// One plain line per seat for the lobby: where it is in setup.
export function seatSummary(seat) {
  if (!seat) return { text: 'Waiting', tone: 'wait', state: 'waiting' };
  if (seat.ready === true) return { text: 'Ready', tone: 'ok', state: 'ready' };
  if (!seat.online) return { text: 'Waiting to join', tone: 'wait', state: 'waiting' };
  if (seat.voice === 'error') return { text: 'Voice failed', tone: 'flag', state: 'setup' };
  if (seat.voice !== 'ready' && seat.voice !== 'fallback') return { text: 'Setting up voice', tone: 'wait', state: 'setup' };
  if (seat.earbuds.done !== true) return { text: 'Testing earbuds', tone: 'wait', state: 'setup' };
  if (seat.calibrated !== true) return { text: 'Calibrating', tone: 'wait', state: 'setup' };
  return { text: 'Choosing preset', tone: 'wait', state: 'setup' };
}

// Rough speaking time for a transcript line, used to draw speech on the reveal lanes.
export function speechSpanMs(text) {
  const words = text?.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return Math.max(600, words * 360);
}

export function roomStatus(seat) {
  if (seat.sim) return 'Simulated';
  if (!seat.online) return 'Offline';
  if (seat.transcription === 'live') return 'Transcribing';
  if (seat.transcription === 'recovering') return 'Reconnecting';
  if (seat.transcription === 'unavailable') return 'Transcription unavailable';
  if (seat.listening) return 'Connecting microphone';
  return 'Mic off';
}

export function lobbyRoomSignal(state, connected) {
  if (!connected) return { mode: 'offline', label: 'HUB · OFFLINE', notice: 'Stage is waiting for the hub.' };
  const seats = SEATS.map(key => state.seats[key]).filter(seat => seat.online);
  if (state.roomInput === 'mac') {
    switch (state.room?.transcription) {
      case 'live': return { mode: 'live', label: 'ROOM · TRANSCRIBING', notice: 'Mac room transcription is live.' };
      case 'waiting': return { mode: 'waiting', label: 'ROOM · CONNECTING', notice: 'Mac room transcription is connecting.' };
      case 'recovering': return { mode: 'waiting', label: 'ROOM · RECONNECTING', notice: 'Mac room transcription is reconnecting.' };
      case 'unavailable': return { mode: 'unavailable', label: 'ROOM · UNAVAILABLE', notice: 'Mac room transcription is unavailable.' };
    }
  } else if (seats.some(seat => seat.transcription === 'live')) {
    return { mode: 'live', label: 'SEATS · TRANSCRIBING', notice: 'Phone transcription is live.' };
  }
  if (seats.length && seats.every(seat => seat.sim)) {
    return { mode: 'rehearsal', label: 'AGENT · REHEARSAL', notice: 'The seats are in rehearsal mode.' };
  }
  return { mode: 'off', label: 'AGENT · STANDING BY', notice: 'Room transcription is off.' };
}

export function roomConsoleStatus({ link, phase, canned, ownedElsewhere, starting, interrupted, wanted, transcription, message, device }) {
  if (link !== 'live') return { tone: 'off', label: 'Offline', detail: 'Connect to the hub to use the Mac microphone.' };
  if (phase === 'reveal' || canned) return { tone: 'off', label: 'Off', detail: 'Room listening is off for this take.' };
  if (message || transcription === 'unavailable') return { tone: 'error', label: 'Unavailable', detail: message || 'Check the ElevenLabs connection and try again.' };
  if (ownedElsewhere) return { tone: 'off', label: 'In use', detail: 'Another Stage tab is using the room microphone.' };
  if (starting) return { tone: 'starting', label: 'Starting', detail: 'Allow microphone access in Safari if prompted.' };
  if (interrupted) return { tone: 'starting', label: 'Interrupted', detail: 'The microphone is paused. Check the selected input.' };
  if (wanted && transcription === 'live') return { tone: 'live', label: 'Transcribing', detail: device || 'Sending room audio to ElevenLabs.' };
  if (wanted && transcription === 'recovering') return { tone: 'starting', label: 'Reconnecting', detail: 'Restoring the ElevenLabs connection.' };
  if (wanted) return { tone: 'starting', label: 'Connecting', detail: 'Waiting for ElevenLabs transcription.' };
  return { tone: 'off', label: 'Off', detail: 'Start listening and allow microphone access.' };
}

export function revealSummary(state) {
  const messages = state.log.filter(entry => entry.kind === 'message');
  const wordCount = entries => entries.reduce((sum, entry) =>
    sum + (entry.text?.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0), 0);
  const started = messages.filter(entry => entry.playedAt != null);
  return { messages: messages.length, words: wordCount(messages), playbackStarts: started.length, playbackWords: wordCount(started) };
}

export function announcementNote(progress) {
  const heard = asList(progress.heard).filter(seat => SEATS.includes(seat));
  const targets = asList(progress.targets).filter(seat => SEATS.includes(seat));
  switch (progress.status) {
    case 'building': return 'Generating the system voice.';
    case 'queued': return 'Waiting for playback on ' + targets.filter(seat => !heard.includes(seat)).join(' and ') + '.';
    case 'played': return 'Playback confirmed on both seats.';
    case 'partial': return 'Playback confirmed on Seat ' + heard.join(' and ') + '.';
    case 'failed':
      if (progress.reason === 'playback_timeout') return 'Neither seat confirmed playback. Check the two phones.';
      if (progress.reason === 'no_seats') return 'Connect a seat first.';
      if (progress.reason === 'seat_left' || progress.reason === 'seat_offline') {
        return 'The seat disconnected before playback. Reconnect it, then send again.';
      }
      return 'The announcement voice was unavailable. Try a preset line.';
    default: return null;
  }
}

export function announcementView(state, online, raw) {
  const connected = SEATS.filter(seat => state.seats[seat].online);
  const rehearsal = connected.length > 0 && connected.every(seat => state.seats[seat].sim);
  const text = announcementText(raw);
  const progress = state.announcement;
  const busy = progress?.status === 'building' || progress?.status === 'queued';
  const presenting = state.canned || state.phase === 'reveal';
  const target = connected.length === 2 ? 'both seats' : connected[0] ? 'Seat ' + connected[0] : null;
  const note = presenting ? 'Available before the reveal.'
    : !online ? 'Waiting for the hub.'
    : !target ? 'Connect a seat to send an announcement.'
    : rehearsal ? 'Choose a preset for the simulated seats.'
    : connected.length === 2 ? 'Both seats online.' : target + ' online.';
  const canSend = Boolean(text && target && online && !busy && !presenting
    && (!rehearsal || OPERATOR_ANNOUNCEMENTS.some(line => line.text === text)));
  let receipt = null;
  if (progress?.id && typeof progress.text === 'string') {
    const heard = asList(progress.heard);
    const targets = asList(progress.targets);
    const seats = SEATS.map(seat => {
      if (!targets.includes(seat)) return { seat, tone: 'off', label: 'Offline at send' };
      if (heard.includes(seat)) return { seat, tone: 'started', label: 'Playback started' };
      if (progress.status === 'building') return { seat, tone: 'waiting', label: 'Preparing audio' };
      if (progress.status === 'queued') return { seat, tone: 'waiting', label: 'Waiting for playback' };
      if (['voice_unavailable', 'speech_timeout'].includes(progress.reason)) return { seat, tone: 'failed', label: 'Audio unavailable' };
      return { seat, tone: 'failed', label: 'No playback confirmation' };
    });
    receipt = { id: progress.id, text: progress.text, seats, summary: announcementNote(progress) };
  }
  return { canSend, rehearsal, busy, note, action: target ? 'Send to ' + target : 'Send announcement', receipt };
}

export function pitchCoachView(state, connected, beat) {
  const { coach, announcement } = state;
  if (!coach || state.phase !== 'live' || state.preset !== 'Pitch' || state.canned) return null;

  const asking = coach.status === 'asking';
  const sent = coach.status === 'sent';
  const draft = (coach.status === 'ready' || sent) && Boolean(coach.id && coach.text);
  const changed = draft && !sent && coach.beat !== beat;
  const both_online = SEATS.every(seat => state.seats[seat].online);
  const busy = announcement?.status === 'building' || announcement?.status === 'queued';
  const source = COACH_SOURCES[coach.source] ?? 'Pitch coach';

  let note = coach.available ? 'Ask Maritime for a cue.' : 'Ask the local coach for a cue.';
  if (!connected) note = 'Waiting for the hub to reconnect.';
  else if (asking) note = coach.available ? 'Waiting for Maritime…' : 'Preparing a local cue…';
  else if (sent && coach.announcementId && coach.announcementId === announcement?.id) {
    note = announcementNote(announcement) ?? 'Cue sent.';
  } else if (sent) note = 'Cue sent.';
  else if (changed) note = 'Ask again for this pitch beat.';
  else if (draft && !both_online) note = 'Connect both seats to send.';
  else if (draft && busy) note = 'Wait for the current announcement.';
  else if (draft) note = 'Ready to send.';

  return {
    canAsk: connected && !asking,
    canSend: connected && draft && !sent && !changed && both_online && !busy,
    draft,
    note: draft ? source + ' · ' + note : note,
  };
}

/* ── DOM ────────────────────────────────────────────── */

function boot() {
  const channelMonitors = {
    lobby: mountChannelMonitor(document.getElementById('lobby-monitor'), SEATS),
    live: mountChannelMonitor(document.getElementById('stage-monitor'), SEATS),
  };
  const byId = id => document.getElementById(id);
  const body = document.body;

  const ui = {
    session: byId('session-readout'), link: byId('link-readout'),
    preset: byId('preset-readout'), clock: byId('clock-readout'),
    cannedBanner: byId('canned-banner'), cannedDetail: byId('canned-detail'),
    screens: { lobby: byId('screen-lobby'), live: byId('screen-live'), reveal: byId('screen-reveal') },
    joinUrl: byId('join-url'), stageUrl: byId('stage-url'), secure: byId('secure-readout'), guidance: byId('join-guidance'),
    certificate: byId('certificate-readout'), certificateRow: byId('certificate-row'),
    lobbySeats: byId('lobby-seats'), lobbyCodebook: byId('lobby-codebook'), codebookPreset: byId('codebook-preset'),
    begin: byId('begin-button'), beginHint: byId('begin-hint'), reveal: byId('reveal-button'),
    livePreset: byId('live-preset'), liveContext: byId('live-context'), bits: byId('bits-value'),
    liveSeats: byId('live-seats'), stream: byId('stream-list'), streamEmpty: byId('stream-empty'),
    revealBits: byId('reveal-bits'), revealCount: byId('reveal-count'),
    revealWords: byId('reveal-words'), revealLanes: byId('reveal-lanes'), revealNote: byId('reveal-message-note'),
    revealKicker: byId('reveal-kicker'), revealHead: byId('reveal-head'), revealWordLabel: byId('reveal-word-label'),
    liveMessages: byId('live-messages'), liveWords: byId('live-words'),
    readout: { A: byId('readout-a'), B: byId('readout-b'), An: byId('readout-a-name'), Bn: byId('readout-b-name'),
      preset: byId('readout-preset'), cache: byId('readout-cache') },
    diagram: byId('lobby-diagram'), diaHost: byId('dia-host'), diaAgent: byId('dia-agent'), diaRoomNotice: byId('lobby-room-notice'),
    timeline: byId('timeline-list'), timelineEmpty: byId('timeline-empty'), transcripts: byId('reveal-transcripts'),
    announce: byId('phase-announce'),
    operator: byId('operator'), opToggle: byId('op-toggle'), opClose: byId('op-close'), opStatus: byId('op-status'),
    opPreset: byId('op-preset'), opContext: byId('op-context'), opSeat: byId('op-seat'), opSignal: byId('op-signal'),
    opAnnounce: byId('op-announce'), opAnnouncePreset: byId('op-announce-preset'), opAnnounceText: byId('op-announce-text'),
    opAnnounceSend: byId('op-announce-send'), opAnnounceStatus: byId('op-announce-status'),
    opCoach: byId('op-coach'), opCoachForm: byId('op-coach-form'), opCoachBeat: byId('op-coach-beat'),
    opCoachAsk: byId('op-coach-ask'), opCoachSend: byId('op-coach-send'), opCoachStatus: byId('op-coach-status'),
    opCoachDraft: byId('op-coach-draft'), opCoachText: byId('op-coach-text'), opCoachReason: byId('op-coach-reason'),
    opBegin: byId('op-begin'), opReset: byId('op-reset'), opResetNote: byId('op-reset-note'),
  };

  const canned_audio = createAudioEngine({
    volumes: { cue: 0.6, voice: 0.75 }, timing: APP_TIMING,
    on_status: ({ key, text }) => { if (key === 'playback' && text) status(text, 'blocked'); },
  });
  let state = normalizeState(null);
  let info = null;
  let socket = null;
  let linkState = 'connecting';
  let reconnectDelay = 600;
  let reconnectTimer = 0;
  let renderHandle = 0;
  let clockTimer = 0;
  let resetArmed = 0;
  let resetTimer = 0;
  let lastPhase = null;
  let lastBits = null;
  let streamKeys = [];
  let announcementRenderKey = '';
  let revealFingerprint = '';
  const seat_fingerprints = new Map();
  const live_panels = new Map();
  let lastFocus = null;
  let uploadingReferences = false;
  let referenceMessage = '';
  let roomContext = null;
  let roomWanted = false;
  let roomStarting = false;
  let roomInterrupted = false;
  let roomAccepted = false;
  let roomAttempt = 0;
  let roomMessage = '';
  const reactRoom = Boolean(document.querySelector('[data-room-owner="react"]'));
  let roomDevices = [];
  let roomRenderKey = '';
  const roomBars = reactRoom ? [] : Array.from({ length: 24 }, () => node('span'));
  if (!reactRoom) byId('room-mic-bars').append(...roomBars);

  function setRoomLevel(level) {
    const normalized = !roomInterrupted && Number.isFinite(level) ? Math.min(1, Math.max(0, level * 5)) : 0;
    if (reactRoom) {
      document.dispatchEvent(new CustomEvent('telepathy:room-level', { detail: normalized }));
      return;
    }
    const filled = Math.round(normalized * roomBars.length);
    byId('room-mic-level').value = normalized;
    byId('room-mic-readout').textContent = roomWanted ? Math.round(normalized * 100) + '%' : '—';
    roomBars.forEach((bar, index) => bar.toggleAttribute('data-active', index < filled));
  }

  const roomCapture = createCapture({
    get_context: () => roomContext ??= new (window.AudioContext || window.webkitAudioContext)(),
    frame_ms: () => 250,
    get_constraints: () => ({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(byId('room-mic-device').value ? { deviceId: { exact: byId('room-mic-device').value } } : {}) } }),
    on_frame: frame => {
      if (roomWanted && state.room.listening && socket?.bufferedAmount < 256_000) sendRoomFrame({ type: 'room_mic', ...frame });
    },
    on_level: setRoomLevel,
    on_state: (next, detail) => {
      roomInterrupted = next === 'interrupted';
      if (roomInterrupted) setRoomLevel(0);
      if (['blocked', 'unsupported', 'error', 'lost'].includes(next)) {
        roomMessage = detail || 'Microphone unavailable.';
        stopRoomCapture();
      }
      schedule();
    },
  });

  function sendRoomFrame(frame) {
    if (socket?.readyState !== 1 || !state.hubId || !state.sessionId) return false;
    try { socket.send(JSON.stringify({ ...frame, hubId: state.hubId, sessionId: state.sessionId })); return true; }
    catch { return false; }
  }

  function stopRoomCapture(notify = true) {
    const wasWanted = roomWanted;
    roomAttempt += 1;
    roomWanted = false;
    roomStarting = false;
    roomInterrupted = false;
    roomAccepted = false;
    roomCapture.stop();
    setRoomLevel(0);
    if (notify && wasWanted) sendRoomFrame({ type: 'operator', action: 'room_listen', enabled: false });
    schedule();
  }

  async function refreshMicrophones() {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      roomDevices = (devices ?? []).filter(item => item.kind === 'audioinput' && item.deviceId)
        .map((device, index) => ({ id: device.deviceId, label: device.label || 'Microphone ' + (index + 1) }));
      if (reactRoom) {
        schedule();
        return;
      }
      const select = byId('room-mic-device');
      const selected = select.value;
      const options = [node('option', null, 'System default')];
      options[0].value = '';
      for (const device of roomDevices) {
        const option = node('option', null, device.label);
        option.value = device.id;
        options.push(option);
      }
      select.replaceChildren(...options);
      if (options.some(option => option.value === selected)) select.value = selected;
    } catch {}
  }

  async function startRoomCapture() {
    if (roomWanted || linkState !== 'live' || state.phase === 'reveal' || state.canned) return;
    const sessionId = state.sessionId, hubId = state.hubId;
    const attempt = ++roomAttempt;
    roomWanted = true;
    roomStarting = true;
    roomMessage = '';
    schedule();
    try {
      const opened = await roomCapture.start();
      if (attempt !== roomAttempt) return;
      if (!opened || !roomWanted || state.sessionId !== sessionId || state.hubId !== hubId) { stopRoomCapture(false); return; }
      roomStarting = false;
      schedule();
      if (!sendRoomFrame({ type: 'operator', action: 'room_listen', enabled: true })) {
        roomMessage = 'Hub disconnected. Reconnect and start the microphone again.';
        stopRoomCapture(false);
      }
      await refreshMicrophones();
    } catch {
      if (attempt !== roomAttempt) return;
      roomMessage = 'Could not open the microphone. Check browser and macOS microphone permissions.';
      stopRoomCapture();
    }
  }

  function renderRoomMicrophone() {
    const otherTab = state.room.listeningRequested && !roomWanted;
    const canStart = !roomWanted && !otherTab && linkState === 'live' && state.phase !== 'reveal' && !state.canned;
    const status = roomConsoleStatus({
      link: linkState, phase: state.phase, canned: state.canned, ownedElsewhere: otherTab, starting: roomStarting,
      interrupted: roomInterrupted, wanted: roomWanted, transcription: state.room.transcription,
      message: roomMessage, device: roomCapture.deviceLabel,
    });
    const notice = status.tone === 'live' && roomCapture.deviceLabel ? 'Transcribing · ' + status.detail : status.detail;
    const turns = asList(state.room.transcript);
    const canClear = turns.length > 0 && state.phase !== 'reveal' && !state.canned && linkState === 'live';
    const visible = state.phase === 'reveal' ? turns : turns.slice(-12);
    const runs = visible.flatMap(turn => turn.speakers?.length ? turn.speakers : [{ label: 'Room', text: turn.text }]);
    const speakers = new Map(turns.filter(turn => turn.streamId === state.room.speakerStream)
      .flatMap(turn => turn.speakers ?? []).filter(run => run.speaker).map(run => [run.speaker, run]));
    if (reactRoom) {
      const detail = {
        wanted: roomWanted, canStart, devices: roomDevices, tone: status.tone, label: status.label, notice,
        reviewing: state.phase === 'reveal',
        waiting: status.tone === 'live', turns: runs,
        speakers: state.phase === 'reveal' || state.canned ? [] : [...speakers].map(([id, run]) => ({
          id, label: run.label, seat: run.seat ?? '',
        })),
        speakersDisabled: linkState !== 'live', canClear,
      };
      const key = JSON.stringify(detail);
      if (key !== roomRenderKey) {
        roomRenderKey = key;
        document.dispatchEvent(new CustomEvent('telepathy:room-state', { detail }));
      }
      return;
    }

    const start = byId('room-mic-start');
    const stop = byId('room-mic-stop');
    const active = document.activeElement;
    start.disabled = !canStart;
    start.hidden = roomWanted;
    stop.hidden = !roomWanted;
    if (start.hidden && active === start) stop.focus({ preventScroll: true });
    if (stop.hidden && active === stop && !start.disabled) start.focus({ preventScroll: true });
    byId('room-mic-device').disabled = roomWanted;
    byId('room-microphone-panel').dataset.state = status.tone;
    byId('room-mic-state').textContent = status.label;
    const detail = byId('room-mic-status');
    if (detail.textContent !== notice) detail.textContent = notice;
    byId('room-transcript-clear').hidden = !canClear;
    const panel = byId('room-speakers');
    const key = JSON.stringify([state.room.speakerStream, state.phase, state.canned, linkState, [...speakers].map(([id, run]) => [id, run.label])]);
    byId('room-speaker-controls').hidden = !speakers.size || state.phase === 'reveal' || Boolean(state.canned);
    if (panel.dataset.key !== key) {
      panel.dataset.key = key;
      fill(panel, [...speakers].map(([speaker, run]) => {
        const label = node('label', null, run.label + ' ');
        const select = node('select');
        for (const [value, title] of [['', 'Unassigned'], ['A', 'Seat A'], ['B', 'Seat B']]) {
          const option = node('option', null, title);
          option.value = value;
          select.append(option);
        }
        select.value = run.seat ?? '';
        select.disabled = linkState !== 'live';
        select.addEventListener('change', () => sendRoomFrame({
          type: 'operator', action: 'room_speaker_assign', stream: state.room.speakerStream, speaker, seat: select.value || null,
        }));
        label.append(select);
        return label;
      }));
    }
    const transcript = byId('room-transcript');
    const transcriptKey = JSON.stringify(visible);
    transcript.hidden = !visible.length;
    const empty = byId('room-transcript-empty');
    empty.hidden = Boolean(visible.length);
    empty.textContent = status.tone === 'live' ? 'Waiting for the first words…' : 'Speech will appear here as it’s transcribed.';
    if (transcript.dataset.key !== transcriptKey) {
      const previousTop = transcript.scrollTop;
      const atBottom = transcript.scrollHeight - transcript.clientHeight - previousTop < 24;
      transcript.dataset.key = transcriptKey;
      fill(transcript, runs.map(run => {
        const row = node('li', 'room-console__turn');
        if (run.seat) row.dataset.seat = run.seat;
        row.append(node('span', 'room-console__speaker', run.label), node('span', null, run.text));
        return row;
      }));
      transcript.scrollTop = atBottom ? transcript.scrollHeight : previousTop;
    }
  }

  function renderReferences() {
    const busy = uploadingReferences || state.referencesLoading;
    const editable = state.phase === 'lobby' && linkState === 'live' && !busy;
    byId('reference-files').disabled = !editable;
    byId('reference-upload').disabled = !editable;
    byId('reference-clear').disabled = !editable || !state.references.length;
    byId('reference-status').textContent = busy ? 'Reading documents…' : [referenceMessage,
      !state.questionAnswering ? 'Document answering requires OPENAI_API_KEY and the OpenAI text provider. Fixed whispers and ordinary coaching remain available.'
        : !referenceMessage ? state.references.length ? 'References ready. Question answering starts with the session.' : 'Built-in Telepathy brief is ready. Upload files to add details.' : ''].filter(Boolean).join(' ');
    fill(byId('reference-list'), state.references.map(item => node('li', null, `${item.name} · ${item.characters.toLocaleString()} characters`)));
    byId('answer-panel').hidden = state.phase === 'lobby' || !state.references.length && !state.answerHistory.length;
    const answer = state.questionState;
    const labels = { idle: 'Listening for questions', researching: 'Checking the conversation and references…', waiting: 'Giving the conversation time to answer',
      answer: 'Answer found', preview: 'Private preview · awaiting approval', confirmed: 'Approved for delivery', discarded: 'Answer discarded', expired: 'Approval expired',
      resolved: 'Question answered or no longer relevant', unsupported: 'No supported answer in these references', none: 'No unanswered question',
      cancelled: 'Previous answer cancelled as the conversation changed', already_offered: 'Already offered this answer', unavailable: 'Answer unavailable. Fixed whispers still work.' };
    byId('answer-status').textContent = !state.questionAnswering ? 'Document answering is unavailable with the current text provider.' : labels[answer.status] ?? 'Listening';
    byId('answer-question').textContent = answer.question ? 'Question: ' + answer.question : '';
    byId('answer-text').textContent = answer.answer ?? '';
    fill(byId('answer-sources'), asList(answer.sources).map(source => node('li', null, `${source.name}: “${source.quote}”`)));
    const planners = { maritime: 'Maritime plan', 'maritime-rules': 'Maritime rules', 'local-policy': 'Local plan' };
    fill(byId('answer-history'), state.answerHistory.map(entry => {
      const planner = entry.kind === 'pitch_help' && Object.hasOwn(planners, entry.source) ? planners[entry.source] : '';
      const playback = entry.kind === 'pitch_help' && Number.isFinite(entry.requestToPlaybackMs) && entry.requestToPlaybackMs >= 0
        ? `${(entry.requestToPlaybackMs / 1000).toFixed(1)} s to playback start` : '';
      const metadata = [planner, playback].filter(Boolean).join(' · ');
      const evidence = asList(entry.sources).map(source => `${source.name}: “${source.quote}”`).join('; ');
      return node('li', null, [metadata ? `${entry.text} (${metadata})` : entry.text, evidence].filter(Boolean).join(' — '));
    }));
  }

  async function uploadReferences(clear = false) {
    if (uploadingReferences || state.phase !== 'lobby') return;
    const files = clear ? [] : Array.from(byId('reference-files').files ?? []);
    if (!clear && !files.length) { referenceMessage = 'Choose at least one document first.'; schedule(); return; }
    if (files.length > 8 || files.some(file => file.size > 5 * 1024 * 1024) || files.reduce((n, file) => n + file.size, 0) > 8 * 1024 * 1024) {
      referenceMessage = 'Limit: 8 documents, 5 MB per file and 8 MB total.'; schedule(); return;
    }
    const sessionId = state.sessionId, hubId = state.hubId;
    uploadingReferences = true;
    referenceMessage = '';
    schedule();
    try {
      const encoded = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
        reader.onerror = () => reject(new Error('Could not read ' + file.name));
        reader.readAsDataURL(file);
      })));
      const response = await fetch('/references', { method: 'POST', headers: { 'content-type': 'application/json',
        'x-telepathy-hub': hubId, 'x-telepathy-session': sessionId }, body: JSON.stringify({ files: encoded }), signal: AbortSignal.timeout(30_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Upload failed.');
      if (state.sessionId === sessionId && state.hubId === hubId) {
        referenceMessage = clear ? 'Documents cleared.' : `${result.documents.length} document(s) loaded.`;
        byId('reference-files').value = '';
      }
    } catch (error) {
      if (state.sessionId === sessionId && state.hubId === hubId) referenceMessage = error.message || 'Upload failed.';
    } finally { uploadingReferences = false; schedule(); }
  }

  /* elements */

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function readoutRow(label, value, tone) {
    const row = node('div', 'readout__row');
    row.append(node('dt', null, label));
    const definition = node('dd', null, value);
    if (tone) definition.setAttribute('data-' + tone, '');
    row.append(definition);
    return row;
  }

  function badge(label, tone) {
    const element = node('span', 'badge', label);
    if (tone) element.setAttribute('data-' + tone, '');
    return element;
  }

  function fill(parent, children) {
    parent.replaceChildren(...children);
  }

  function describe(event, fallback) {
    if (!event) return fallback;
    const parts = [];
    if (event.signal) parts.push(SIGNAL_LABELS[event.signal] ?? event.signal);
    if (event.text) parts.push(event.text);
    if (!parts.length && event.kind) parts.push(KIND_LABELS[event.kind] ?? event.kind);
    return parts.length ? parts.join(' · ') : fallback;
  }

  function stickToBottom(container, render) {
    const near = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    render();
    if (near) container.scrollTop = container.scrollHeight;
  }

  /* renders */

  function renderChrome() {
    body.dataset.phase = state.phase;
    body.dataset.link = linkState;
    ui.session.textContent = state.sessionId ? 'Session ' + state.sessionId : 'No session';
    ui.link.textContent = linkState === 'live' ? 'Hub online' : linkState === 'offline' ? 'Hub offline' : 'Connecting';
    const presetLabel = state.preset ?? '—';
    const pending = state.presetPending && state.presetPending !== state.preset ? ' → ' + state.presetPending : '';
    ui.preset.textContent = 'Preset ' + presetLabel + pending;

    for (const step of document.querySelectorAll('[data-phase-step]')) {
      const index = PHASES.indexOf(step.dataset.phaseStep);
      const current = PHASES.indexOf(state.phase);
      step.toggleAttribute('data-active', index === current);
      step.toggleAttribute('data-done', index < current);
    }
    for (const [phase, section] of Object.entries(ui.screens)) {
      if (section) section.hidden = phase !== state.phase;
    }
    if (state.phase !== lastPhase) {
      const enteredReveal = lastPhase === 'live' && state.phase === 'reveal';
      lastPhase = state.phase;
      revealFingerprint = '';
      ui.announce.textContent = 'Stage phase: ' + state.phase;
      const active = ui.screens[state.phase];
      if (active) active.scrollTop = 0;
      if (enteredReveal && body.dataset.surface === 'stage') {
        window.scrollTo(0, 0);
        if (!body.hasAttribute('data-operator-open')) byId('reveal-title').focus({ preventScroll: true });
      }
    }

    const canned = state.canned;
    ui.cannedBanner.hidden = !canned;
    if (canned) {
      const label = canned.label
        ? 'Recorded take: ' + canned.label
        : 'Recorded pitch replay.';
      ui.cannedDetail.textContent = label;
    }

    const epoch = state.startedAt !== null && state.startedAt > 1e12;
    ui.clock.hidden = !(epoch && state.phase === 'live');
    if (!ui.clock.hidden) tickClock();
  }

  function tickClock() {
    if (state.startedAt === null) return;
    ui.clock.textContent = formatOffset(Date.now() - state.startedAt);
  }

  function renderDiagram() {
    const summaries = {};
    for (const key of SEATS) {
      const seat = state.seats[key];
      const summary = seatSummary(seat);
      summaries[key] = summary;
      const lower = key.toLowerCase();
      byId('dia-seat-' + lower)?.setAttribute('data-state', summary.state);
      byId('dia-path-' + lower)?.toggleAttribute('data-ready', summary.state === 'ready');
      const label = byId('dia-' + lower + '-name');
      if (label) label.textContent = (key + ' · ' + seat.name).toUpperCase();
      const text = summary.text.toUpperCase();
      const pill = byId('dia-' + lower + '-state');
      if (pill) pill.textContent = text;
      byId('dia-' + lower + '-pill')?.setAttribute('width', String(Math.round(text.length * 6.3 + 16)));
      const readout = ui.readout[key];
      if (readout) {
        readout.textContent = summary.text;
        readout.dataset.tone = summary.tone;
      }
      const name = ui.readout[key + 'n'];
      if (name) name.textContent = seat.name;
    }
    const both = summaries.A.state === 'ready' && summaries.B.state === 'ready';
    ui.diagram?.setAttribute('data-flow', both || state.phase !== 'lobby' ? 'on' : 'off');
    const room = lobbyRoomSignal(state, linkState === 'live');
    if (ui.diagram && ui.diagram.dataset.roomState !== room.mode) ui.diagram.dataset.roomState = room.mode;
    if (ui.diaAgent && ui.diaAgent.textContent !== room.label) ui.diaAgent.textContent = room.label;
    if (ui.diaRoomNotice && ui.diaRoomNotice.textContent !== room.notice) ui.diaRoomNotice.textContent = room.notice;
    if (ui.readout.preset) ui.readout.preset.textContent = state.preset ?? '—';
    if (ui.readout.cache) {
      const ready = SEATS.every(key => state.seats[key].ready === true);
      ui.readout.cache.textContent = state.presetPending && state.presetPending !== state.preset ? 'Caching'
        : ready ? 'Cached' : 'After setup';
    }
  }

  function renderLobby() {
    renderDiagram();
    const seats = SEATS.map(key => {
      const seat = state.seats[key];
      const panel = node('section', 'seat');
      panel.dataset.seat = key;
      panel.dataset.ready = String(seat.ready === true);
      panel.dataset.online = String(seat.online);
      panel.setAttribute('aria-label', seat.name);
      const head = node('div', 'seat__head');
      head.append(node('span', 'seat__id', key));
      head.append(node('span', 'seat__state mono', seat.ready === true ? 'ready' : seat.online ? 'in setup' : 'waiting'));
      panel.append(head, node('p', 'seat__name', seat.name));
      const list = node('dl', 'readout');
      for (const row of seatReadout(seat)) list.append(readoutRow(row.label, row.value, row.tone));
      panel.append(list);
      return panel;
    });
    fill(ui.lobbySeats, seats);

    ui.codebookPreset.textContent = state.preset ?? '';
    const entries = Object.entries(state.codebook);
    fill(ui.lobbyCodebook, entries.length
      ? entries.map(([signal, meaning]) => readoutRow(SIGNAL_LABELS[signal] ?? signal, meaning))
      : [readoutRow('—', 'the hub has not published a codebook yet', 'wait')]);

    const blocked = state.canBegin !== true || linkState !== 'live';
    ui.begin.disabled = blocked || uploadingReferences;
    ui.beginHint.textContent = linkState !== 'live' ? 'Waiting for the hub.'
      : uploadingReferences ? 'Finishing reference setup.'
      : blocked
      ? 'Begin unlocks when both seats have a voice, tested earbuds, calibration and Ready.'
      : state.phase === 'lobby' ? 'Starts the live board on both seats.' : 'The session is already running.';
  }

  function renderLive() {
    ui.livePreset.replaceChildren(node('span', null, state.preset ?? 'no preset'));
    if (state.presetPending && state.presetPending !== state.preset) {
      ui.livePreset.append(node('span', 'live__pending', '→ ' + state.presetPending + ' caching'));
    }
    ui.liveContext.textContent = state.context ?? '';

    if (state.bits === null) ui.bits.textContent = '—';
    else {
      ui.bits.textContent = String(Math.round(state.bits * 100) / 100);
      if (state.bits !== lastBits) {
        ui.bits.removeAttribute('data-tick');
        void ui.bits.offsetWidth;
        ui.bits.setAttribute('data-tick', '');
      }
    }
    lastBits = state.bits;
    const { messages, words } = revealSummary(state);
    if (ui.liveMessages) ui.liveMessages.textContent = String(messages);
    if (ui.liveWords) ui.liveWords.textContent = String(words);

    for (const key of SEATS) {
      const seat = state.seats[key];
      const view = { ...seat, transcript: seat.transcript.slice(-LIVE_TRANSCRIPT_LINES) };
      const fingerprint = JSON.stringify(view);
      if (seat_fingerprints.get(key) === fingerprint) continue;
      seat_fingerprints.set(key, fingerprint);
      const panel = boardSeat(view, view.transcript.length);
      const previous = live_panels.get(key);
      if (previous) previous.replaceWith(panel);
      else ui.liveSeats.append(panel);
      live_panels.set(key, panel);
      const log = panel.querySelector('.transcript');
      if (log) log.scrollTop = log.scrollHeight;
    }
    renderStream();
  }

  function boardSeat(seat, transcriptLines) {
    const panel = node('section', 'board-seat' + (seat.pending ? ' board-seat--pending' : ''));
    panel.dataset.seat = seat.key;
    panel.setAttribute('aria-label', seat.name);
    const head = node('div', 'board-seat__head');
    const title = node('div', 'board-seat__title');
    title.append(node('span', 'seat__id', seat.key), node('span', 'seat__name', seat.name));
    const badges = node('div', 'board-seat__badges');
    badges.append(badge(seat.online ? 'Online' : 'Offline', seat.online ? 'on' : null));
    if (seat.online) badges.append(badge(roomStatus(seat), seat.transcription === 'live' ? 'live' : null));
    if (seat.mode) badges.append(badge(seat.mode === 1 ? '1 earbud' : '2 earbuds'));
    if (seat.drafts === false) badges.append(badge('Drafts off'));
    head.append(title, badges);
    panel.append(head);

    const situation = node('p', 'situation', seat.situation ?? 'no reading of this room yet');
    if (!seat.situation) situation.setAttribute('data-empty', '');
    panel.append(situation);

    if (seat.pending) {
      const pending = node('div', 'pending');
      pending.append(node('span', 'pending__tag mono',
        seat.pending.heardAt == null ? 'preview queued' : 'awaiting reply'));
      pending.append(node('span', null, describe(seat.pending, 'draft pending')));
      panel.append(pending);
    }

    const list = node('dl', 'readout');
    list.append(readoutRow('Last in', describe(seat.lastIn, 'nothing yet'), seat.lastIn ? 'ok' : 'wait'));
    list.append(readoutRow('Last out', describe(seat.lastOut, 'nothing yet'), seat.lastOut ? 'ok' : 'wait'));
    panel.append(list);

    panel.append(node('h3', 'eyebrow', 'Transcript'));
    panel.append(transcript(seat, transcriptLines));
    return panel;
  }

  function transcript(seat, limit) {
    const container = node('div', 'transcript');
    container.setAttribute('role', 'log');
    container.setAttribute('aria-label', seat.name + ' transcript');
    const lines = limit ? seat.transcript.slice(-limit) : seat.transcript;
    if (!lines.length) {
      container.append(node('p', 'empty mono', seat.transcription === 'live' ? 'Waiting for speech' : 'No transcript'));
      return container;
    }
    const base = timelineBase(state);
    for (const line of lines) {
      const row = node('div', 'transcript__line');
      const offset = offsetFrom(base, line.at);
      row.append(node('span', 'transcript__at mono', offset === null ? '—' : formatOffset(offset)));
      row.append(node('span', 'transcript__text', line.text));
      container.append(row);
    }
    return container;
  }

  function streamRow(entry, isNew) {
    const row = node('li', 'stream__row');
    if (entry.kind) row.dataset.kind = entry.kind;
    if (entry.seat) row.dataset.seat = entry.seat;
    if (entry.canned) row.setAttribute('data-canned', '');
    if (entry.urgent) row.setAttribute('data-urgent', '');
    if (isNew) row.setAttribute('data-new', '');
    const base = timelineBase(state);
    const offset = offsetFrom(base, entry.at);
    row.append(node('span', 'stream__at', offset === null ? '—' : formatOffset(offset)));
    row.append(node('span', 'stream__seat', entry.seat ?? '·'));
    row.append(node('span', 'stream__kind', KIND_LABELS[entry.kind] ?? entry.kind ?? 'event'));
    const text = [SIGNAL_LABELS[entry.signal] ?? entry.signal, entry.text, entry.latencyMs == null ? null : entry.latencyMs + ' ms after decision'].filter(Boolean).join(' · ');
    row.append(node('span', 'stream__text', text || (entry.to ? '→ ' + entry.to : '')));
    row.append(node('span', 'stream__bits', entry.bits === null ? '' : entry.bits + ' b'));
    return row;
  }

  function renderStream() {
    const entries = state.log.slice(-160);
    const keys = entries.map(entry => entry.key);
    const diverged = keys.length < streamKeys.length || streamKeys.some((key, index) => keys[index] !== key);
    ui.streamEmpty.hidden = keys.length > 0;
    stickToBottom(ui.stream, () => {
      if (diverged) {
        fill(ui.stream, entries.map(entry => streamRow(entry, false)));
      } else {
        for (const entry of entries.slice(streamKeys.length)) ui.stream.append(streamRow(entry, true));
      }
      while (ui.stream.children.length > 160) ui.stream.firstElementChild?.remove();
    });
    streamKeys = keys;
  }

  function renderReveal() {
    const fingerprint = JSON.stringify([state.hubId, state.sessionId, state.bits, state.startedAt,
      state.preset, state.canned, state.log, SEATS.map(key => [state.seats[key].name, state.seats[key].transcript])]);
    if (fingerprint === revealFingerprint) return;
    revealFingerprint = fingerprint;
    const rows = timelineRows(state);
    const { messages, words, playbackStarts, playbackWords } = revealSummary(state);
    const base = timelineBase(state);
    const times = state.log.map(entry => entry.at).filter(Number.isFinite);
    const span = base !== null && times.length ? Math.max(...times) - base : null;
    const view = {
      bits: state.bits === null ? '—' : String(Math.round(state.bits * 100) / 100),
      words: state.canned ? words : playbackWords,
      wordLabel: state.canned ? 'scripted words' : 'words in confirmed cues',
      count: !messages ? 'No cues sent' : state.canned
        ? messages + (messages === 1 ? ' scripted cue' : ' scripted cues')
        : playbackStarts + ' of ' + messages + ' cues confirmed',
      kicker: ['Reveal', state.preset, span ? formatOffset(span) : null].filter(Boolean).join(' · '),
    };
    if (ui.revealHead?.dataset.revealOwner === 'react') {
      ui.revealHead.dispatchEvent(new CustomEvent('telepathy:reveal', { detail: view }));
    } else {
      ui.revealBits.textContent = view.bits;
      ui.revealWords.textContent = String(view.words);
      ui.revealWordLabel.textContent = view.wordLabel;
      ui.revealCount.textContent = view.count;
      ui.revealKicker.textContent = view.kicker;
    }
    if (ui.revealNote) {
      ui.revealNote.textContent = messages
        ? state.canned ? 'Recorded take' : messages + ' sent · ' + playbackStarts + ' playback confirmed'
        : '';
    }
    ui.timelineEmpty.hidden = rows.length > 0;
    renderLanes();

    fill(ui.timeline, rows.map(row => {
      const item = node('li', 'timeline__row');
      if (row.canned) item.setAttribute('data-canned', '');
      if (row.urgent) item.setAttribute('data-urgent', '');
      if (row.seat) item.dataset.seat = row.seat;
      item.append(node('span', 'timeline__at', row.offsetLabel));
      item.append(node('span', 'timeline__signal', SIGNAL_LABELS[row.signal] ?? row.signal ?? KIND_LABELS[row.kind] ?? 'event'));
      const route = node('span', 'timeline__route');
      if (row.seat) {
        const from = node('b', null, row.seat);
        from.dataset.seat = row.seat;
        route.append(from, row.to ? ' → ' + row.to : '');
      } else route.textContent = 'Hub';
      item.append(route);
      const text = node('span', 'timeline__text');
      text.append(node('span', null, row.text ?? SIGNAL_LABELS[row.signal] ?? row.signal ?? KIND_LABELS[row.kind] ?? 'event'));
      const meta = row.canned ? 'canned take'
        : row.kind === 'message' && row.playedAt == null ? 'playback unconfirmed' : null;
      if (meta) text.append(node('span', 'timeline__meta', meta));
      item.append(text);
      const bits = node('span', 'timeline__bits');
      if (row.bits !== null) {
        const filled = Math.max(0, Math.min(4, Math.round(row.bits)));
        for (let index = 0; index < filled; index += 1) bits.append(node('i'));
        bits.append(node('b', null, String(Math.round(row.bits * 100) / 100)));
        bits.setAttribute('aria-label', row.bits + ' bits');
      }
      item.append(bits);
      return item;
    }));

    fill(ui.transcripts, SEATS.map(key => {
      const seat = state.seats[key];
      const heard = state.log.filter(entry => entry.kind === 'message' && entry.to === key && (entry.canned || entry.playedAt != null));
      const column = node('div');
      const head = node('h2', 'section-title');
      const name = node('span', 'section-title__name', seat.name);
      const lines = seat.transcript.length + (seat.transcript.length === 1 ? ' line' : ' lines');
      const delivery = state.canned ? ' scripted' : ' playback confirmed';
      head.append(name, node('span', null, heard.length ? lines + ' · ' + heard.length + delivery : lines));
      column.append(head, revealTranscript(seat, heard));
      return column;
    }));
  }

  function revealTranscript(seat, heard) {
    const container = node('div', 'transcript');
    container.setAttribute('role', 'log');
    container.setAttribute('aria-label', seat.name + ' transcript');
    const base = timelineBase(state);
    const entries = [
      ...seat.transcript.map(line => ({ at: line.at, line })),
      ...heard.map(message => ({ at: message.playedAt ?? message.at, message })),
    ].sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    if (!entries.length) {
      container.append(node('p', 'empty', 'No transcript'));
      return container;
    }
    for (const entry of entries) {
      const row = node('div', 'transcript__line');
      const offset = offsetFrom(base, entry.at);
      row.append(node('span', 'transcript__at', offset === null ? '—' : formatOffset(offset)));
      if (entry.line) {
        row.append(node('span', 'transcript__text', entry.line.text));
      } else {
        row.classList.add('transcript__line--heard');
        if (entry.message.seat) row.dataset.from = entry.message.seat;
        const text = node('span', 'transcript__text', entry.message.canned ? 'Scripted cue ' : 'Playback ');
        text.append(node('b', null, '“' + (entry.message.text ?? entry.message.signal ?? 'a message') + '”'));
        row.append(text);
      }
      container.append(row);
    }
    return container;
  }

  function renderLanes() {
    if (!ui.revealLanes) return;
    const section = ui.revealLanes.closest('section');
    const base = timelineBase(state);
    const marks = [];
    for (const key of SEATS) {
      for (const line of state.seats[key].transcript) {
        if (Number.isFinite(line.at)) marks.push({ lane: key, type: 'speech', at: line.at, end: line.at + speechSpanMs(line.text) });
      }
    }
    for (const entry of state.log) {
      if (!Number.isFinite(entry.at) || !SEATS.includes(entry.seat)) continue;
      if (entry.kind === 'message') {
        marks.push({ lane: entry.seat, type: 'tap', at: entry.at, label: entry.signal, seat: entry.seat, urgent: entry.urgent });
        if (SEATS.includes(entry.to) && (entry.canned || entry.playedAt != null)) {
          marks.push({ lane: entry.to, type: 'heard', at: entry.playedAt ?? entry.at, seat: entry.seat, urgent: entry.urgent });
        }
      } else if (entry.kind === 'receipt') {
        marks.push({ lane: entry.seat, type: 'receipt', at: entry.at, seat: entry.seat });
      } else if (entry.kind === 'draft') {
        marks.push({ lane: entry.seat, type: 'draft', at: entry.at, seat: entry.seat });
      }
    }
    if (section) section.hidden = base === null || !marks.length;
    if (base === null || !marks.length) return;
    // Start the lanes just before the first event so idle setup time does not squash the exchange.
    const first = Math.min(...marks.map(mark => mark.at));
    const start = Math.max(base, first - 1500);
    const span = Math.max(1000, Math.max(...marks.map(mark => mark.end ?? mark.at)) - start);
    const ratio = at => Math.min(1, Math.max(0, (at - start) / span)) * 100;

    const axis = node('div', 'lanes__axis');
    axis.append(node('span'));
    const ticks = node('div', 'lanes__ticks');
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(seconds => span / 1000 / seconds <= 6) ?? 1200;
    const offset = (start - base) / 1000;
    for (let seconds = Math.ceil(offset / step) * step; (seconds - offset) * 1000 <= span; seconds += step) {
      const tick = node('span', null, seconds < 60 ? seconds + 's' : formatOffset(seconds * 1000));
      tick.style.left = (((seconds - offset) * 1000) / span * 100).toFixed(2) + '%';
      ticks.append(tick);
    }
    axis.append(ticks);

    const lanes = ['B', 'A'].map(key => {
      const lane = node('div', 'lane');
      lane.dataset.seat = key;
      const who = node('div', 'lane__who');
      who.append(node('span', 'lane__id', key), node('span', null, state.seats[key].name));
      const track = node('div', 'lane__track');
      track.setAttribute('aria-hidden', 'true');
      for (const mark of marks.filter(item => item.lane === key)) {
        const element = node('i', 'mark mark--' + mark.type);
        if (mark.seat) element.classList.add(mark.seat === 'A' ? 'seat-a' : 'seat-b');
        if (mark.urgent) element.classList.add('mark--urgent');
        element.style.left = ratio(mark.at).toFixed(2) + '%';
        if (mark.type === 'speech') element.style.width = Math.max(0.4, ratio(mark.end) - ratio(mark.at)).toFixed(2) + '%';
        if (mark.type === 'tap' && mark.label) element.append(node('span', null, mark.label));
        track.append(element);
      }
      lane.append(who, track);
      return lane;
    });

    const legend = node('div', 'lanes__legend');
    for (const [type, label] of [['speech', 'Speaking'], ['tap', 'Tap sent'], ['heard', 'Whisper playback'], ['receipt', 'Receipt'], ['draft', 'Agent draft']]) {
      const item = node('span');
      item.append(node('i', 'mark mark--' + type), label);
      legend.append(item);
    }
    fill(ui.revealLanes, [axis, ...lanes, legend]);
  }

  function renderOperator() {
    for (const option of ui.opSignal.options) {
      const meaning = state.codebook[option.value];
      const label = SIGNAL_LABELS[option.value] + (meaning ? ' · ' + meaning : ' · ' + (SIGNAL_ROLES[option.value] ?? 'signal'));
      if (option.textContent !== label) option.textContent = label;
    }
    const blocked = state.canBegin === false;
    ui.opBegin.disabled = false;
    ui.opBegin.title = blocked ? 'Seats are not all ready. The hub may refuse.' : '';
    renderPitchCoach();
    renderAnnouncement();
  }

  function renderPitchCoach() {
    const view = pitchCoachView(state, linkState === 'live', ui.opCoachBeat.value);
    ui.opCoach.hidden = !view;
    if (!view) return;
    ui.opCoachBeat.disabled = !view.canAsk;
    ui.opCoachAsk.disabled = !view.canAsk;
    ui.opCoachDraft.hidden = !view.draft;
    ui.opCoachSend.disabled = !view.canSend;
    const text = view.draft ? state.coach.text : '';
    const reason = view.draft ? state.coach.reason ?? '' : '';
    if (ui.opCoachText.textContent !== text) ui.opCoachText.textContent = text;
    if (ui.opCoachReason.textContent !== reason) ui.opCoachReason.textContent = reason;
    ui.opCoachReason.hidden = !reason;
    if (ui.opCoachStatus.textContent !== view.note) ui.opCoachStatus.textContent = view.note;
  }

  function renderAnnouncement() {
    const view = announcementView(state, linkState === 'live', ui.opAnnounceText.value);
    if (ui.opAnnounce.dataset.announceOwner === 'react') {
      const key = JSON.stringify(view);
      if (key !== announcementRenderKey) {
        announcementRenderKey = key;
        ui.opAnnounce.dispatchEvent(new CustomEvent('telepathy:announcement', { detail: view }));
      }
      return;
    }
    ui.opAnnounceText.readOnly = view.rehearsal;
    ui.opAnnounceSend.disabled = !view.canSend;
    ui.opAnnounceSend.textContent = view.action;
    const note = view.receipt?.summary ?? view.note;
    if (ui.opAnnounceStatus.textContent !== note) ui.opAnnounceStatus.textContent = note;
  }

  function render() {
    const view = { lobby: renderLobby, live: renderLive, reveal: renderReveal };
    const steps = [
      ['chrome', renderChrome], ['operator', renderOperator], ['references', renderReferences], ['room microphone', renderRoomMicrophone],
      [state.phase, view[state.phase]],
    ];
    for (const [name, step] of steps) {
      try { step(); } catch (error) { console.error('stage render failed: ' + name, error); }
    }
  }

  function schedule() {
    if (renderHandle) return;
    renderHandle = 1;
    queueMicrotask(() => { renderHandle = 0; render(); });
  }

  /* operator actions */

  function status(message, tone) {
    ui.opStatus.textContent = message;
    if (tone) ui.opStatus.dataset.tone = tone;
    else delete ui.opStatus.dataset.tone;
  }

  function send(action, options) {
    const frame = operatorFrame(action, options);
    if (!frame) {
      status('nothing sent: ' + action + ' is missing a value', 'blocked');
      return false;
    }
    if (!socket || socket.readyState !== 1) {
      status('not sent: the hub is ' + (linkState === 'connecting' ? 'still connecting' : 'offline'), 'blocked');
      return false;
    }
    try {
      socket.send(JSON.stringify({ ...frame, hubId: state.hubId ?? undefined, sessionId: state.sessionId ?? undefined }));
    } catch (error) {
      status('not sent: ' + (error?.message ?? 'socket error'), 'blocked');
      return false;
    }
    const detail = frame.preset ? ' ' + frame.preset : frame.signal ? ' ' + frame.seat + ' ' + SIGNAL_LABELS[frame.signal] : '';
    const action_status = frame.action === 'coach_ask' ? 'Asked the pitch coach.'
      : frame.action === 'coach_send' ? 'Approved the cue.'
      : frame.action === 'announce' ? 'Announcement requested.' : null;
    status(action_status ?? 'Sent ' + frame.action + detail, 'sent');
    return true;
  }

  function disarmReset() {
    clearTimeout(resetTimer);
    resetArmed = 0;
    ui.opReset.removeAttribute('data-armed');
    ui.opReset.textContent = 'Reset';
    ui.opResetNote.textContent = '';
  }

  function armReset() {
    resetArmed = 1;
    ui.opReset.setAttribute('data-armed', '');
    ui.opReset.textContent = 'Confirm reset';
    ui.opResetNote.textContent = 'press again within 5 s';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(disarmReset, 5000);
  }

  function setOperator(open) {
    if (open === !ui.operator.hidden) return;
    if (open) lastFocus = document.activeElement;
    ui.operator.hidden = !open;
    body.toggleAttribute('data-operator-open', open);
    ui.opToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const pitch_coach = !ui.opCoach.hidden && !ui.opCoachBeat.disabled;
      (pitch_coach ? ui.opCoachBeat : state.phase === 'live' ? ui.opAnnouncePreset : ui.opBegin).focus();
      return;
    }
    disarmReset();
    // never leave focus inside the panel we just hid
    const restorable = lastFocus && lastFocus !== document.body && document.contains(lastFocus)
      && !ui.operator.contains(lastFocus) && typeof lastFocus.focus === 'function';
    (restorable ? lastFocus : ui.opToggle).focus();
  }

  function wireOperator() {
    fill(ui.opSignal, [...FIXED_SIGNALS].map(signal => {
      const option = document.createElement('option');
      option.value = signal;
      option.textContent = SIGNAL_LABELS[signal] + ' · ' + (SIGNAL_ROLES[signal] ?? 'signal');
      return option;
    }));
    for (const { id, label } of OPERATOR_ANNOUNCEMENTS) {
      const option = node('option', null, label);
      option.value = id;
      ui.opAnnouncePreset.append(option);
    }
    ui.opAnnouncePreset.addEventListener('change', () => {
      ui.opAnnounceText.value = OPERATOR_ANNOUNCEMENTS.find(line => line.id === ui.opAnnouncePreset.value)?.text ?? '';
      renderAnnouncement();
    });
    ui.opAnnounceText.addEventListener('input', renderAnnouncement);
    ui.opAnnounce.addEventListener('submit', event => {
      event.preventDefault();
      if (!announcementView(state, linkState === 'live', ui.opAnnounceText.value).canSend) return;
      send('announce', { text: ui.opAnnounceText.value });
    });
    ui.opCoachBeat.addEventListener('change', renderPitchCoach);
    ui.opCoachForm.addEventListener('submit', event => {
      event.preventDefault();
      if (ui.opCoachAsk.disabled) return;
      send('coach_ask', { beat: ui.opCoachBeat.value });
    });
    ui.opCoachSend.addEventListener('click', () => {
      if (ui.opCoachSend.disabled) return;
      send('coach_send', { coachId: state.coach.id });
    });

    ui.opToggle.addEventListener('click', () => setOperator(ui.operator.hidden));
    ui.opClose.addEventListener('click', () => setOperator(false));
    for (const id of ['op-begin', 'op-reveal', 'op-replay', 'op-canned']) {
      const button = byId(id);
      button?.addEventListener('click', () => {
        if (button.dataset.action === 'canned') {
          canned_audio.clear_session();
          void canned_audio.unlock();
          void canned_audio.preload_cues();
        }
        send(button.dataset.action);
      });
    }
    byId('op-set-preset').addEventListener('click', () => {
      send('preset', { preset: ui.opPreset.value, context: ui.opContext.value });
    });
    byId('op-inject').addEventListener('click', () => {
      send('inject', { seat: ui.opSeat.value, signal: ui.opSignal.value });
    });
    ui.opReset.addEventListener('click', () => {
      if (!resetArmed) { armReset(); status('reset armed, press confirm', 'blocked'); return; }
      disarmReset();
      send('reset');
    });

    ui.begin.addEventListener('click', () => send('begin'));
    byId('reference-upload').addEventListener('click', () => void uploadReferences());
    byId('reference-clear').addEventListener('click', () => void uploadReferences(true));
    if (reactRoom) {
      document.addEventListener('telepathy:room-action', event => {
        const { action, speaker, seat } = event.detail ?? {};
        if (action === 'start') void startRoomCapture();
        else if (action === 'stop') { roomMessage = ''; stopRoomCapture(); }
        else if (action === 'clear') sendRoomFrame({ type: 'operator', action: 'room_transcript_clear' });
        else if (action === 'assign' && typeof speaker === 'string' && ['', 'A', 'B'].includes(seat)) {
          sendRoomFrame({ type: 'operator', action: 'room_speaker_assign', stream: state.room.speakerStream, speaker, seat: seat || null });
        }
      });
    } else {
      byId('room-transcript-clear').addEventListener('click', () => sendRoomFrame({ type: 'operator', action: 'room_transcript_clear' }));
      byId('room-mic-start').addEventListener('click', () => void startRoomCapture());
      byId('room-mic-stop').addEventListener('click', () => { roomMessage = ''; stopRoomCapture(); });
    }
    ui.reveal.addEventListener('click', () => send('reveal'));

    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && !ui.operator.hidden) { setOperator(false); return; }
      const target = event.target;
      const tag = target?.tagName;
      if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === 'o' || event.key === 'O') { setOperator(ui.operator.hidden); event.preventDefault(); }
    });
  }

  /* hub link */

  function setLink(next) {
    linkState = next;
    schedule();
  }

  function applyInfo(next) {
    info = isObject(next) ? next : null;
    const joinUrl = firstText(info?.joinUrl) ?? location.origin;
    const local_only = info?.lanAvailable === false;
    ui.joinUrl.textContent = local_only ? 'No hotspot address' : joinUrl.replace(/\/$/, '');
    if (ui.diaHost) {
      let host = null;
      try { host = new URL(joinUrl).hostname; } catch { /* a hand-typed address has no host to show */ }
      ui.diaHost.textContent = local_only || !host ? 'HOTSPOT' : 'HOTSPOT · ' + host;
    }
    ui.stageUrl.textContent = firstText(info?.stageUrl) ?? location.href.split('?')[0];
    const secure = asBool(info?.secure);
    const loopback = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(joinUrl);
    ui.secure.textContent = local_only ? 'local rehearsal' : secure === true ? 'secure origin'
      : loopback ? 'local rehearsal' : secure === false ? 'insecure origin' : location.protocol.replace(':', '');
    const certificate = local_only ? null : firstText(info?.certificateUrl);
    if (ui.certificateRow) {
      ui.certificateRow.hidden = !certificate;
      ui.certificate.textContent = certificate ?? '';
    }
    const guidance = local_only ? 'Connect the MacBook and phones to the same hotspot, then restart the hub.'
      : certificate
      ? 'First use: install and trust the hub’s CA on each phone before opening the HTTPS address.'
      : joinGuidance(info);
    ui.guidance.hidden = !guidance;
    if (guidance) {
      ui.guidance.textContent = guidance;
      if (certificate) {
        const link = node('a', null, ' Download hub certificate');
        link.href = certificate;
        ui.guidance.append(link);
      }
    }
  }

  async function loadInfo() {
    try {
      const response = await fetch('/info', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      applyInfo(await response.json());
    } catch { /* the stage still works from the current origin */ }
  }

  function handleFrame(frame) {
    if (!isObject(frame)) return;
    if (frame.type === 'monitor') {
      if ((state.hubId == null || frame.hubId === state.hubId)
        && (state.sessionId == null || frame.sessionId === state.sessionId)) channelMonitors[state.phase]?.update(frame.monitor);
      return;
    }
    if (frame.type === 'audio' && state.canned && frame.url
      && (frame.hubId == null || frame.hubId === state.hubId)
      && (frame.sessionId == null || frame.sessionId === state.sessionId)) {
      canned_audio.play({ ...frame, key: undefined });
      return;
    }
    if (frame.type === 'state') {
      const next = normalizeState(isObject(frame.state) ? frame.state : frame);
      if (next.hubId !== state.hubId || next.sessionId !== state.sessionId || next.phase === 'reveal' || next.canned
          || roomAccepted && !next.room.listeningRequested) stopRoomCapture(false);
      if (state.canned && (!next.canned || next.hubId !== state.hubId || next.sessionId !== state.sessionId
        || next.startedAt !== state.startedAt)) canned_audio.clear_session();
      if (next.hubId !== state.hubId || next.sessionId !== state.sessionId) {
        for (const monitor of Object.values(channelMonitors)) monitor?.update(null);
        referenceMessage = '';
        byId('reference-files').value = '';
        streamKeys = [];
        ui.stream.replaceChildren();
        seat_fingerprints.clear();
        ui.opCoachBeat.value = next.coach?.beat ?? PITCH_BEATS[0];
      }
      state = next;
      schedule();
      return;
    }
    if (frame.type === 'operator_ack' && !frame.accepted) {
      if (frame.action === 'room_listen') {
        roomMessage = frame.reason === 'microphone_owned' ? 'Another stage tab is using the room microphone.' : 'The session changed. Start the microphone again.';
        stopRoomCapture(false);
        return;
      }
      status('The take changed. Check the stage and try again.', 'blocked');
      return;
    }
    if (frame.type === 'room_ack' && frame.sessionId === state.sessionId && frame.hubId === state.hubId) {
      roomAccepted = frame.listening === true && roomWanted;
      if (!frame.listening && roomWanted) {
        roomMessage = 'Transcription unavailable. Check the ElevenLabs key and quota, then try again.';
        stopRoomCapture(false);
      }
      schedule();
      return;
    }
    const detail = firstText(frame.error, frame.detail, frame.message);
    if (detail) status((firstText(frame.type) ?? 'hub') + ': ' + detail, 'blocked');
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let next;
    try {
      next = new WebSocket(scheme + '//' + location.host + '/ws?role=stage');
    } catch {
      setLink('offline');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      return;
    }
    socket = next;
    setLink('connecting');
    next.addEventListener('open', () => {
      if (socket !== next) return;
      reconnectDelay = 600;
      setLink('live');
    });
    next.addEventListener('message', event => {
      if (socket !== next) return;
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      handleFrame(frame);
    });
    next.addEventListener('close', () => {
      if (socket !== next) return;
      stopRoomCapture(false);
      setLink('offline');
      reconnectDelay = Math.min(8000, Math.round(reconnectDelay * 1.6));
      reconnectTimer = setTimeout(connect, reconnectDelay);
    });
    next.addEventListener('error', () => { if (socket === next) setLink('offline'); });
  }

  wireOperator();
  applyInfo(null);
  render();
  loadInfo();
  void refreshMicrophones();
  connect();
  clockTimer = setInterval(() => { if (!ui.clock.hidden) tickClock(); }, 1000);
  window.addEventListener('beforeunload', () => {
    stopRoomCapture();
    void roomContext?.close();
    clearInterval(clockTimer);
    clearTimeout(reconnectTimer);
    socket = null;
  });
}

if (typeof document !== 'undefined' && document.querySelector('[data-stage-root]')) boot();
