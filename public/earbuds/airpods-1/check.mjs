const audio = document.getElementById('check-audio');
const start = document.getElementById('check-start');
const stop = document.getElementById('check-stop');
const status = document.getElementById('check-status');
const count = document.getElementById('check-count');
let received = 0;

function showPlayback() {
  start.hidden = !audio.paused;
  stop.hidden = audio.paused;
  if (navigator.mediaSession) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function play() {
  return audio.play().catch(() => {
    status.textContent = 'Safari could not start the test sound. Tap Start test sound again.';
  });
}

start.addEventListener('click', () => {
  const media = navigator.mediaSession;
  if (!media) {
    status.textContent = 'This browser does not expose media controls.';
    return;
  }
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (globalThis.MediaMetadata) media.metadata = new MediaMetadata({ title: 'Telepathy AirPods check' });
    media.setActionHandler('nexttrack', () => {
      if (audio.paused) return;
      count.textContent = 'Next Track received: ' + ++received;
      status.textContent = 'Safari sent Next Track to this page.';
    });
  } catch {
    status.textContent = 'Safari did not accept a Next Track handler.';
    return;
  }
  for (const [action, handler] of [['pause', () => audio.pause()], ['play', play]]) {
    try { media.setActionHandler(action, handler); } catch {}
  }
  status.textContent = 'Listen for the test cue. Now Playing should say Telepathy AirPods check.';
  void play();
});

stop.addEventListener('click', () => audio.pause());
audio.addEventListener('playing', showPlayback);
audio.addEventListener('pause', showPlayback);
