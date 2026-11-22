import { createAirPodsProInput } from './input.mjs';

const byId = id => document.getElementById(id);
const audio = byId('check-audio');
const start = byId('check-start');
const stop = byId('check-stop');
const status = byId('check-status');
const labels = { R1: 'Single squeeze', R2: 'Double squeeze', L1: 'Triple squeeze' };
const counts = { R1: 0, R2: 0, L1: 0 };
let armed = false;
const input = createAirPodsProInput({
  now: () => performance.now(),
  onSignal(signal, [event]) {
    byId('check-' + signal).textContent = labels[signal] + ': ' + ++counts[signal];
    status.textContent = 'Safari sent ' + event.action + '.';
  },
});

function showPlayback() {
  start.hidden = !audio.paused;
  stop.hidden = audio.paused;
  if (navigator.mediaSession) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

start.addEventListener('click', () => {
  const media = navigator.mediaSession;
  if (!media) {
    status.textContent = 'This browser does not expose media controls.';
    return;
  }
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  if (globalThis.MediaMetadata) media.metadata = new MediaMetadata({ title: 'Telepathy AirPods Pro check' });
  const missing = [];
  for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
    try {
      media.setActionHandler(action, () => {
        if (armed) input.receive(action);
      });
    } catch {
      missing.push(action);
    }
  }
  status.textContent = missing.length ? 'Unavailable controls: ' + missing.join(', ') + '.'
    : 'Now Playing should say Telepathy AirPods Pro check.';
  armed = true;
  void audio.play().catch(() => {
    armed = false;
    status.textContent = 'Safari could not start the test sound. Tap Start test sound again.';
  });
});

stop.addEventListener('click', () => {
  armed = false;
  audio.pause();
});
audio.addEventListener('playing', showPlayback);
audio.addEventListener('pause', showPlayback);
