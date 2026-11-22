import { createEmulator, createMediaInput, DEFAULT_EMULATOR, DEFAULT_TIMING, touchSettings } from './input.mjs';
import { createNetworkLink, DEFAULT_NETWORK } from './network.mjs';
import { createCapture } from './capture.mjs';
import { createCalibration } from './calibrate.mjs';
import { createAudioEngine, createDraftTracker } from './phone-audio.mjs';
import { mountChannelMonitor } from './channel-monitor.mjs';
import { diag, installDiag, registerExtraActions } from './diag.mjs';
import { AIRPODS_1_PLAYBACK_URL } from './earbuds/airpods-1/input.mjs';
import {
  APP_TIMING, APP_TIMING_LIMITS, CONSENT_KEY, CONSENT_TEXT, DEFAULT_VOLUMES, PATTERN_LABELS, PRESETS,
  SEAT_NAMES, SIGNAL_LABELS, SIGNAL_ORDER, STORAGE_KEY, SYSTEM_MEANINGS, VOICE_CONSENT_TEXT, VOICE_SCRIPT,
} from './phone-data.mjs';

const QUERY = new URLSearchParams(location.search);
const DIRECT_CALIBRATION = QUERY.get('calibrate') === '1';
const RAW_KEYS = Object.freeze({ r: 'nexttrack', l: 'previoustrack', o: 'pause', i: 'play' });
const CLICKER_KEYS = Object.freeze({ PageDown: 'R1', PageUp: 'R2', '1': 'R1', '2': 'R2', '3': 'L1' });
const SETUP_ORDER = Object.freeze(['voice', 'earbuds', 'calibrate', 'preset']);
const SUB_SCREENS = new Set(['codebook', 'log', 'settings']);
const USABLE_VOICES = new Set(['ready', 'fallback']);
const LOG_KINDS = new Set(['message', 'receipt', 'back', 'draft', 'confirm', 'discard', 'preset']);
const ISSUE_ORDER = Object.freeze(['connection', 'secure', 'mic', 'media', 'context', 'cache', 'cues', 'playback', 'voice']);
const PHASE_LABELS = Object.freeze({ lobby: 'Waiting for stage', live: 'Live', reveal: 'Reveal' });
const NOTE_MS = 4200;
const PITCH_PREPARING_NOTE = 'Preparing a private pitch cue…';
const CLONE_RESPONSE_MS = 65_000;
const PERSONAL_TIMING_KEY = 'telepathy.airpods1-timing.v2';
const PROBE_FAILURES_TO_RECONNECT = 2;
const SOCKET_OPEN = 1;
const SOCKET_MOVED = 4001;
const SCOPED_FRAMES = new Set([
  'signal', 'heard', 'cache_ready', 'voice', 'voice_preview', 'room_mic_invite', 'mic', 'setup', 'listen', 'configure', 'preset', 'calibration', 'sim_transcript',
  'audio_monitor',
]);

const $ = id => document.getElementById(id);
const fresh_setup = () => ({ voice: false, voice_kind: null, earbuds: false, calibrated: false, ready: false });

let persisted_input = 'real';
try {
  sessionStorage.removeItem('telepathy.phone.v1');
  sessionStorage.removeItem('telepathy.phone.consent.v1');
  localStorage.removeItem('telepathy.airpods1-timing.v1');
} catch {}
const settings = load_settings();
const ui = {
  seat: null,
  screen: 'join',
  state: null,
  issues: new Map(),
  note: '',
  note_timer: null,
  armed: false,
  earbud_out: false,
  connection_state: 'off',
  hub_reachable: null,
  hub_info: null,
  probe_failures: 0,
  reconnect_delay: settings.app.reconnectMinMs,
  reconnect_timer: null,
  listen_wanted: false,
  mic_on_next_take: false,
  mic_after_calibration: false,
  calibration_playback: false,
  lock_controls: false,
  mic_after_lock_controls: false,
  voice_task: null,
  voice_sample: null,
  voice_transcript_start: 0,
  voice_message: '',
  pending_voice: null,
  clone_request: null,
  clone_timer: null,
  calibration_from: 'settings',
  voice_from: 'setup',
  selected_preset: null,
  failed_manifest: null,
  last_profile_json: settings.profile ? JSON.stringify(settings.profile) : '',
  last_in_id: null,
  last_out_id: null,
  draft_id: null,
  draft_deadline: 0,
  draft_timer: null,
  signals_key: '',
  render_frame: 0,
  signal_count: 0,
  wake_lock: null,
};

let connection = null;
let monitor_snapshot = null;
let phone_monitor = null;
let monitor_seat = null;
let last_output_phase;
let last_output_at = 0;
const gesture_scopes = new Map();
const awaiting_signal_ack = new Map();
const last_touch_at = new Map();
const privateCueAudio = new Map();
const reactPitch = Boolean(document.querySelector('[data-pitch-owner="react"]'));
let lastPitchRender = '';
const SIGNAL_ACK_MS = 1800;
const TOUCH_REPEAT_MS = 320;

const keepalive = $('keepalive');

const input = createMediaInput({
  mode: settings.mode,
  gestureModel: settings.input_mode === 'real' ? settings.gesture_model : null,
  timing: settings.timing,
  onSignal: on_signal,
  onRaw: on_raw,
  onError: on_pattern_error,
  onPlay: on_media_play,
  onMediaEvent: action => {
    diag('media', { action, mic_open: capture.open, keepalive_paused: keepalive.paused });
    calibration.note_media_event(action);
  },
});
const emulator = createEmulator({ input, settings: settings.emulator });
const touch_emulator = createEmulator({ input, settings: touch_profile() });

const audio = createAudioEngine({
  volumes: settings.volumes,
  timing: settings.app,
  on_status: ({ key, text }) => set_issue(key, text),
  on_heard: message_id => {
    const text = privateCueAudio.get(message_id);
    if (privateCueAudio.delete(message_id)) {
      if (reactPitch) {
        document.dispatchEvent(new CustomEvent('telepathy:pitch-speech-start', { detail: { id: message_id, text } }));
      } else {
        const notes = $('live-pitch-notes');
        notes.classList.remove('cue-started');
        void notes.offsetWidth;
        notes.classList.add('cue-started');
      }
    }
    return send({ type: 'heard', messageId: message_id });
  },
});

// A draft the hub has retired (answered, expired, replaced, revealed) must not start playing late,
// and a draft whose clearing state never arrives must still leave the screen.
const drafts = createDraftTracker({
  on_retire: id => {
    audio.cancel_previews({ message_id: id });
    schedule_render();
  },
});

const capture = createCapture({
  get_context: () => audio.context(),
  frame_ms: () => settings.app.micFrameMs,
  on_frame: ({ audio: pcm, level }) => {
    if (ui.listen_wanted && ui.state?.roomInput !== 'mac') send({ type: 'mic', audio: pcm, level });
  },
  on_state: on_capture_state,
});

const calibration = createCalibration({
  input,
  emulator,
  audio,
  get_settings: () => settings,
  set_gesture_model: set_earbud_model,
  get_seat: () => ui.seat,
  is_sim,
  arm: arm_calibration_media,
  resume_media: resume_anchor,
  on_apply: apply_profile,
  on_run_state: running => {
    if (!running) ui.earbud_out = false;
    render();
  },
  on_exit: exit_calibration,
});

function touch_profile() {
  return touchSettings(settings.timing, settings.emulator, settings.mode);
}

function read_json(storage, key) {
  try {
    return JSON.parse(storage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

function load_settings() {
  const saved = read_json(sessionStorage, STORAGE_KEY);
  const forced = QUERY.get('sim') === '1' ? 'sim' : QUERY.get('real') === '1' || DIRECT_CALIBRATION ? 'real' : null;
  const saved_input = saved.input_mode === 'sim' ? 'sim' : 'real';
  const input_mode = forced ?? saved_input;
  persisted_input = saved_input;
  let personal_timing = {};
  try {
    const { countWindowMs, countMedianMs } = read_json(localStorage, PERSONAL_TIMING_KEY);
    if (Number.isFinite(countWindowMs) && countWindowMs >= 350 && countWindowMs <= 2500 &&
      Number.isFinite(countMedianMs) && countMedianMs > 0 && countMedianMs < countWindowMs) {
      personal_timing = { countWindowMs, countMedianMs };
    }
  } catch {}
  return {
    seat: SEAT_NAMES.includes(saved.seat) ? saved.seat : null,
    input_mode,
    mode: input_mode === 'sim' && saved.mode === 1 ? 1 : 2,
    gesture_model: saved.gesture_model === 'pro' ? 'pro' : 'next-only',
    drafts: saved.drafts !== false,
    volumes: { ...DEFAULT_VOLUMES, ...saved.volumes },
    timing: { ...DEFAULT_TIMING, ...saved.timing, ...personal_timing },
    emulator: { ...DEFAULT_EMULATOR, ...saved.emulator },
    network: { ...DEFAULT_NETWORK, enabled: input_mode === 'sim', ...saved.network },
    app: { ...APP_TIMING, ...saved.app },
    profile: saved.profile ?? null,
    setup_reset: saved.setup_reset ?? null,
    setup: input_mode === saved_input ? { ...fresh_setup(), ...saved.setup } : fresh_setup(),
  };
}

function save_settings() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, input_mode: persisted_input }));
  } catch {}
}

function is_sim() {
  return settings.input_mode === 'sim';
}

function uses_phone_room() {
  return ui.state ? ui.state.roomInput !== 'mac' : ui.hub_info?.roomInput === 'phones';
}

function has_consent(scope) {
  try {
    const consent = sessionStorage.getItem(CONSENT_KEY);
    return consent === '1' || scope === 'voice' && consent === 'voice';
  } catch {
    return false;
  }
}

function set_consent(granted) {
  try {
    if (granted) sessionStorage.setItem(CONSENT_KEY, uses_phone_room() ? '1' : 'voice');
    else sessionStorage.removeItem(CONSENT_KEY);
  } catch {}
}

function set_text(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function my_state() {
  return ui.state?.seats?.[ui.seat] ?? null;
}

function partner_seat() {
  return ui.seat === 'A' ? 'B' : 'A';
}

function is_online() {
  return connection?.socket.readyState === SOCKET_OPEN;
}

// Critical frames carry the session and hub they were made for, so the hub can refuse a stale one.
// Frames sent before the first state arrives omit the tags.
function scoped(frame) {
  if (!SCOPED_FRAMES.has(frame.type)) return frame;
  const { sessionId, hubId } = ui.state ?? {};
  if (sessionId == null && hubId == null) return frame;
  return { ...(sessionId != null && { sessionId }), ...(hubId != null && { hubId }), ...frame };
}

function send(frame) {
  if (!is_online()) return false;
  return connection.link.send(scoped(frame));
}

function set_issue(key, text, action_label, action) {
  if (text) ui.issues.set(key, { text, action_label, action });
  else ui.issues.delete(key);
  render_banner();
}

function show_note(text) {
  ui.note = text;
  clearTimeout(ui.note_timer);
  ui.note_timer = setTimeout(() => {
    ui.note = '';
    schedule_render();
  }, NOTE_MS);
  schedule_render();
}

/* Input. Touch, keyboard, emulator and earbuds all land in these handlers. */

function clear_signal_tracking() {
  gesture_scopes.clear();
  last_touch_at.clear();
  clearTimeout(ui.receipt_timer);
  for (const timer of awaiting_signal_ack.values()) clearTimeout(timer);
  awaiting_signal_ack.clear();
}

function gesture_scope() {
  const state = ui.state;
  const mine = my_state();
  const pending = mine?.pending;
  const receipt = mine?.receipt;
  return {
    hubId: state?.hubId,
    sessionId: state?.sessionId,
    cacheId: state?.cacheId ?? null,
    pitchHelp: state?.phase === 'live' && state.pitchHelp === true,
    draftId: drafts.can_approve(pending) ? pending.id : null,
    visibleDraftId: drafts.visible(pending) ? pending.id : null,
    previewWaiting: drafts.visible(pending) && pending.heardAt == null,
    receiptId: receipt && (ui.receipt_deadline ?? 0) >= performance.now() ? receipt.messageId : null,
  };
}

function on_raw(event) {
  calibration.note_raw(event);
  gesture_scopes.set(event.action + ':' + event.at, gesture_scope());
  if (gesture_scopes.size > 32) gesture_scopes.delete(gesture_scopes.keys().next().value);
  if (event.action !== 'pause' || event.squeeze) return;
  if (ui.issues.get('media')?.anchor) set_issue('media', '');
  ui.anchor_pause_expected = !keepalive.paused;
  keepalive.pause();
  set_playback_state('paused');
}

function on_anchor_paused() {
  if (ui.anchor_pause_expected) {
    ui.anchor_pause_expected = false;
    return;
  }
  if (is_sim() || !ui.armed || ui.earbud_out || keepalive.ended) return;
  ui.issues.set('media', {
    text: 'Earbud controls stopped. Tap to wake them.', action_label: 'Wake', action: arm_media, anchor: true,
  });
  render_banner();
}

function on_media_play() {
  resume_anchor();
  void audio.resume();
}

function on_signal(signal, trace, { toggle_question_mode = false, draft_id, receipt_id, explicit_signal = false } = {}) {
  diag('signal', { signal, calibrating: calibration.active() });
  if (calibration.active()) {
    calibration.note_signal(signal);
    return;
  }
  if (signal === 'OUT') ui.earbud_out = true;
  if (signal === 'BACK') ui.earbud_out = false;
  schedule_render();
  if (!is_online()) {
    audio.play_cue('error');
    show_note('Hub unreachable. Signal not sent.');
    return;
  }
  const first = trace?.[0];
  const scope = (first && gesture_scopes.get(first.action + ':' + first.at)) ?? gesture_scope();
  if (signal === 'R1' && !explicit_signal && scope.previewWaiting && !scope.receiptId) {
    show_note('Wait for the preview before sending.');
    return;
  }
  const pitch_help = scope.pitchHelp && ui.state?.phase === 'live' && ui.state.pitchHelp
    && (signal === 'LR' || signal === 'R1' && first && !scope.draftId && !scope.receiptId);
  const discard = signal === 'L1' || settings.mode === 1 && signal === 'R2';
  const question_mode = pitch_help && ui.state.questionModeAvailable && (toggle_question_mode || signal === 'R1');
  if (pitch_help) signal = 'LR';
  flash_signal(signal);
  ui.signal_count += 1;
  const id = ui.seat + '-' + Date.now().toString(36) + '-' + ui.signal_count;
  const { previewWaiting, pitchHelp, visibleDraftId, ...intent } = scope;
  intent.draftId = explicit_signal || receipt_id ? null : draft_id ?? (discard ? visibleDraftId : scope.draftId);
  intent.receiptId = explicit_signal ? null : receipt_id ?? scope.receiptId;
  if (!send({ type: 'signal', signal, id, ...intent, ...(pitch_help && { purpose: question_mode ? 'question_mode' : 'pitch_help' }) })) {
    audio.play_cue('error');
    show_note('Signal did not reach the hub.');
    return;
  }
  if (scope.hubId && ui.state?.phase === 'live') {
    const timer = setTimeout(() => {
      awaiting_signal_ack.delete(id);
      audio.play_cue('error');
      show_note('The hub did not confirm this signal. Check the connection.');
    }, SIGNAL_ACK_MS);
    awaiting_signal_ack.set(id, timer);
  }
  if (ui.state?.phase !== 'live') show_note('Recognized ' + SIGNAL_LABELS[signal] + '. The stage has not started.');
}

function on_pattern_error(trace) {
  if (calibration.active()) {
    calibration.note_reject(trace);
    return;
  }
  audio.play_cue('error');
  show_note('Pattern not recognized.');
}

function flash_signal(signal) {
  const button = $('signals').querySelector('[data-signal="' + signal + '"]');
  if (!button) return;
  button.classList.remove('fired');
  void button.offsetWidth;
  button.classList.add('fired');
}

function touch_signal(signal) {
  if (signal !== 'OUT' && signal !== 'BACK') {
    const now = performance.now();
    if (now - (last_touch_at.get(signal) ?? -Infinity) < TOUCH_REPEAT_MS) return;
    last_touch_at.set(signal, now);
    return on_signal(signal, undefined, { explicit_signal: true });
  }
  if (signal === 'BACK') resume_anchor();
  touch_emulator.configure(touch_profile());
  touch_emulator.signal(signal, settings.mode);
}

function touch_draft(approve) {
  const pending = my_state()?.pending;
  if (!drafts.visible(pending) || (approve && (!drafts.can_approve(pending) || performance.now() >= ui.draft_deadline))) return;
  const signal = approve ? 'R1' : settings.mode === 1 ? 'R2' : 'L1';
  on_signal(signal, undefined, { draft_id: pending.id });
}

function touch_receipt() {
  const { receiptId } = gesture_scope();
  if (receiptId && ui.state?.phase === 'live') on_signal('R1', undefined, { receipt_id: receiptId });
}

function set_playback_state(state) {
  try {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = state;
  } catch {}
}

function resume_anchor() {
  const airpods_playback = !is_sim() && !ui.voice_task && (ui.calibration_playback || ui.lock_controls);
  const source = airpods_playback ? AIRPODS_1_PLAYBACK_URL : '/assets/keepalive.wav';
  if (keepalive.getAttribute('src') !== source) {
    ui.anchor_pause_expected = !keepalive.paused;
    keepalive.src = source;
  }
  if (airpods_playback) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  const playing = keepalive.play();
  playing?.then?.(() => {
    set_playback_state('playing');
    if (ui.issues.get('media')?.anchor) set_issue('media', '');
  }).catch(() => {
    if (is_sim()) return;
    ui.issues.set('media', {
      text: 'Earbud controls need a tap to wake up.', action_label: 'Wake', action: arm_media, anchor: true,
    });
    render_banner();
  });
}

function arm_media() {
  void audio.unlock();
  const media_session = navigator.mediaSession;
  const registered = input.register(media_session);
  registerExtraActions();
  diag('arm', { registered, model: settings.gesture_model, input_mode: settings.input_mode });
  if (media_session && globalThis.MediaMetadata) {
    media_session.metadata = new MediaMetadata({
      title: 'Telepathy', artist: ui.seat ? 'Seat ' + ui.seat : 'Seat',
    });
  }
  void audio.preload_cues();
  if (!ui.earbud_out) resume_anchor();
  ui.armed = true;
  const works = registered.includes('nexttrack')
    && (settings.gesture_model !== 'pro' || registered.includes('previoustrack'));
  if (is_sim() || works) {
    if (!ui.issues.get('media')?.anchor) set_issue('media', '');
  } else {
    set_issue('media', 'This browser did not accept earbud controls. Use the buttons on Live.');
  }
  void acquire_wake_lock();
}

async function acquire_wake_lock() {
  if (!navigator.wakeLock || ui.lock_controls || document.visibilityState !== 'visible' || ui.wake_lock) return;
  try {
    ui.wake_lock = await navigator.wakeLock.request('screen');
    ui.wake_lock.addEventListener('release', () => { ui.wake_lock = null; });
  } catch {}
}

/* Hub connection. */

function connect() {
  clearTimeout(ui.reconnect_timer);
  if (!ui.seat) return;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({ role: 'seat', seat: ui.seat });
  if (is_sim()) query.set('sim', '1');
  const socket = new WebSocket(scheme + '//' + location.host + '/ws?' + query);
  const link = createNetworkLink(socket, settings.network);
  const this_connection = { socket, link, synced: false, listen_sent: false, early_cache: [] };
  connection = this_connection;
  ui.connection_state = 'wait';
  link.onMessage(frame => {
    if (connection === this_connection) handle_frame(frame, this_connection);
  });
  socket.addEventListener('open', () => {
    if (connection !== this_connection) return;
    ui.reconnect_delay = settings.app.reconnectMinMs;
    ui.connection_state = 'on';
    set_issue('connection', '');
    audio.cancel_previews();
    audio.cancel_announcements();
    audio.flush_heard();
    void audio.preload_cues();
    schedule_render();
  });
  socket.addEventListener('close', event => {
    if (connection !== this_connection) return;
    connection = null;
    ui.connection_state = 'off';
    audio.cancel_previews();
    audio.cancel_announcements();
    clear_signal_tracking();
    if (event.code === SOCKET_MOVED) {
      set_issue('connection', 'This seat opened on another device.', 'Take it back', reconnect_now);
    } else {
      set_issue('connection', 'Hub connection lost. Reconnecting. Taps will buzz until it returns.');
      schedule_reconnect();
    }
    schedule_render();
  });
  schedule_render();
}

function schedule_reconnect() {
  clearTimeout(ui.reconnect_timer);
  ui.reconnect_timer = setTimeout(connect, ui.reconnect_delay);
  ui.reconnect_delay = Math.min(settings.app.reconnectMaxMs, ui.reconnect_delay * 1.6);
}

function reconnect_now() {
  const previous = connection;
  connection = null;
  clear_signal_tracking();
  previous?.link.close();
  set_issue('connection', '');
  connect();
}

async function probe_hub() {
  if (document.visibilityState === 'visible') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.app.hubProbeTimeoutMs);
    try {
      const response = await fetch('/info', { cache: 'no-store', signal: controller.signal });
      ui.hub_reachable = true;
      ui.probe_failures = 0;
      if (response.ok) ui.hub_info = await response.json();
    } catch {
      ui.hub_reachable = false;
      ui.probe_failures += 1;
      if (ui.probe_failures >= PROBE_FAILURES_TO_RECONNECT && is_online()) reconnect_now();
    } finally {
      clearTimeout(timer);
    }
    schedule_render();
  }
  setTimeout(probe_hub, settings.app.hubProbeMs);
}

function is_stale_frame(frame) {
  const state = ui.state;
  if (!state) return false;
  if (frame.hubId != null && state.hubId != null && frame.hubId !== state.hubId) return true;
  return frame.sessionId != null && state.sessionId != null && frame.sessionId !== state.sessionId;
}

function handle_frame(frame, source) {
  switch (frame?.type) {
    case 'monitor':
      if (!is_stale_frame(frame)) {
        monitor_snapshot = frame.monitor;
        render_monitor();
      }
      return;
    case 'state': return on_state(frame.state, source);
    case 'cache':
      // The hub sends a reconnecting seat its manifest before the first state. Hold it until that state
      // says which hub and session it belongs to, then accept or drop it.
      if (!source.synced) {
        source.early_cache.push(frame);
        return undefined;
      }
      return is_stale_frame(frame) ? undefined : void on_cache(frame, source);
    case 'audio':
      if (source.synced && is_stale_frame(frame)) return;
      if (['announcement', 'pitch_help'].includes(frame.kind) && (!source.synced || ui.state?.canned || ui.state?.phase === 'reveal')) return;
      if (frame.kind === 'pitch_help' && frame.messageId) {
        privateCueAudio.set(frame.messageId, frame.text);
        if (privateCueAudio.size > 32) privateCueAudio.delete(privateCueAudio.keys().next().value);
      }
      return audio.play(frame);
    case 'signal_ack': {
      const timer = awaiting_signal_ack.get(frame.id);
      if (timer === undefined) return;
      clearTimeout(timer);
      awaiting_signal_ack.delete(frame.id);
      if (!frame.accepted) {
        audio.play_cue('error');
        show_note('The take changed. Tap again when ready.');
      }
      return;
    }
    case 'pitch_help_status':
      if (!is_stale_frame(frame)) show_note(frame.text);
      return;
    case 'pitch_help_hold':
      if (!is_stale_frame(frame)) {
        privateCueAudio.delete(frame.messageId);
        audio.stop_pitch_help(frame.messageId);
      }
      return;
    case 'voice_status': return is_stale_frame(frame) ? undefined : on_voice_status(frame);
    case 'voice_preview_error': return is_stale_frame(frame) ? undefined : set_issue('voice', 'The speaking preview could not load. Try again.');
    case 'room_mic_invite':
      if (is_stale_frame(frame)) return;
      $('settings-room-link').value = frame.url ?? '';
      $('settings-room-link').hidden = !frame.url;
      set_text($('settings-room-status'), frame.error ?? 'Copy this link to the spare phone on the same hotspot.');
      return;
    case 'calibration': return is_stale_frame(frame) ? undefined : receive_profile(frame.profile);
    default: return undefined;
  }
}

function on_state(next, source) {
  const previous = ui.state;
  ui.state = next;
  if (next.setupReset && settings.setup_reset !== next.hubId + ':' + next.setupReset) reset_phone_setup(next);
  if (!is_sim() && !ui.voice_task && !ui.lock_controls && my_state()?.roomMicSource === 'companion') {
    set_lock_controls(true);
  }
  const new_session = previous && (previous.sessionId !== next.sessionId || previous.hubId !== next.hubId);
  if (new_session) {
    privateCueAudio.clear();
    monitor_snapshot = null;
    audio.clear_session();
    drafts.reset();
    input.reset();
    clear_signal_tracking();
    if (ui.clone_request) ui.voice_message = 'The hub restarted. Record a new sample to try again.';
    clear_clone_request();
    $('settings-room-link').value = '';
    $('settings-room-link').hidden = true;
    set_text($('settings-room-status'), '');
  }
  const receipt = my_state()?.receipt;
  clearTimeout(ui.receipt_timer);
  const receipt_wait = receipt ? receipt.until - (next.serverNow ?? Date.now()) : 0;
  ui.receipt_deadline = receipt_wait > 0 ? performance.now() + receipt_wait : null;
  if (receipt_wait > 0) ui.receipt_timer = setTimeout(schedule_render, receipt_wait + 1);
  drafts.observe(next.seats?.[ui.seat]?.pending ?? null);
  if (next.roomInput === 'mac' && ui.voice_task !== 'clone' && (capture.open || capture.opening || ui.listen_wanted)) stop_mic();
  if (next.phase === 'reveal' && previous?.phase !== 'reveal' || next.canned && !previous?.canned) {
    audio.cancel_previews();
    audio.cancel_announcements();
    clear_clone_request();
    ui.mic_on_next_take ||= ui.listen_wanted || ui.mic_after_lock_controls;
    if (ui.lock_controls) set_lock_controls(false, { restore_mic: false });
    if (capture.open || capture.opening || ui.listen_wanted) stop_mic();
  }
  const first_state = !source.synced;
  if (first_state || new_session || previous?.sessionId !== next.sessionId) reconcile(next, source);
  if (first_state && uses_phone_room() && !is_sim() && has_consent('room') && !capture.open) void start_mic();
  for (const frame of source.early_cache.splice(0)) {
    if (!is_stale_frame(frame)) void on_cache(frame, source);
  }
  if (next.calibration) receive_profile(next.calibration);
  if (new_session && next.phase === 'lobby' && !next.canned && ui.mic_on_next_take) {
    ui.mic_on_next_take = false;
    void start_mic();
  }
  sync_listen(source);
  schedule_render();
}

function reset_phone_setup(state) {
  settings.setup_reset = state.hubId + ':' + state.setupReset;
  settings.setup = fresh_setup();
  settings.profile = null;
  settings.timing = { ...DEFAULT_TIMING, countWindowMs: undefined, countMedianMs: undefined };
  settings.emulator = { ...DEFAULT_EMULATOR };
  try { localStorage.removeItem(PERSONAL_TIMING_KEY); } catch {}
  set_consent(false);
  save_settings();
  calibration.reset();
  clear_clone_request();
  ui.last_profile_json = '';
  ui.mic_on_next_take = false;
  ui.mic_after_calibration = false;
  ui.calibration_playback = false;
  ui.voice_message = 'Session reset. Set up your voice and earbuds again.';
  if (ui.lock_controls) set_lock_controls(false, { restore_mic: false });
  if (capture.open || capture.opening || ui.listen_wanted) stop_mic();
  input.configure({ timing: settings.timing });
  emulator.configure(settings.emulator);
  if (ui.seat && ui.screen !== 'join') {
    ui.voice_from = 'setup';
    go('voice');
  }
}

function reconcile(next, source) {
  source.synced = true;
  source.listen_sent = false;
  const mine = next.seats?.[ui.seat];
  if (!mine) return;
  const setup = settings.setup;
  send({ type: 'configure', mode: settings.mode, drafts: settings.drafts });
  if (ui.pending_voice && mine.voice !== 'building') {
    if (send({ type: 'voice', ...ui.pending_voice })) ui.pending_voice = null;
  } else if (setup.voice && !USABLE_VOICES.has(mine.voice) && mine.voice !== 'building') {
    if (is_sim() || setup.voice_kind !== 'clone') {
      send({ type: 'setup', step: 'voice', complete: true });
    } else {
      setup.voice = false;
      setup.voice_kind = null;
      setup.ready = false;
      ui.voice_message = 'The hub was reset. Read again or use the premade voice.';
      save_settings();
      if (!calibration.active() && !ui.voice_task) {
        ui.voice_from = 'setup';
        go('voice');
      }
    }
  }
  if (setup.earbuds) send({ type: 'setup', step: 'earbuds', complete: true });
  if (setup.calibrated) send({ type: 'setup', step: 'calibrate', complete: true });
  if (setup.ready) send({ type: 'setup', step: 'ready', complete: true });
  if (settings.profile?.seat === ui.seat && !next.calibration) {
    send({ type: 'calibration', profile: settings.profile });
  }
}

function sync_listen(source = connection) {
  if (ui.state?.roomInput === 'mac') return;
  if (!source || source.listen_sent || !capture.open || !ui.listen_wanted) return;
  if (my_state()?.listening) {
    source.listen_sent = true;
    return;
  }
  if (send({ type: 'listen', enabled: true })) source.listen_sent = true;
}

async function on_cache(frame, source) {
  audio.cancel_previews();
  const session_id = ui.state?.sessionId;
  const hub_id = ui.state?.hubId;
  const ready = await audio.load_manifest(frame);
  if (connection !== source || session_id != null && session_id !== ui.state?.sessionId
      || hub_id != null && hub_id !== ui.state?.hubId) return;
  if (ready) {
    if (ui.failed_manifest?.frame.activeId === frame.activeId) ui.failed_manifest = null;
    if (connection === source) send({ type: 'cache_ready', activeId: frame.activeId });
  } else {
    ui.failed_manifest = { frame, source };
    set_issue('cache', 'Fixed messages did not cache, so the hub has no acknowledgement.', 'Retry', retry_manifest);
  }
  schedule_render();
}

function retry_manifest() {
  const failed = ui.failed_manifest;
  if (!failed) return;
  ui.failed_manifest = null;
  void on_cache(failed.frame, connection ?? failed.source);
}

function clear_clone_request() {
  clearTimeout(ui.clone_timer);
  ui.clone_timer = null;
  ui.pending_voice = null;
  ui.clone_request = null;
}

function on_voice_status({ status, detail, requestId }) {
  if (ui.clone_request && requestId && requestId !== ui.clone_request) return;
  const was_request = Boolean(ui.clone_request && requestId === ui.clone_request);
  const messages = {
    building: 'Building your voice clone in the background.',
    ready: detail || 'Your voice clone is ready.',
    fallback: detail || 'Using the premade voice.',
    error: detail || 'The voice clone failed.',
  };
  ui.voice_message = messages[status] ?? '';
  if (was_request && status !== 'building') {
    clear_clone_request();
    if (status === 'ready') finish_voice('clone');
  }
  if (status === 'error') {
    set_issue('voice', ui.voice_message, 'Use premade', () => {
      set_issue('voice', '');
      finish_voice('premade');
    });
  } else {
    set_issue('voice', '');
  }
  schedule_render();
}

/* Calibration profiles. */

function adopt_profile(profile) {
  settings.profile = profile;
  settings.timing = { ...settings.timing, ...profile.timing };
  settings.emulator = { ...settings.emulator, ...profile.emulator };
  input.configure({ timing: settings.timing });
  emulator.configure(settings.emulator);
  touch_emulator.configure(touch_profile());
  save_settings();
  fill_settings_groups();
  schedule_render();
}

function apply_profile(profile) {
  if (profile.gestureModel === 'next-only') {
    const { countWindowMs, countMedianMs } = profile.timing;
    if (profile.source !== 'real' || !Number.isFinite(countWindowMs) || !Number.isFinite(countMedianMs)) {
      return { applied: false, reason: 'Try again using the earbuds to save your timing.' };
    }
    const timing = { countWindowMs, countMedianMs };
    try {
      localStorage.setItem(PERSONAL_TIMING_KEY, JSON.stringify(timing));
    } catch {
      return { applied: false, reason: 'Safari could not save the timing on this phone.' };
    }
    Object.assign(settings.timing, timing);
    input.configure({ timing });
    save_settings();
    return { applied: true };
  }
  if (settings.profile?.source === 'real' && profile.source !== 'real') {
    return { applied: false, reason: 'Kept the real earbud profile. This run was labeled ' + profile.source + '.' };
  }
  adopt_profile(profile);
  ui.last_profile_json = JSON.stringify(profile);
  send({ type: 'calibration', profile });
  return { applied: true };
}

function receive_profile(profile) {
  if (!profile || typeof profile !== 'object') return;
  const json = JSON.stringify(profile);
  if (json === ui.last_profile_json) return;
  ui.last_profile_json = json;
  const own = profile.seat === ui.seat;
  if (!own && (!is_sim() || profile.source !== 'real' && settings.profile)) return;
  if (settings.profile?.source === 'real' && profile.source !== 'real') return;
  adopt_profile(profile);
}

function exit_calibration({ skipped, completed }) {
  if (skipped || completed) {
    settings.setup.calibrated = true;
    save_settings();
    send({ type: 'setup', step: 'calibrate', complete: true });
  }
  if (ui.calibration_from === 'setup') go(next_setup_screen());
  else go(ui.seat ? 'settings' : 'join');
}

/* Microphone. */

function on_capture_state(status, detail) {
  if (status === 'streaming') {
    set_issue('mic', '');
    sync_listen();
    if (!ui.earbud_out) resume_anchor();
  } else if (['blocked', 'unsupported', 'error', 'lost'].includes(status)) {
    const secure_hint = window.isSecureContext ? '' : ' Open the secure address.';
    set_issue('mic', detail + secure_hint + ' Taps and whispers still work. Room sensing is off.', 'Retry', () => {
      arm_media();
      void start_mic();
    });
    if (connection) connection.listen_sent = false;
  } else if (status === 'interrupted') {
    set_issue('mic', 'The microphone is interrupted. It resumes when the phone allows it.');
  }
  schedule_render();
}

async function start_mic({ sample } = {}) {
  const phone_room = uses_phone_room();
  if (sample !== 'clone' && !phone_room) return false;
  const external_mic = my_state()?.roomMicSource === 'companion';
  if (is_sim() || (!sample && (ui.lock_controls || ui.calibration_playback || external_mic))
    || !has_consent(sample === 'clone' ? 'voice' : 'room') || ui.state?.phase === 'reveal' || ui.state?.canned) return false;
  ui.listen_wanted = phone_room && has_consent('room') && !ui.lock_controls && !external_mic;
  const opened = await capture.start();
  if (opened) sync_listen();
  return opened;
}

function stop_mic() {
  ui.listen_wanted = false;
  capture.stop();
  if (connection) connection.listen_sent = false;
  send({ type: 'listen', enabled: false });
  schedule_render();
}

function arm_calibration_media() {
  ui.calibration_playback = !is_sim();
  if (ui.calibration_playback
    && (capture.open || capture.opening || ui.listen_wanted)) {
    ui.mic_after_calibration = true;
    ui.anchor_pause_expected = !keepalive.paused;
    keepalive.pause();
    stop_mic();
  }
  arm_media();
}

function set_lock_controls(enabled, { restore_mic = true } = {}) {
  if (enabled === ui.lock_controls) return;
  ui.lock_controls = enabled;
  if (enabled) {
    ui.mic_after_lock_controls = ui.listen_wanted || capture.open || capture.opening;
    if (ui.mic_after_lock_controls) stop_mic();
    ui.wake_lock?.release?.().catch(() => {});
    ui.earbud_out = false;
    arm_media();
  } else {
    const resume_mic = ui.mic_after_lock_controls && restore_mic;
    ui.mic_after_lock_controls = false;
    if (resume_mic) void start_mic();
    else if (ui.seat) resume_anchor();
  }
  render();
}

/* Navigation. */

function next_setup_screen() {
  const setup = settings.setup;
  if (!setup.voice && !USABLE_VOICES.has(my_state()?.voice)) return 'voice';
  if (!setup.earbuds) return 'earbuds';
  if (!setup.calibrated) return 'calibrate';
  if (!setup.ready) return 'preset';
  return 'live';
}

function go(screen, options = {}) {
  const resume_mic = ui.screen === 'calibrate' && screen !== 'calibrate' && ui.mic_after_calibration;
  if (resume_mic) ui.mic_after_calibration = false;
  if (screen !== 'calibrate') ui.calibration_playback = false;
  ui.screen = screen;
  for (const section of document.querySelectorAll('.screen')) {
    const active = section.dataset.screen === screen;
    section.hidden = !active;
    section.classList.toggle('enter', false);
    if (active) {
      void section.offsetWidth;
      section.classList.add('enter');
    }
  }
  window.scrollTo?.(0, 0);
  if (screen === 'calibrate') {
    ui.calibration_from = options.from ?? ui.calibration_from;
    calibration.open({ from: ui.calibration_from });
  }
  if (resume_mic && ui.seat && screen !== 'join') void start_mic();
  render();
}

function go_back() {
  if (calibration.active() || ui.voice_task) return;
  if (SUB_SCREENS.has(ui.screen)) {
    go(next_setup_screen());
    return;
  }
  if (ui.screen === 'calibrate' && ui.calibration_from !== 'setup') {
    go(ui.seat ? 'settings' : 'join');
    return;
  }
  if (ui.screen === 'voice' && ui.voice_from === 'settings') {
    ui.voice_from = 'setup';
    go('settings');
    return;
  }
  const index = SETUP_ORDER.indexOf(ui.screen);
  if (index > 0) {
    const previous = SETUP_ORDER[index - 1];
    go(previous, previous === 'calibrate' ? { from: 'setup' } : {});
  } else if (index === 0) {
    leave_seat();
  }
}

function leave_seat() {
  ui.lock_controls = false;
  ui.mic_after_lock_controls = false;
  clear_clone_request();
  const previous = connection;
  connection = null;
  clearTimeout(ui.reconnect_timer);
  previous?.link.close();
  if (capture.open || capture.opening) stop_mic();
  ui.mic_on_next_take = false;
  input.reset();
  clear_signal_tracking();
  audio.clear_session();
  drafts.reset();
  emulator.reset();
  touch_emulator.reset();
  ui.earbud_out = false;
  ui.seat = null;
  ui.state = null;
  ui.connection_state = 'off';
  ui.issues.clear();
  go('join');
}

function join(seat) {
  if (settings.seat !== seat) settings.setup = fresh_setup();
  settings.seat = seat;
  ui.seat = seat;
  save_settings();
  arm_media();
  connect();
  go(next_setup_screen(), { from: 'setup' });
}

function set_input_mode(mode) {
  if (settings.input_mode === mode) return;
  settings.input_mode = mode;
  settings.mode = 2;
  input.configure({ mode: 2, gestureModel: is_sim() ? null : settings.gesture_model });
  settings.network.enabled = mode === 'sim';
  persisted_input = mode;
  settings.setup = fresh_setup();
  save_settings();
  render();
}

/* Voice step. */

function finish_voice(kind) {
  const from = ui.voice_from;
  ui.voice_from = 'setup';
  settings.setup.voice = true;
  settings.setup.voice_kind = kind;
  save_settings();
  if (kind === 'premade') clear_clone_request();
  if (kind !== 'clone') send({ type: 'setup', step: 'voice', complete: true, ...(kind === 'premade' && { fallback: true }) });
  if (from === 'settings') go('settings');
  else go(next_setup_screen(), { from: 'setup' });
}

function set_voice_progress(fraction) {
  $('voice-bar').style.transform = 'scaleX(' + fraction + ')';
}

async function record_sample(kind) {
  if (ui.voice_task || ui.clone_request || kind === 'room' && !uses_phone_room()) return;
  const was_listening = ui.listen_wanted;
  const temporary_mic = kind === 'clone' || !was_listening || ui.lock_controls || my_state()?.roomMicSource === 'companion';
  ui.voice_task = kind;
  arm_media();
  if (!(await start_mic({ sample: kind }))) {
    ui.voice_task = null;
    if (temporary_mic) arm_media();
    ui.voice_message = 'The microphone is not available. Use the premade voice to continue.';
    render();
    return;
  }
  ui.voice_sample = null;
  ui.voice_transcript_start = my_state()?.transcript?.length ?? 0;
  const duration_ms = kind === 'clone' ? settings.app.voiceSampleMs : settings.app.roomSampleMs;
  ui.voice_message = kind === 'clone' ? 'Listening. Speak naturally and pause when you need to.' : 'Sampling the room. No voice clone is made.';
  render();
  try {
    const result = await capture.record({
      duration_ms,
      speech_ms: kind === 'clone' ? duration_ms : undefined,
      on_progress(fraction, sample) {
        set_voice_progress(fraction);
        if (sample) {
          ui.voice_sample = sample;
          schedule_render();
        }
      },
    });
    ui.voice_task = null;
    ui.voice_sample = null;
    set_voice_progress(0);
    if (kind === 'clone') {
      const frame = { wav: result.wav, requestId: 'voice-' + ui.seat + '-' + Date.now().toString(36) };
      ui.clone_request = frame.requestId;
      ui.clone_timer = setTimeout(() => {
        clear_clone_request();
        ui.voice_message = 'No clone result came back. Try recording again or use the premade voice.';
        render();
      }, CLONE_RESPONSE_MS);
      const sent = send({ type: 'voice', ...frame });
      if (!sent) ui.pending_voice = frame;
      ui.voice_message = sent ? 'Uploading your recording…' : 'Connection lost. The recording will upload when you reconnect.';
      render();
    } else {
      ui.voice_message = 'Room sample streamed.';
      finish_voice('room');
    }
  } catch (error) {
    ui.voice_task = null;
    ui.voice_sample = null;
    set_voice_progress(0);
    ui.voice_message = error?.message === 'Recording cancelled.' ? '' : (error?.message || 'The recording stopped early. Try again.');
    render();
  } finally {
    if (temporary_mic || ui.state?.roomInput === 'mac') {
      stop_mic();
      if (ui.seat && kind === 'clone' && !ui.lock_controls) {
        set_lock_controls(true);
        ui.mic_after_lock_controls = was_listening;
      } else if (ui.seat) arm_media();
    }
  }
}

/* Settings groups. */

const SETTING_GROUPS = Object.freeze([
  { key: 'timing', title: 'Recognizer timing', defaults: DEFAULT_TIMING },
  { key: 'emulator', title: 'Emulator', defaults: DEFAULT_EMULATOR },
  { key: 'network', title: 'Network impairment', defaults: DEFAULT_NETWORK },
  { key: 'app', title: 'App timing', defaults: APP_TIMING },
]);

function apply_group(key) {
  if (key === 'timing') input.configure({ timing: settings.timing });
  if (key === 'emulator') {
    emulator.configure(settings.emulator);
    touch_emulator.configure(touch_profile());
  }
  if (key === 'network' && ui.seat) reconnect_now();
  if (key === 'app') audio.configure({ timing: settings.app });
  save_settings();
}

function clean_number(group_key, key, raw, fallback) {
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0) return fallback;
  if (key.endsWith('Rate')) return Math.min(1, value);
  const limits = group_key === 'app' ? APP_TIMING_LIMITS[key] : null;
  return limits ? Math.min(limits[1], Math.max(limits[0], value)) : value;
}

function build_settings_groups() {
  const host = $('settings-groups');
  for (const group of SETTING_GROUPS) {
    const details = document.createElement('details');
    details.className = 'setting-group';
    const summary = document.createElement('summary');
    summary.textContent = group.title;
    details.append(summary);
    for (const [key, default_value] of Object.entries(group.defaults)) {
      const row = document.createElement('label');
      row.className = 'number-row';
      const name = document.createElement('span');
      name.textContent = key;
      const field = document.createElement('input');
      field.dataset.group = group.key;
      field.dataset.key = key;
      if (typeof default_value === 'boolean') {
        field.type = 'checkbox';
      } else {
        field.type = 'number';
        field.min = '0';
        field.step = 'any';
        field.inputMode = 'decimal';
      }
      row.append(name, field);
      details.append(row);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.dataset.resetGroup = group.key;
    reset.textContent = 'Reset to defaults';
    details.append(reset);
    host.append(details);
  }
  host.addEventListener('change', event => {
    const field = event.target;
    const { group, key } = field.dataset;
    if (!group) return;
    const current = settings[group][key];
    settings[group][key] = field.type === 'checkbox' ? field.checked : clean_number(group, key, field.value, current);
    fill_settings_groups();
    apply_group(group);
  });
  host.addEventListener('click', event => {
    const group_key = event.target.dataset?.resetGroup;
    if (!group_key) return;
    const group = SETTING_GROUPS.find(item => item.key === group_key);
    settings[group_key] = { ...group.defaults };
    fill_settings_groups();
    apply_group(group_key);
  });
}

function fill_settings_groups() {
  for (const field of $('settings-groups').querySelectorAll('input[data-group]')) {
    const value = settings[field.dataset.group][field.dataset.key];
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else if (document.activeElement !== field) field.value = String(value);
  }
}

/* Rendering. */

function schedule_render() {
  if (ui.render_frame) return;
  ui.render_frame = 1;
  queueMicrotask(() => {
    ui.render_frame = 0;
    render();
  });
}

function render() {
  render_masthead();
  render_banner();
  const renderers = {
    join: render_join, voice: render_voice, earbuds: render_earbuds, preset: render_preset,
    live: render_live, codebook: render_codebook, log: render_log, settings: render_settings,
    calibrate: render_calibrate,
  };
  renderers[ui.screen]?.();
}

function render_masthead() {
  const mine = my_state();
  const seat_text = ui.seat ? 'Seat ' + ui.seat + (mine?.name ? ' · ' + mine.name : '') : '';
  set_text($('masthead-seat'), seat_text);
  if (document.body.dataset.seat !== (ui.seat ?? '')) document.body.dataset.seat = ui.seat ?? '';
  const state = ui.seat ? ui.connection_state : ui.hub_reachable ? 'on' : ui.hub_reachable === false ? 'off' : 'wait';
  $('connection').dataset.state = state;
  set_text($('connection-text'), state === 'on' ? 'Hub' : state === 'wait' ? 'Connecting' : 'Offline');
  const can_go_back = !calibration.active() && !ui.voice_task
    && (SUB_SCREENS.has(ui.screen) || SETUP_ORDER.includes(ui.screen));
  $('nav-back').hidden = !can_go_back;
}

function render_banner() {
  const shows_media = ['earbuds', 'calibrate', 'live'].includes(ui.screen);
  const key = ISSUE_ORDER.find(name => ui.issues.has(name) && (name !== 'media' || shows_media));
  const issue = key ? ui.issues.get(key) : null;
  const banner = $('banner');
  banner.hidden = !issue;
  if (!issue) return;
  set_text($('banner-text'), issue.text);
  const action = $('banner-action');
  action.hidden = !issue.action;
  if (issue.action) {
    set_text(action, issue.action_label);
    action.onclick = issue.action;
  }
}

function render_join() {
  for (const button of document.querySelectorAll('.seat')) {
    button.dataset.last = String(button.dataset.seat === settings.seat);
    button.setAttribute('aria-label', 'Join seat ' + button.dataset.seat);
  }
  for (const radio of document.querySelectorAll('input[name="input_mode"]')) {
    radio.checked = radio.value === settings.input_mode;
  }
  const hub_text = ui.hub_reachable === null ? 'Looking for the hub.'
    : ui.hub_reachable ? 'Hub reachable.' : 'Hub unreachable. Check the hotspot.';
  set_text($('join-status'), hub_text);
  const needs_secure = !is_sim() && !window.isSecureContext;
  const secure = $('join-secure');
  secure.hidden = !needs_secure;
  if (needs_secure) {
    const url = ui.hub_info?.secure ? ui.hub_info.joinUrl : null;
    secure.replaceChildren('Earbuds and the microphone need HTTPS. ');
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = 'Open the secure address';
      secure.append(link);
    } else {
      secure.append('The hub has no secure address yet.');
    }
  }
}

function render_voice() {
  const sim = is_sim();
  const phone_room = uses_phone_room();
  const consent = has_consent(phone_room ? 'room' : 'voice');
  const busy = Boolean(ui.voice_task);
  const mine = my_state();
  set_text($('voice-step'), ui.voice_from === 'settings' ? 'Settings' : '1 / 4');
  set_text($('voice-consent-text'), phone_room ? CONSENT_TEXT : VOICE_CONSENT_TEXT);
  set_text($('voice-script'), VOICE_SCRIPT);
  $('voice-consent-row').hidden = sim;
  $('voice-consent').checked = consent;
  $('voice-consent').disabled = busy;
  const record = $('voice-record');
  record.hidden = sim || busy;
  record.disabled = !consent || Boolean(ui.clone_request) || mine?.voice === 'building';
  set_text(record, 'Start recording');
  const room = $('voice-room');
  room.hidden = sim || busy || !phone_room;
  room.disabled = !consent || Boolean(ui.clone_request);
  set_text(room, 'Room sample only, ' + Math.round(settings.app.roomSampleMs / 1000) + ' s');
  $('voice-cancel').hidden = !busy;
  $('voice-finish').hidden = ui.voice_task !== 'clone' || !ui.voice_sample?.ready;
  $('voice-meter').hidden = !busy;
  const sample = ui.voice_sample;
  set_text($('voice-meter-label'), ui.voice_task === 'clone'
    ? ((sample?.seconds ?? 0).toFixed(0) + ' s of usable speech') : 'Room sample');
  const preview = ui.voice_task === 'clone'
    ? mine?.transcript?.slice(ui.voice_transcript_start).map(entry => entry.text).join(' ').slice(-240) ?? '' : '';
  $('voice-transcript').hidden = !preview;
  set_text($('voice-transcript-text'), preview);
  $('voice-skip').hidden = busy;
  set_text($('voice-skip'), ui.voice_from === 'settings' && USABLE_VOICES.has(mine?.voice) ? 'Keep the current voice' : 'Use the premade voice');
  $('voice-skip').disabled = false;
  const fallback = sim ? 'Simulated seat. The microphone stays closed.'
    : !consent ? 'Tick the consent line to open the microphone.'
    : capture.open ? 'Microphone on. Read when ready.' : '';
  set_text($('voice-status'), sample?.clipped ? 'Your mic is clipping. Move it a little farther away.' :
    ui.voice_message || fallback);
}

function render_earbuds() {
  for (const radio of document.querySelectorAll('input[name="earbud_mode"]')) {
    radio.checked = radio.value === settings.gesture_model;
  }
}

function render_calibrate() {
  set_text($('cal-step'), ui.calibration_from === 'setup' ? '3 / 4' : ui.calibration_from === 'direct' ? 'Direct' : 'Settings');
  calibration.refresh();
}

function render_preset() {
  if (ui.selected_preset === ui.state?.preset && !ui.state?.presetPending) ui.selected_preset = null;
  const active = ui.selected_preset ?? ui.state?.presetPending ?? ui.state?.preset ?? 'Pitch';
  const list = $('preset-list');
  if (!list.childElementCount) {
    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.preset = preset;
      const name = document.createElement('span');
      name.textContent = preset;
      const tag = document.createElement('small');
      button.append(name, tag);
      list.append(button);
    }
  }
  for (const button of list.children) {
    const is_active = button.dataset.preset === active;
    button.setAttribute('aria-pressed', String(is_active));
    const tag = button.querySelector('small');
    const pending = ui.state?.presetPending === button.dataset.preset;
    set_text(tag, pending ? 'Caching' : ui.state?.preset === button.dataset.preset ? 'Current' : '');
  }
  $('preset-custom-row').hidden = active !== 'Custom';
  const mine = my_state();
  const status = !is_online() ? 'Waiting for the hub.'
    : mine?.ready ? 'Messages cached. You are ready.'
    : ui.state?.presetPending ? 'Generating and caching fixed messages.'
    : 'Your fixed messages cache once both seats have a voice.';
  set_text($('preset-status'), status);
}

function format_clock(at) {
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function render_message(prefix, entry, key) {
  const article = $('live-' + prefix);
  set_text($('live-' + prefix + '-text'), entry?.text ?? '');
  set_text($('live-' + prefix + '-time'), format_clock(entry?.at));
  const id = entry?.id ?? null;
  if (ui[key] !== id) {
    ui[key] = id;
    if (id) {
      article.classList.remove('fresh');
      void article.offsetWidth;
      article.classList.add('fresh');
    }
  }
}

function render_signals() {
  const codebook = ui.state?.codebook ?? {};
  const inlineCue = reactPitch && !is_sim() && Boolean(ui.state?.questionModeAvailable);
  const order = SIGNAL_ORDER[settings.mode].filter(signal => !inlineCue || signal !== 'LR');
  const host = $('signals');
  const pitch_help = ui.state?.pitchHelp === true;
  const key = settings.mode + settings.gesture_model + String(pitch_help) + String(ui.state?.questionModeAvailable) + String(inlineCue) + JSON.stringify(codebook);
  if (ui.signals_key !== key) {
    ui.signals_key = key;
    host.replaceChildren(...order.map(signal => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'signal';
      button.dataset.signal = signal;
      if (signal === 'LR' && settings.mode === 2) button.dataset.wide = 'true';
      const name = document.createElement('b');
      name.textContent = signal === 'LR' && pitch_help ? 'What should I say?' : SIGNAL_LABELS[signal];
      const meaning = document.createElement('span');
      meaning.textContent = signal === 'LR' && pitch_help
        ? ui.state?.questionModeAvailable ? 'Get a private cue now'
          : settings.gesture_model === 'pro' ? 'Single stem squeeze' : 'One next-track event'
        : codebook[signal] ?? SYSTEM_MEANINGS[signal] ?? '';
      button.append(name, meaning);
      button.setAttribute('aria-label', name.textContent + ' · ' + meaning.textContent);
      return button;
    }));
  }
  const out_button = host.querySelector('[data-signal="OUT"]');
  const back_button = host.querySelector('[data-signal="BACK"]');
  if (out_button) out_button.disabled = ui.earbud_out;
  if (back_button) back_button.disabled = !ui.earbud_out;
}

function render_draft(shown) {
  const pending = drafts.visible(shown) ? shown : null;
  const draft = $('live-draft');
  draft.hidden = !pending;
  clearTimeout(ui.draft_timer);
  if (!pending) {
    ui.draft_id = null;
    return;
  }
  const is_preset = pending.kind === 'preset';
  set_text($('live-draft-label'), is_preset ? 'Switch preset?' : 'Send this?');
  set_text($('live-draft-text'), pending.text ?? '');
  set_text($('draft-send'), is_preset ? 'Switch' : 'Send');
  set_text($('draft-discard'), 'Discard');
  const key = pending.id + ':' + pending.expiresAt + ':' + (pending.heardAt ?? '');
  const now = performance.now();
  if (ui.draft_id !== key) {
    ui.draft_id = key;
    const start = pending.heardAt ?? pending.decisionAt;
    const duration = Number(pending.expiresAt) - Number(start);
    const remaining = Number(pending.expiresAt) - Number(ui.state?.serverNow ?? start);
    const total = duration > 0 ? duration : 6000;
    const left = Number.isFinite(remaining) ? Math.max(0, Math.min(remaining, total)) : total;
    ui.draft_deadline = now + left;
    const clock = $('live-draft-clock');
    clock.style.transition = 'none';
    clock.style.transform = 'scaleX(' + left / total + ')';
    void clock.offsetWidth;
    clock.style.transition = 'transform ' + left + 'ms linear';
    clock.style.transform = 'scaleX(0)';
  }
  const left = Math.max(0, ui.draft_deadline - now);
  $('draft-send').disabled = !drafts.can_approve(pending) || !left;
  set_text($('live-draft-time'), !left ? 'Expired' : pending.heardAt == null ? 'Waiting for preview' : Math.ceil(left / 1000) + ' s');
  if (left) ui.draft_timer = setTimeout(schedule_render, (left % 1000 || 1000) + 1);
}

function renderPitchControls(state, mine, phase, cue) {
  const available = Boolean(state?.questionModeAvailable) && !is_sim();
  const armed = mine?.questionMode === true;
  if (reactPitch) {
    const detail = { available, armed, live: phase === 'live' && !state?.canned, connected: is_online(),
      roomLive: state?.room?.transcription === 'live', preparing: ui.note === PITCH_PREPARING_NOTE, cue: cue ?? null };
    const fingerprint = JSON.stringify(detail);
    if (fingerprint !== lastPitchRender) {
      lastPitchRender = fingerprint;
      document.dispatchEvent(new CustomEvent('telepathy:pitch-state', { detail }));
    }
    return;
  }

  const mode_button = $('question-mode');
  mode_button.hidden = !available;
  mode_button.setAttribute('aria-pressed', String(armed));
  set_text(mode_button.querySelector('b'), armed ? 'Question mode on' : 'Question mode');
  set_text(mode_button.querySelector('span'), armed ? 'Listening for questions. Tap to stop.' : 'Prepare while the judge speaks');

  $('live-pitch-notes').hidden = !cue?.text;
  set_text($('live-pitch-cue'), cue?.text ?? '');
  const points = Array.isArray(cue?.points) ? cue.points : [];
  const notes_key = JSON.stringify(points);
  const list = $('live-pitch-points');
  if (list.dataset.key !== notes_key) {
    list.dataset.key = notes_key;
    list.replaceChildren(...points.map(point => {
      const item = document.createElement('li');
      item.textContent = point;
      return item;
    }));
  }
}

function render_live() {
  const state = ui.state;
  const mine = my_state();
  const partner = state?.seats?.[partner_seat()];
  const preset = state?.preset ?? 'Pitch';
  set_text($('live-preset'), state?.presetPending && state.presetPending !== preset ? preset + ' to ' + state.presetPending : preset);
  const phase = state?.phase ?? 'lobby';
  const cue = phase === 'live' && !state?.canned && preset === 'Pitch' ? mine?.lastPitchCue : null;
  renderPitchControls(state, mine, phase, cue);
  $('live-phase').dataset.phase = phase;
  set_text($('live-phase'), state?.canned ? 'Canned take' : PHASE_LABELS[phase] ?? '');
  set_text($('live-partner'), partner?.online ? (partner.ready ? 'Ready' : 'Connected') : 'Offline');

  const listen = $('live-listen');
  // Old hubs omit `transcription`. Otherwise "Listening" means the room is actually being transcribed.
  const transcribing = mine?.transcription == null || mine.transcription === 'live';
  const companion_mic = mine?.roomMicSource === 'companion' && mine?.listening;
  const listening = !is_sim() && (capture.open || companion_mic) && mine?.listening && transcribing;
  listen.dataset.state = state?.roomInput === 'mac' ? state.room?.transcription === 'live' ? 'on' : 'off' : is_sim() ? 'sim' : listening ? 'on' : 'off';
  set_text($('live-listen-text'), state?.roomInput === 'mac' ? state.room?.transcription === 'live' ? 'Mac listening' : 'Mac mic ' + (state.room?.transcription ?? 'off')
    : is_sim() ? 'Simulated' : companion_mic ? 'Room mic' : listening ? 'Listening' : capture.open ? 'Mic only' : 'Mic off');
  set_text($('live-cache'), ui.failed_manifest ? 'Failed' : mine?.ready ? 'Cached' : state?.presetPending ? 'Caching' : 'Not ready');
  $('lock-controls').hidden = is_sim() || phase === 'reveal' || Boolean(state?.canned);
  $('lock-controls-toggle').setAttribute('aria-pressed', String(ui.lock_controls));
  set_text($('lock-controls-toggle'), ui.lock_controls ? 'Disable lock-screen controls' : 'Enable lock-screen controls');
  set_text($('lock-controls-status'), ui.lock_controls
    ? state?.roomInput === 'mac' ? 'Earbuds active. Room audio comes from the Mac microphone.'
      : companion_mic ? 'Earbuds active. The companion mic is listening.' : 'Phone mic paused. You can use a companion mic.'
    : '');

  render_draft(mine?.pending ?? null);
  render_message('in', mine?.lastIn, 'last_in_id');
  render_message('out', mine?.lastOut, 'last_out_id');
  $('live-acknowledge').hidden = phase !== 'live' || !gesture_scope().receiptId;
  set_text($('live-note'), cue?.text === ui.note || reactPitch && ui.note === PITCH_PREPARING_NOTE ? '' : ui.note);
  render_signals();
  render_monitor();
  $('sim-room').hidden = !is_sim();
}

function render_monitor(output = audio.getOutputActivity()) {
  if (ui.screen !== 'live' || !ui.seat) return;
  if (monitor_seat !== ui.seat) {
    monitor_seat = ui.seat;
    phone_monitor = mountChannelMonitor($('phone-monitor'), [ui.seat]);
  }
  const activeCue = reactPitch && ui.state?.phase === 'live' && !ui.state.canned && ui.state.preset === 'Pitch'
    ? my_state()?.lastPitchCue?.text : null;
  const displayed = activeCue && output.title === activeCue ? { ...output, title: '' } : output;
  phone_monitor?.update(monitor_snapshot, { [ui.seat]: displayed });
}

function sample_output() {
  if (!ui.seat) return;
  const output = audio.getOutputActivity();
  const now = performance.now();
  if (output.phase !== last_output_phase || output.phase !== 'idle' && now - last_output_at >= 500) {
    if (send({ type: 'audio_monitor', ...output })) {
      last_output_phase = output.phase;
      last_output_at = now;
    }
  }
  render_monitor(output);
}

function render_codebook() {
  const codebook = ui.state?.codebook ?? {};
  const preset = ui.state?.preset ?? 'Pitch';
  set_text($('codebook-context'), preset + ' · ' + (settings.gesture_model === 'pro' ? 'AirPods Pro' : 'AirPods 1'));
  $('codebook-list').replaceChildren(...SIGNAL_ORDER[settings.mode].map(signal => {
    const row = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = signal === 'LR' && ui.state?.pitchHelp ? 'What should I say?' : SIGNAL_LABELS[signal];
    const meaning = document.createElement('strong');
    meaning.textContent = signal === 'LR' && ui.state?.pitchHelp ? 'Hear a private pitch cue' : codebook[signal] ?? SYSTEM_MEANINGS[signal] ?? '';
    const pattern = document.createElement('small');
    const count = ['R1', 'R2', 'L1'].indexOf(signal) + 1;
    pattern.textContent = is_sim() ? PATTERN_LABELS[settings.mode][signal]
      : !count ? 'On-screen control'
        : settings.gesture_model === 'pro' ? SIGNAL_LABELS[signal] + ' squeeze' : 'Next Track × ' + count;
    if (ui.state?.questionModeAvailable && signal === 'R1') pattern.textContent = 'On-screen fixed cue. Earbud press confirms, acknowledges, or toggles question mode.';
    if (ui.state?.questionModeAvailable && signal === 'LR') pattern.textContent = 'On-screen cue. One earbud press toggles question mode.';
    row.append(name, meaning, pattern);
    return row;
  }));
}

function describe_log(entry) {
  switch (entry.kind) {
    case 'message': return entry.text ?? '';
    case 'receipt': return 'Receipt: ' + (entry.text ?? '');
    case 'back': return 'Earbud back in';
    case 'draft': return 'Draft: ' + (entry.text ?? '');
    case 'confirm': return 'Draft sent: ' + (entry.text ?? '');
    case 'discard': return 'Draft dropped: ' + (entry.text ?? '');
    case 'preset': return 'Preset: ' + (entry.text ?? '');
    default: return entry.text ?? '';
  }
}

function render_log() {
  const entries = (ui.state?.log ?? []).filter(entry => LOG_KINDS.has(entry.kind)).reverse();
  set_text($('log-count'), entries.length + (entries.length === 1 ? ' entry' : ' entries'));
  $('log-empty').hidden = entries.length > 0;
  $('log-list').replaceChildren(...entries.map(entry => {
    const row = document.createElement('li');
    const direction = entry.to === ui.seat && entry.seat !== ui.seat ? 'in' : 'out';
    row.dataset.direction = direction;
    const tag = document.createElement('b');
    const is_draft = ['draft', 'confirm', 'discard'].includes(entry.kind);
    tag.textContent = !entry.seat ? 'Hub' : is_draft ? 'AI' : direction === 'in' ? 'In' : 'Out';
    const text = document.createElement('span');
    text.textContent = describe_log(entry);
    const time = document.createElement('time');
    time.textContent = format_clock(entry.at);
    row.append(tag, text, time);
    return row;
  }));
}

function render_settings() {
  set_text($('settings-context'), ui.seat ? 'Seat ' + ui.seat + ' · ' + (is_sim() ? 'Simulated' : 'Earbuds') : '');
  for (const radio of document.querySelectorAll('input[name="settings_mode"]')) {
    radio.checked = radio.value === settings.gesture_model;
  }
  $('settings-drafts').checked = settings.drafts;
  $('settings-listen-row').hidden = is_sim() || !uses_phone_room();
  $('settings-listen').checked = capture.open && ui.listen_wanted;
  $('settings-listen').disabled = my_state()?.roomMicSource === 'companion';
  const cloned = !is_sim() && my_state()?.voice === 'ready';
  set_text($('settings-voice'), cloned ? 'Re-record voice' : 'Record my voice');
  $('settings-voice-preview').hidden = !cloned || !ui.hub_info?.voicePreview;
  $('settings-room-invite').hidden = is_sim() || !uses_phone_room() || !ui.hub_info?.roomMic;
  for (const name of ['cue', 'voice']) {
    const field = $('settings-volume-' + name);
    if (document.activeElement !== field) field.value = String(settings.volumes[name]);
    set_text($('settings-volume-' + name + '-value'), Math.round(settings.volumes[name] * 100) + '%');
  }
  const profile = settings.profile;
  set_text($('settings-profile'), profile
    ? 'Calibration: ' + profile.source + ', ' + format_clock(Date.parse(profile.createdAt))
    : 'Calibration: synthetic defaults.');
  fill_settings_groups();
  const stats = connection?.link.stats;
  const rows = stats ? Object.entries(stats) : [];
  $('settings-network').replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = 'Link ' + label;
    description.textContent = String(value);
    row.append(term, description);
    return row;
  }));
}

/* Events. */

function set_earbud_model(model) {
  if (!['next-only', 'pro'].includes(model) || settings.gesture_model === model) return;
  settings.gesture_model = model;
  input.configure({ gestureModel: is_sim() ? null : model });
  ui.signals_key = '';
  save_settings();
  render();
}

function bind_events() {
  if (reactPitch) {
    document.addEventListener('telepathy:toggle-question-mode', () => {
      if (ui.state?.phase === 'live' && ui.state.questionModeAvailable) on_signal('LR', undefined, { toggle_question_mode: true });
    });
    document.addEventListener('telepathy:request-pitch-cue', () => {
      if (!is_sim() && is_online() && ui.state?.phase === 'live' && !ui.state.canned && ui.state.questionModeAvailable) touch_signal('LR');
    });
  } else $('question-mode').addEventListener('click', () => on_signal('LR', undefined, { toggle_question_mode: true }));
  installDiag({ send, keepalive });
  $('nav-back').addEventListener('click', go_back);
  keepalive.addEventListener('pause', on_anchor_paused);
  keepalive.addEventListener('playing', () => {
    set_playback_state('playing');
    if (ui.issues.get('media')?.anchor) set_issue('media', '');
  });
  keepalive.addEventListener('timeupdate', () => input.flushAirPods1IfDue());
  $('lock-controls-toggle').addEventListener('click', () => set_lock_controls(!ui.lock_controls));

  for (const button of document.querySelectorAll('.seat')) {
    button.addEventListener('click', () => join(button.dataset.seat));
  }
  for (const radio of document.querySelectorAll('input[name="input_mode"]')) {
    radio.addEventListener('change', () => set_input_mode(radio.value));
  }
  for (const button of document.querySelectorAll('[data-cal-seat]')) {
    button.addEventListener('click', () => {
      const seat = button.dataset.calSeat;
      if (settings.seat !== seat) settings.setup = fresh_setup();
      settings.seat = seat;
      ui.seat = seat;
      save_settings();
      arm_media();
      connect();
      render();
    });
  }

  $('voice-consent').addEventListener('change', event => {
    set_consent(event.target.checked);
    if (event.target.checked) {
      arm_media();
      void start_mic();
    } else if (capture.open || capture.opening) {
      stop_mic();
    }
    render();
  });
  $('voice-record').addEventListener('click', () => void record_sample('clone'));
  $('voice-room').addEventListener('click', () => void record_sample('room'));
  $('voice-cancel').addEventListener('click', () => capture.cancel_record());
  $('voice-finish').addEventListener('click', () => capture.finish_record());
  $('voice-skip').addEventListener('click', () => {
    ui.voice_message = '';
    if (ui.voice_from === 'settings' && USABLE_VOICES.has(my_state()?.voice)) {
      ui.voice_from = 'setup';
      go('settings');
      return;
    }
    finish_voice('premade');
  });

  for (const radio of document.querySelectorAll('input[name="earbud_mode"]')) {
    radio.addEventListener('change', () => set_earbud_model(radio.value));
  }
  $('test-audio').addEventListener('click', async () => {
    arm_media();
    await audio.preload_cues();
    set_text($('earbuds-status'), audio.play_cue('system') == null ? 'Audio is unavailable. Tap Test audio again.' : 'Played the test sound.');
  });
  $('earbuds-next').addEventListener('click', () => {
    settings.setup.earbuds = true;
    save_settings();
    send({ type: 'setup', step: 'earbuds', complete: true });
    go(next_setup_screen(), { from: 'setup' });
  });

  $('preset-list').addEventListener('click', event => {
    const button = event.target.closest('[data-preset]');
    if (!button) return;
    ui.selected_preset = button.dataset.preset;
    if (ui.selected_preset !== 'Custom') send({ type: 'preset', preset: ui.selected_preset });
    render();
  });
  $('preset-custom').addEventListener('change', event => {
    send({ type: 'preset', preset: 'Custom', context: event.target.value.trim() });
  });
  $('preset-next').addEventListener('click', () => {
    if (ui.selected_preset === 'Custom') {
      send({ type: 'preset', preset: 'Custom', context: $('preset-custom').value.trim() });
    }
    settings.setup.ready = true;
    save_settings();
    send({ type: 'setup', step: 'ready', complete: true });
    go('live');
  });

  $('signals').addEventListener('click', event => {
    const button = event.target.closest('[data-signal]');
    if (button && !button.disabled) touch_signal(button.dataset.signal);
  });
  $('draft-send').addEventListener('click', () => touch_draft(true));
  $('draft-discard').addEventListener('click', () => touch_draft(false));
  $('live-acknowledge').addEventListener('click', touch_receipt);
  $('sim-room').addEventListener('submit', event => {
    event.preventDefault();
    const field = $('sim-text');
    const text = field.value.trim();
    if (!text || !is_sim()) return;
    if (send({ type: 'sim_transcript', text })) field.value = '';
    else show_note('Hub unreachable. Transcript not sent.');
  });
  for (const button of document.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => go(button.dataset.go));
  }

  for (const radio of document.querySelectorAll('input[name="settings_mode"]')) {
    radio.addEventListener('change', () => set_earbud_model(radio.value));
  }
  $('settings-drafts').addEventListener('change', event => {
    settings.drafts = event.target.checked;
    save_settings();
    send({ type: 'configure', mode: settings.mode, drafts: settings.drafts });
  });
  $('settings-listen').addEventListener('change', event => {
    if (event.target.checked) {
      if (!has_consent('room')) {
        event.target.checked = false;
        ui.voice_from = 'settings';
        go('voice');
        return;
      }
      set_lock_controls(false, { restore_mic: false });
      arm_media();
      void start_mic();
    } else {
      stop_mic();
    }
  });
  for (const name of ['cue', 'voice']) {
    $('settings-volume-' + name).addEventListener('input', event => {
      settings.volumes[name] = Number(event.target.value);
      audio.configure({ volumes: settings.volumes });
      save_settings();
      set_text($('settings-volume-' + name + '-value'), Math.round(settings.volumes[name] * 100) + '%');
    });
  }
  $('settings-voice').addEventListener('click', () => {
    ui.voice_from = 'settings';
    ui.voice_message = '';
    go('voice');
  });
  $('settings-voice-preview').addEventListener('click', () => {
    if (my_state()?.voice !== 'ready') {
      set_issue('voice', 'This seat does not have a verified clone yet.');
      return;
    }
    set_issue('voice', '');
    void audio.unlock();
    if (!send({ type: 'voice_preview' })) set_issue('voice', 'Connect to the hub to hear the preview.');
  });
  $('settings-room-invite').addEventListener('click', () => {
    if (!send({ type: 'room_mic_invite' })) set_text($('settings-room-status'), 'Connect to the hub first.');
  });
  $('settings-room-link').addEventListener('focus', event => event.target.select());
  $('settings-calibrate').addEventListener('click', () => go('calibrate', { from: 'settings' }));

  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || !ui.seat) return;
    if (!is_sim() && ui.screen === 'live' && !calibration.active() && Object.hasOwn(CLICKER_KEYS, event.key)) {
      if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      on_signal(CLICKER_KEYS[event.key]);
      return;
    }
    if (event.target instanceof HTMLInputElement && ['text', 'number'].includes(event.target.type)) return;
    const action = RAW_KEYS[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    if (is_sim()) {
      emulator.gesture(action);
    } else {
      calibration.mark_manual();
      input.dispatch(action);
    }
  });

  document.addEventListener('pointerdown', () => {
    if (!ui.armed) return;
    if (!audio.running) void audio.unlock();
    if (keepalive.paused && !ui.earbud_out) resume_anchor();
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    input.flushAirPods1IfDue();
    void acquire_wake_lock();
    void audio.resume();
    if (ui.listen_wanted && !capture.open && !is_sim()) void start_mic();
    if (ui.seat && !connection && !ui.issues.get('connection')?.action) connect();
    schedule_render();
  });
}

function start() {
  build_settings_groups();
  bind_events();
  setInterval(sample_output, 250).unref?.();
  void probe_hub();
  if (DIRECT_CALIBRATION) {
    const seat = QUERY.get('seat');
    if (SEAT_NAMES.includes(seat)) {
      if (settings.seat !== seat) settings.setup = fresh_setup();
      settings.seat = seat;
      ui.seat = seat;
      save_settings();
      connect();
    }
    go('calibrate', { from: 'direct' });
    return;
  }
  go('join');
}

start();
