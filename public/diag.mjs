// Opt-in phone diagnostics. Open the join page with ?diag=1 and every media,
// microphone and audio-session event is forwarded to the hub, which appends it
// to .runtime/diag.log. Off by default; nothing here runs without the flag.

const ENABLED = new URLSearchParams(location.search).get('diag') === '1';
// Seek handlers are left out on purpose: registering them makes iOS swap the
// Next/Previous Track commands for seeking, which would change what squeezes send.
const EXTRA_ACTIONS = ['stop', 'togglemicrophone', 'togglecamera', 'hangup'];
const queue = [];
let sender = null;
const t0 = performance.now();

function flush() {
  while (sender && queue.length) {
    if (!sender({ type: 'diag', ...queue[0] })) return;
    queue.shift();
  }
}

export function diag(kind, data = {}) {
  if (!ENABLED) return;
  queue.push({ kind, t: Math.round(performance.now() - t0), ...data });
  if (queue.length > 500) queue.shift();
  flush();
}

function session_info() {
  const session = navigator.audioSession;
  return { audioSession: session?.type ?? null, audioSessionState: session?.state ?? null };
}

function watch_track(track) {
  const info = () => ({ label: track.label, muted: track.muted, enabled: track.enabled, state: track.readyState, ...session_info() });
  diag('track_open', info());
  for (const name of ['mute', 'unmute', 'ended']) track.addEventListener(name, () => diag('track_' + name, info()));
}

export function installDiag({ send, keepalive }) {
  if (!ENABLED) return;
  sender = send;
  setInterval(flush, 1000);

  diag('hello', { ua: navigator.userAgent, ...session_info() });

  const devices = navigator.mediaDevices;
  if (devices?.getUserMedia) {
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => {
      diag('gum_request', session_info());
      try {
        const stream = await original(constraints);
        stream.getAudioTracks().forEach(watch_track);
        devices.enumerateDevices?.().then(list => diag('inputs', {
          inputs: list.filter(d => d.kind === 'audioinput').map(d => d.label || '(unlabelled)'),
        })).catch(() => {});
        return stream;
      } catch (error) {
        diag('gum_error', { name: error?.name, message: error?.message });
        throw error;
      }
    };
  }

  navigator.audioSession?.addEventListener?.('statechange', () => diag('audio_session', session_info()));

  for (const name of ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error']) {
    keepalive?.addEventListener(name, () => diag('keepalive_' + name, { paused: keepalive.paused }));
  }

  document.addEventListener('visibilitychange', () => diag('visibility', { state: document.visibilityState }));
  window.addEventListener('error', event => diag('page_error', { message: event.message }));
  window.addEventListener('unhandledrejection', event => diag('page_rejection', { message: String(event.reason?.message ?? event.reason) }));
}

// Called after the app registers its own Media Session handlers, so the extra
// actions show whether iOS sends anything other than play/pause/next/previous.
export function registerExtraActions() {
  if (!ENABLED || !navigator.mediaSession) return;
  for (const action of EXTRA_ACTIONS) {
    try {
      navigator.mediaSession.setActionHandler(action, details => diag('media_extra', { action, details: details?.action }));
    } catch {
      diag('media_extra_unsupported', { action });
    }
  }
}

export const DIAG_ENABLED = ENABLED;
