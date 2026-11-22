import { createEmulator, createMediaInput, DEFAULT_EMULATOR, DEFAULT_TIMING, touchSettings } from './input.mjs';
import { createNetworkLink, DEFAULT_NETWORK } from './network.mjs';
import { createCapture } from './capture.mjs';
import { createCalibration } from './calibrate.mjs';
import { createAudioEngine, createDraftTracker } from './phone-audio.mjs';
import {
  APP_TIMING, APP_TIMING_LIMITS, CONSENT_KEY, CONSENT_TEXT, DEFAULT_VOLUMES, PATTERN_LABELS, PRESETS,
  SEAT_NAMES, SIGNAL_LABELS, SIGNAL_ORDER, STORAGE_KEY, SYSTEM_MEANINGS, VOICE_SCRIPT,
} from './phone-data.mjs';

const QUERY = new URLSearchParams(location.search);
const DIRECT_CALIBRATION = QUERY.get('calibrate') === '1';
const RAW_KEYS = Object.freeze({ r: 'nexttrack', l: 'previoustrack', o: 'pause', i: 'play' });
const SETUP_ORDER = Object.freeze(['voice', 'earbuds', 'calibrate', 'preset']);
const SUB_SCREENS = new Set(['codebook', 'log', 'settings']);
const USABLE_VOICES = new Set(['ready', 'fallback']);
const LOG_KINDS = new Set(['message', 'receipt', 'back', 'draft', 'confirm', 'discard', 'preset']);
const ISSUE_ORDER = Object.freeze(['connection', 'secure', 'mic', 'media', 'context', 'cache', 'cues', 'playback', 'voice']);
const PHASE_LABELS = Object.freeze({ lobby: 'Waiting for stage', live: 'Live', reveal: 'Reveal' });
const NOTE_MS = 4200;
const PROBE_FAILURES_TO_RECONNECT = 2;
const SOCKET_OPEN = 1;
const SOCKET_MOVED = 4001;
const SCOPED_FRAMES = new Set([
  'signal', 'heard', 'cache_ready', 'voice', 'mic', 'setup', 'listen', 'configure', 'preset', 'calibration', 'sim_transcript',
]);

const $ = id => document.getElementById(id);
const fresh_setup = () => ({ voice: false, voice_kind: null, earbuds: false, calibrated: false, ready: false });

let persisted_input = 'real';
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
  voice_task: null,
  voice_message: '',
  pending_voice: null,
  calibration_from: 'settings',
  voice_from: 'setup',
  selected_preset: null,
  failed_manifest: null,
  last_profile_json: settings.profile ? JSON.stringify(settings.profile) : '',
  last_in_id: null,
  last_out_id: null,
  draft_id: null,
  signals_key: '',
  render_frame: 0,
  signal_count: 0,
  wake_lock: null,
};

let connection = null;
const gesture_scopes = new Map();
const awaiting_signal_ack = new Map();
const SIGNAL_ACK_MS = 1800;

const keepalive = $('keepalive');

const input = createMediaInput({
  mode: settings.mode,
  timing: settings.timing,
  onSignal: on_signal,
  onRaw: on_raw,
  onError: on_pattern_error,
  onPlay: on_media_play,
});
const emulator = createEmulator({ input, settings: settings.emulator });
const touch_emulator = createEmulator({ input, settings: touch_profile() });

const audio = createAudioEngine({
  volumes: settings.volumes,
  timing: settings.app,
  on_status: ({ key, text }) => set_issue(key, text),
  on_heard: message_id => send({ type: 'heard', messageId: message_id }),
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
  get_seat: () => ui.seat,
  is_sim,
  arm: arm_media,
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
  return {
    seat: SEAT_NAMES.includes(saved.seat) ? saved.seat : null,
    input_mode,
    mode: saved.mode === 1 ? 1 : 2,
    drafts: saved.drafts !== false,
    volumes: { ...DEFAULT_VOLUMES, ...saved.volumes },
    timing: { ...DEFAULT_TIMING, ...saved.timing },
    emulator: { ...DEFAULT_EMULATOR, ...saved.emulator },
    network: { ...DEFAULT_NETWORK, enabled: input_mode === 'sim', ...saved.network },
    app: { ...APP_TIMING, ...saved.app },
    profile: saved.profile ?? null,
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

function has_consent() {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

function set_consent(granted) {
  try {
    if (granted) sessionStorage.setItem(CONSENT_KEY, '1');
    else sessionStorage.removeItem(CONSENT_KEY);
  } catch {}
}

function set_text(element, text) {
  if (element.textContent !== text) element.textContent = text;
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
    draftId: drafts.can_approve(pending) ? pending.id : null,
    previewWaiting: drafts.visible(pending) && pending.heardAt == null,
    receiptId: receipt && (ui.receipt_deadline ?? 0) >= performance.now() ? receipt.messageId : null,
  };
}

function on_raw(event) {
  calibration.note_raw(event);
  gesture_scopes.set(event.action + ':' + event.at, gesture_scope());
  if (gesture_scopes.size > 32) gesture_scopes.delete(gesture_scopes.keys().next().value);
  if (event.action !== 'pause') return;
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

function on_signal(signal, trace) {
  if (calibration.active()) {
    calibration.note_signal(signal);
    return;
  }
  if (signal === 'OUT') ui.earbud_out = true;
  if (signal === 'BACK') ui.earbud_out = false;
  flash_signal(signal);
  schedule_render();
  if (!is_online()) {
    audio.play_cue('error');
    show_note('Hub unreachable. Signal not sent.');
    return;
  }
  const first = trace?.[0];
  const scope = (first && gesture_scopes.get(first.action + ':' + first.at)) ?? gesture_scope();
  if (signal === 'R1' && scope.previewWaiting && !scope.receiptId) {
    show_note('Wait for the preview before sending.');
    return;
  }
  ui.signal_count += 1;
  const id = ui.seat + '-' + Date.now().toString(36) + '-' + ui.signal_count;
  const { previewWaiting, ...intent } = scope;
  if (!send({ type: 'signal', signal, id, ...intent })) {
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
  if (signal === 'BACK') resume_anchor();
  touch_emulator.configure(touch_profile());
  touch_emulator.signal(signal, settings.mode);
}

function set_playback_state(state) {
  try {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = state;
  } catch {}
}

function resume_anchor() {
  const playing = keepalive.play();
  set_playback_state('playing');
  playing?.then?.(() => {
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
  if (media_session && globalThis.MediaMetadata) {
    media_session.metadata = new MediaMetadata({
      title: 'Telepathy', artist: ui.seat ? 'Seat ' + ui.seat : 'Seat',
    });
  }
  void audio.preload_cues();
  if (!ui.earbud_out) resume_anchor();
  ui.armed = true;
  const works = registered.includes('nexttrack') && registered.includes('previoustrack');
  if (is_sim() || works) {
    if (!ui.issues.get('media')?.anchor) set_issue('media', '');
  } else {
    set_issue('media', 'This browser did not accept earbud controls. Use the buttons on Live.');
  }
  void acquire_wake_lock();
}

async function acquire_wake_lock() {
  if (!navigator.wakeLock || document.visibilityState !== 'visible' || ui.wake_lock) return;
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
      if (frame.kind === 'announcement' && (!source.synced || ui.state?.canned || ui.state?.phase === 'reveal')) return;
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
    case 'voice_status': return is_stale_frame(frame) ? undefined : on_voice_status(frame);
    case 'calibration': return is_stale_frame(frame) ? undefined : receive_profile(frame.profile);
    default: return undefined;
  }
}

function on_state(next, source) {
  const previous = ui.state;
  ui.state = next;
  const new_session = previous && (previous.sessionId !== next.sessionId || previous.hubId !== next.hubId);
  if (new_session) {
    audio.clear_session();
    drafts.reset();
    input.reset();
    clear_signal_tracking();
    ui.pending_voice = null;
  }
  const receipt = my_state()?.receipt;
  ui.receipt_deadline = receipt
    ? performance.now() + Math.max(0, receipt.until - (next.serverNow ?? Date.now()))
    : null;
  drafts.observe(next.seats?.[ui.seat]?.pending ?? null);
  if (next.roomInput === 'mac' && !ui.voice_task && (capture.open || capture.opening || ui.listen_wanted)) stop_mic();
  if (next.phase === 'reveal' && previous?.phase !== 'reveal' || next.canned && !previous?.canned) {
    audio.cancel_previews();
    audio.cancel_announcements();
    ui.pending_voice = null;
    ui.mic_on_next_take ||= ui.listen_wanted;
    if (capture.open || capture.opening || ui.listen_wanted) stop_mic();
  }
  if (!source.synced || new_session || previous?.sessionId !== next.sessionId) reconcile(next, source);
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

function on_voice_status({ status, detail }) {
  const messages = {
    building: 'Building your voice clone in the background.',
    ready: detail || 'Your voice clone is ready.',
    fallback: detail || 'Using the premade voice.',
    error: detail || 'The voice clone failed.',
  };
  ui.voice_message = messages[status] ?? '';
  if (status === 'error') {
    set_issue('voice', 'The voice clone failed.', 'Use premade', () => {
      ui.pending_voice = null;
      send({ type: 'setup', step: 'voice', complete: true, fallback: true });
      settings.setup.voice = true;
      settings.setup.voice_kind = 'premade';
      save_settings();
      set_issue('voice', '');
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

async function start_mic({ recording = false } = {}) {
  if ((!ui.state || ui.state.roomInput === 'mac') && !recording) return false;
  if (is_sim() || !has_consent() || ui.state?.phase === 'reveal' || ui.state?.canned) return false;
  ui.listen_wanted = true;
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
  if (!is_sim() && has_consent()) void start_mic();
  go(next_setup_screen(), { from: 'setup' });
}

function set_input_mode(mode) {
  if (settings.input_mode === mode) return;
  settings.input_mode = mode;
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
  if (kind === 'premade') ui.pending_voice = null;
  if (kind !== 'clone') send({ type: 'setup', step: 'voice', complete: true, ...(kind === 'premade' && { fallback: true }) });
  if (from === 'settings') go('settings');
  else go(next_setup_screen(), { from: 'setup' });
}

function set_voice_progress(fraction) {
  $('voice-bar').style.transform = 'scaleX(' + fraction + ')';
}

async function record_sample(kind) {
  arm_media();
  ui.voice_task = kind;
  if (!(await start_mic({ recording: true }))) {
    ui.voice_task = null;
    ui.voice_message = 'The microphone is not available. Use the premade voice to continue.';
    render();
    return;
  }
  ui.voice_task = kind;
  const duration_ms = kind === 'clone' ? settings.app.voiceSampleMs : settings.app.roomSampleMs;
  ui.voice_message = kind === 'clone' ? 'Recording. Read at a normal pace.' : 'Sampling the room. No voice clone is made.';
  render();
  try {
    const result = await capture.record({ duration_ms, on_progress: set_voice_progress });
    ui.voice_task = null;
    set_voice_progress(0);
    if (kind === 'clone') {
      const frame = { wav: result.wav, requestId: 'voice-' + ui.seat + '-' + Date.now().toString(36) };
      if (!send({ type: 'voice', ...frame })) ui.pending_voice = frame;
      finish_voice('clone');
    } else {
      ui.voice_message = 'Room sample streamed.';
      finish_voice('room');
    }
  } catch (error) {
    ui.voice_task = null;
    set_voice_progress(0);
    ui.voice_message = error?.message === 'Recording cancelled.' ? '' : 'The recording stopped early. Try again.';
    render();
  } finally {
    if (ui.state?.roomInput === 'mac') stop_mic();
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
  const key = ISSUE_ORDER.find(name => ui.issues.has(name));
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
  const consent = has_consent();
  const busy = Boolean(ui.voice_task);
  const mine = my_state();
  set_text($('voice-step'), ui.voice_from === 'settings' ? 'Settings' : '1 / 4');
  set_text($('voice-consent-text'), CONSENT_TEXT);
  set_text($('voice-script'), VOICE_SCRIPT);
  $('voice-consent-row').hidden = sim;
  $('voice-consent').checked = consent;
  $('voice-consent').disabled = busy;
  const record = $('voice-record');
  record.hidden = sim || busy;
  record.disabled = !consent || mine?.voice === 'building';
  set_text(record, 'Read for ' + Math.round(settings.app.voiceSampleMs / 1000) + ' seconds');
  const room = $('voice-room');
  room.hidden = sim || busy;
  room.disabled = !consent;
  set_text(room, 'Room sample only, ' + Math.round(settings.app.roomSampleMs / 1000) + ' s');
  $('voice-cancel').hidden = !busy;
  $('voice-skip').hidden = busy;
  set_text($('voice-skip'), ui.voice_from === 'settings' && USABLE_VOICES.has(mine?.voice) ? 'Keep the current voice' : 'Use the premade voice');
  $('voice-skip').disabled = mine?.voice === 'building';
  const fallback = sim ? 'Simulated seat. The microphone stays closed.'
    : !consent ? 'Tick the consent line to open the microphone.'
    : capture.open ? 'Microphone on. Read when ready.' : '';
  set_text($('voice-status'), ui.voice_message || fallback);
}

function render_earbuds() {
  for (const radio of document.querySelectorAll('input[name="earbud_mode"]')) {
    radio.checked = Number(radio.value) === settings.mode;
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
  const order = SIGNAL_ORDER[settings.mode];
  const host = $('signals');
  const key = settings.mode + JSON.stringify(codebook);
  if (ui.signals_key !== key) {
    ui.signals_key = key;
    host.replaceChildren(...order.map(signal => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'signal';
      button.dataset.signal = signal;
      if (signal === 'LR' && settings.mode === 2) button.dataset.wide = 'true';
      const name = document.createElement('b');
      name.textContent = SIGNAL_LABELS[signal];
      const meaning = document.createElement('span');
      meaning.textContent = codebook[signal] ?? SYSTEM_MEANINGS[signal] ?? '';
      button.append(name, meaning);
      button.setAttribute('aria-label', SIGNAL_LABELS[signal] + ': ' + meaning.textContent);
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
  if (!pending) {
    ui.draft_id = null;
    return;
  }
  // R1 only approves what the sender has heard, so the control waits for the hub to report the preview.
  $('draft-send').disabled = !drafts.can_approve(pending);
  const is_preset = pending.kind === 'preset';
  set_text($('live-draft-label'), is_preset ? 'Switch preset?' : 'Send this?');
  set_text($('live-draft-text'), pending.text ?? '');
  set_text($('draft-send'), is_preset ? 'R1 Switch' : 'R1 Send');
  set_text($('draft-discard'), settings.mode === 1 ? 'R2 Discard' : 'L1 Discard');
  if (ui.draft_id === pending.id) return;
  ui.draft_id = pending.id;
  const clock = $('live-draft-clock');
  const duration = Number(pending.expiresAt) - Number(pending.decisionAt);
  clock.style.transition = 'none';
  clock.style.transform = 'scaleX(1)';
  void clock.offsetWidth;
  clock.style.transition = 'transform ' + (Number.isFinite(duration) && duration > 0 ? duration : 6000) + 'ms linear';
  clock.style.transform = 'scaleX(0)';
}

function render_live() {
  const state = ui.state;
  const mine = my_state();
  const partner = state?.seats?.[partner_seat()];
  const preset = state?.preset ?? 'Pitch';
  set_text($('live-preset'), state?.presetPending && state.presetPending !== preset ? preset + ' to ' + state.presetPending : preset);
  const phase = state?.phase ?? 'lobby';
  $('live-phase').dataset.phase = phase;
  set_text($('live-phase'), state?.canned ? 'Canned take' : PHASE_LABELS[phase] ?? '');
  set_text($('live-partner'), partner?.online ? (partner.ready ? 'Ready' : 'Connected') : 'Offline');

  const listen = $('live-listen');
  // Old hubs omit `transcription`. Otherwise "Listening" means the room is actually being transcribed.
  const transcribing = mine?.transcription == null || mine.transcription === 'live';
  const listening = !is_sim() && capture.open && mine?.listening && transcribing;
  listen.dataset.state = state?.roomInput === 'mac' ? state.room?.transcription === 'live' ? 'on' : 'off' : is_sim() ? 'sim' : listening ? 'on' : 'off';
  set_text($('live-listen-text'), state?.roomInput === 'mac' ? state.room?.transcription === 'live' ? 'Mac listening' : 'Mac mic ' + (state.room?.transcription ?? 'off')
    : is_sim() ? 'Simulated' : listening ? 'Listening' : capture.open ? 'Mic only' : 'Mic off');
  set_text($('live-cache'), ui.failed_manifest ? 'Failed' : mine?.ready ? 'Cached' : state?.presetPending ? 'Caching' : 'Not ready');

  render_draft(mine?.pending ?? null);
  render_message('in', mine?.lastIn, 'last_in_id');
  render_message('out', mine?.lastOut, 'last_out_id');
  set_text($('live-note'), ui.note);
  render_signals();
  $('sim-room').hidden = !is_sim();
}

function render_codebook() {
  const codebook = ui.state?.codebook ?? {};
  const preset = ui.state?.preset ?? 'Pitch';
  set_text($('codebook-context'), preset + ' · ' + (settings.mode === 1 ? 'One earbud' : 'Two earbuds'));
  $('codebook-list').replaceChildren(...SIGNAL_ORDER[settings.mode].map(signal => {
    const row = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = SIGNAL_LABELS[signal];
    const meaning = document.createElement('strong');
    meaning.textContent = codebook[signal] ?? SYSTEM_MEANINGS[signal] ?? '';
    const pattern = document.createElement('small');
    pattern.textContent = PATTERN_LABELS[settings.mode][signal];
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
    radio.checked = Number(radio.value) === settings.mode;
  }
  $('settings-drafts').checked = settings.drafts;
  $('settings-listen-row').hidden = is_sim() || ui.state?.roomInput === 'mac';
  $('settings-listen').checked = capture.open && ui.listen_wanted;
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

function set_mode(mode) {
  if (settings.mode === mode) return;
  settings.mode = mode;
  input.configure({ mode });
  ui.signals_key = '';
  save_settings();
  send({ type: 'configure', mode, drafts: settings.drafts });
  render();
}

function bind_events() {
  $('nav-back').addEventListener('click', go_back);
  keepalive.addEventListener('pause', on_anchor_paused);
  keepalive.addEventListener('playing', () => {
    if (ui.issues.get('media')?.anchor) set_issue('media', '');
  });

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
    radio.addEventListener('change', () => set_mode(Number(radio.value)));
  }
  for (const side of ['left', 'right']) {
    $('test-' + side).addEventListener('click', async () => {
      arm_media();
      set_text($('earbuds-status'), 'Playing ' + side + '.');
      const problem = await audio.test_side(side);
      set_text($('earbuds-status'), problem || 'Played ' + side + '.');
    });
  }
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
  $('draft-send').addEventListener('click', () => touch_signal('R1'));
  $('draft-discard').addEventListener('click', () => touch_signal(settings.mode === 1 ? 'R2' : 'L1'));
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
    radio.addEventListener('change', () => set_mode(Number(radio.value)));
  }
  $('settings-drafts').addEventListener('change', event => {
    settings.drafts = event.target.checked;
    save_settings();
    send({ type: 'configure', mode: settings.mode, drafts: settings.drafts });
  });
  $('settings-listen').addEventListener('change', event => {
    if (event.target.checked) {
      if (!has_consent()) {
        event.target.checked = false;
        ui.voice_from = 'settings';
        go('voice');
        return;
      }
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
  $('settings-calibrate').addEventListener('click', () => go('calibrate', { from: 'settings' }));

  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || !ui.seat) return;
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
