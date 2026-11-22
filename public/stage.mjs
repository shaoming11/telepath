/*
 * Telepathy stage screen: lobby, live board, reveal, plus hidden operator controls.
 * The stage is a view of the hub. It renders state and sends operator frames.
 * The operator's canned take can play bundled ElevenLabs clips.
 */

import { createAudioEngine } from './phone-audio.mjs';
import { APP_TIMING } from './phone-data.mjs';
import { announcementText, OPERATOR_ANNOUNCEMENTS } from './announcements.mjs';

export const SEATS = Object.freeze(['A', 'B']);
export const PHASES = Object.freeze(['lobby', 'live', 'reveal']);
export const SIGNALS = Object.freeze(['R1', 'R2', 'L1', 'L2', 'LR', 'OUT', 'BACK']);
export const PRESETS = Object.freeze(['Pitch', 'Party', 'Meeting', 'Custom']);
const FIXED_SIGNALS = new Set(['R1', 'R2', 'L1', 'OUT']);
const LIVE_TRANSCRIPT_LINES = 12;
export const OPERATOR_ACTIONS = Object.freeze(['begin', 'preset', 'inject', 'replay', 'canned', 'reset', 'reveal', 'announce']);

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

export function revealSummary(state) {
  const messages = state.log.filter(entry => entry.kind === 'message');
  const words = messages.reduce((sum, entry) =>
    sum + (entry.text?.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0), 0);
  return { messages: messages.length, words, playbackStarts: messages.filter(entry => entry.playedAt != null).length };
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

/* ── DOM ────────────────────────────────────────────── */

function boot() {
  const byId = id => document.getElementById(id);
  const body = document.body;

  const ui = {
    session: byId('session-readout'), linkDot: byId('link-dot'), link: byId('link-readout'),
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
    revealKicker: byId('reveal-kicker'), liveMessages: byId('live-messages'), liveWords: byId('live-words'),
    readout: { A: byId('readout-a'), B: byId('readout-b'), An: byId('readout-a-name'), Bn: byId('readout-b-name'),
      preset: byId('readout-preset'), cache: byId('readout-cache') },
    diagram: byId('lobby-diagram'), diaHost: byId('dia-host'), diaAgent: byId('dia-agent'),
    timeline: byId('timeline-list'), timelineEmpty: byId('timeline-empty'), transcripts: byId('reveal-transcripts'),
    announce: byId('phase-announce'),
    operator: byId('operator'), opToggle: byId('op-toggle'), opClose: byId('op-close'), opStatus: byId('op-status'),
    opPreset: byId('op-preset'), opContext: byId('op-context'), opSeat: byId('op-seat'), opSignal: byId('op-signal'),
    opAnnounce: byId('op-announce'), opAnnouncePreset: byId('op-announce-preset'), opAnnounceText: byId('op-announce-text'),
    opAnnounceSend: byId('op-announce-send'), opAnnounceStatus: byId('op-announce-status'),
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
  const seat_fingerprints = new Map();
  const live_panels = new Map();
  let lastFocus = null;

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
    if (event.signal) parts.push(event.signal);
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
      lastPhase = state.phase;
      ui.announce.textContent = 'Stage phase: ' + state.phase;
      const active = ui.screens[state.phase];
      if (active) active.scrollTop = 0;
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
    const seats = SEATS.map(key => state.seats[key]).filter(seat => seat.online);
    const listening = seats.some(seat => seat.transcription === 'live');
    const rehearsal = seats.length > 0 && seats.every(seat => seat.sim);
    const drafting = seats.some(seat => seat.drafts !== false);
    if (ui.diaAgent) {
      ui.diaAgent.textContent = 'AGENT · ' + (listening ? (drafting ? 'LISTENING, DRAFTS ON' : 'LISTENING')
        : rehearsal ? 'REHEARSAL' : 'STANDING BY');
    }
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
      ? entries.map(([signal, meaning]) => readoutRow(signal, meaning))
      : [readoutRow('—', 'the hub has not published a codebook yet', 'wait')]);

    const blocked = state.canBegin === false;
    ui.begin.disabled = blocked;
    ui.beginHint.textContent = blocked
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
    const text = [entry.signal, entry.text, entry.latencyMs == null ? null : entry.latencyMs + ' ms after decision'].filter(Boolean).join(' · ');
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
    ui.revealBits.textContent = state.bits === null ? '—' : String(Math.round(state.bits * 100) / 100);
    const rows = timelineRows(state);
    const { messages, words, playbackStarts } = revealSummary(state);
    if (ui.revealWords) ui.revealWords.textContent = String(words);
    ui.revealCount.textContent = messages
      ? messages + (messages === 1 ? ' message' : ' messages') + ' · ' + words + (words === 1 ? ' word' : ' words')
      : rows.length + ' events';
    if (!state.canned && messages && playbackStarts < messages) {
      ui.revealCount.textContent += ' · ' + playbackStarts + ' playback confirmed';
    }
    if (ui.revealNote) {
      ui.revealNote.textContent = messages
        ? messages + ' sent · ' + (state.canned ? messages : playbackStarts) + ' heard'
        : '';
    }
    if (ui.revealKicker) {
      const base = timelineBase(state);
      const times = state.log.map(entry => entry.at).filter(Number.isFinite);
      const span = base !== null && times.length ? Math.max(...times) - base : null;
      ui.revealKicker.textContent = ['Reveal', state.preset, span ? formatOffset(span) : null].filter(Boolean).join(' · ');
    }
    ui.timelineEmpty.hidden = rows.length > 0;
    renderLanes();

    fill(ui.timeline, rows.map(row => {
      const item = node('li', 'timeline__row');
      if (row.canned) item.setAttribute('data-canned', '');
      if (row.urgent) item.setAttribute('data-urgent', '');
      if (row.seat) item.dataset.seat = row.seat;
      item.append(node('span', 'timeline__at', row.offsetLabel));
      item.append(node('span', 'timeline__signal', row.signal ?? KIND_LABELS[row.kind] ?? 'event'));
      const route = node('span', 'timeline__route');
      if (row.seat) {
        const from = node('b', null, row.seat);
        from.dataset.seat = row.seat;
        route.append(from, row.to ? ' → ' + row.to : '');
      } else route.textContent = 'Hub';
      item.append(route);
      const text = node('span', 'timeline__text');
      text.append(node('span', null, row.text ?? row.signal ?? (KIND_LABELS[row.kind] ?? 'event')));
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
      const heard = state.log.filter(entry => entry.kind === 'message' && entry.to === key);
      const column = node('div');
      const head = node('h2', 'section-title');
      const name = node('span', 'section-title__name', seat.name);
      const lines = seat.transcript.length + (seat.transcript.length === 1 ? ' line' : ' lines');
      head.append(name, node('span', null, heard.length ? lines + ' · ' + heard.length + ' heard' : lines));
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
        const text = node('span', 'transcript__text', 'Heard ');
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
        if (SEATS.includes(entry.to)) {
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
    for (const [type, label] of [['speech', 'Speaking'], ['tap', 'Tap sent'], ['heard', 'Whisper heard'], ['receipt', 'Receipt'], ['draft', 'Agent draft']]) {
      const item = node('span');
      item.append(node('i', 'mark mark--' + type), label);
      legend.append(item);
    }
    fill(ui.revealLanes, [axis, ...lanes, legend]);
  }

  function renderOperator() {
    for (const option of ui.opSignal.options) {
      const meaning = state.codebook[option.value];
      const label = option.value + (meaning ? ' · ' + meaning : ' · ' + (SIGNAL_ROLES[option.value] ?? 'signal'));
      if (option.textContent !== label) option.textContent = label;
    }
    const blocked = state.canBegin === false;
    ui.opBegin.disabled = false;
    ui.opBegin.title = blocked ? 'Seats are not all ready. The hub may refuse.' : '';
    renderAnnouncement();
  }

  function renderAnnouncement() {
    const text = announcementText(ui.opAnnounceText.value);
    const connected = SEATS.filter(seat => state.seats[seat].online);
    const rehearsal = connected.length > 0 && connected.every(seat => state.seats[seat].sim);
    const known = OPERATOR_ANNOUNCEMENTS.some(line => line.text === text);
    const progress = state.announcement;
    const busy = progress?.status === 'building' || progress?.status === 'queued';
    const presentation = state.canned || state.phase === 'reveal';
    ui.opAnnounceText.readOnly = rehearsal;
    ui.opAnnounceSend.disabled = !text || !connected.length || busy || presentation || rehearsal && !known;
    let note = presentation ? 'Available before the reveal.' : connected.length
      ? (rehearsal ? 'Rehearsal uses the preset lines. ' : '') + (connected.length === 2 ? 'Both seats online.' : 'Only Seat ' + connected[0] + ' is online.')
      : 'Waiting for a seat to connect.';
    if (!presentation && progress && (busy || progress.text === text)) note = announcementNote(progress) ?? note;
    if (ui.opAnnounceStatus.textContent !== note) ui.opAnnounceStatus.textContent = note;
  }

  function render() {
    const view = { lobby: renderLobby, live: renderLive, reveal: renderReveal };
    const steps = [
      ['chrome', renderChrome], ['operator', renderOperator],
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
    const detail = frame.preset ? ' ' + frame.preset : frame.signal ? ' ' + frame.seat + ' ' + frame.signal : '';
    status('Sent ' + frame.action + detail, 'sent');
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
      (state.phase === 'live' ? ui.opAnnouncePreset : ui.opBegin).focus();
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
      option.textContent = signal + ' · ' + (SIGNAL_ROLES[signal] ?? 'signal');
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
      if (ui.opAnnounceSend.disabled) return;
      send('announce', { text: ui.opAnnounceText.value });
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
    if (frame.type === 'audio' && state.canned && frame.url
      && (frame.hubId == null || frame.hubId === state.hubId)
      && (frame.sessionId == null || frame.sessionId === state.sessionId)) {
      canned_audio.play({ ...frame, key: undefined });
      return;
    }
    if (frame.type === 'state') {
      const next = normalizeState(isObject(frame.state) ? frame.state : frame);
      if (state.canned && (!next.canned || next.hubId !== state.hubId || next.sessionId !== state.sessionId
        || next.startedAt !== state.startedAt)) canned_audio.clear_session();
      if (next.hubId !== state.hubId || next.sessionId !== state.sessionId) {
        streamKeys = [];
        ui.stream.replaceChildren();
        seat_fingerprints.clear();
      }
      state = next;
      schedule();
      return;
    }
    if (frame.type === 'operator_ack' && !frame.accepted) {
      status('The take changed. Check the stage and try again.', 'blocked');
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
  connect();
  clockTimer = setInterval(() => { if (!ui.clock.hidden) tickClock(); }, 1000);
  window.addEventListener('beforeunload', () => {
    clearInterval(clockTimer);
    clearTimeout(reconnectTimer);
    socket = null;
  });
}

if (typeof document !== 'undefined' && document.querySelector('[data-stage-root]')) boot();
