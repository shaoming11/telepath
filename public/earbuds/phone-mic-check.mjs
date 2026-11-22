const byId = id => document.getElementById('route-' + id);
const audio = byId('audio');
const status = byId('status');
const devices = byId('device');
const start = byId('mic');
const stop = byId('stop');
let stream = null;
let playback_events = 0;
let recording_events = 0;

function category(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
}

byId('play').addEventListener('click', async () => {
  if (!navigator.mediaSession) {
    status.textContent = 'Safari media controls are unavailable.';
    return;
  }
  if (!stream) category('playback');
  if (globalThis.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: 'Telepath mic route check' });
  for (const action of ['nexttrack', 'previoustrack', 'pause', 'play']) {
    try {
      navigator.mediaSession.setActionHandler(action, () => {
        if (stream?.getAudioTracks().some(track => track.readyState === 'live' && !track.muted)) recording_events++;
        else playback_events++;
        byId('events').textContent = 'Playback only: ' + playback_events + ' · While mic active: ' + recording_events;
        byId('last').textContent = 'Safari received ' + action + '.';
      });
    } catch {}
  }
  try { await audio.play(); } catch { status.textContent = 'Safari could not start playback.'; }
});

byId('list').addEventListener('click', async () => {
  if (stream) return;
  let probe;
  try {
    let inputs = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput');
    if (!inputs.some(item => item.label)) {
      probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput');
    }
    devices.replaceChildren(...inputs.filter(item => item.deviceId).map((item, i) => {
      const option = document.createElement('option');
      option.value = item.deviceId;
      option.textContent = item.label || 'Microphone ' + (i + 1);
      return option;
    }));
    const builtin = [...devices.options].find(option => /iphone|built.in|internal/i.test(option.textContent));
    if (builtin) devices.value = builtin.value;
    devices.disabled = start.disabled = !devices.options.length;
    status.textContent = builtin ? 'Built-in mic selected. Start it while playback is active.'
      : 'Choose your iPhone microphone if Safari lists it here.';
  } catch {
    status.textContent = 'Safari could not list microphone inputs.';
  } finally {
    probe?.getTracks().forEach(track => track.stop());
    category('playback');
  }
});

start.addEventListener('click', async () => {
  if (stream || !devices.value) return;
  start.disabled = devices.disabled = true;
  category('play-and-record');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: devices.value } } });
    const track = stream.getAudioTracks()[0];
    status.textContent = 'Active mic: ' + (track.label || 'Safari did not report a label') + '. Try a gesture now.';
    stop.hidden = false;
  } catch {
    start.disabled = devices.disabled = false;
    status.textContent = 'Safari could not open that mic. Try Audio Input in Control Center.';
    category('playback');
  }
});

function stopMic() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  category('playback');
}

stop.addEventListener('click', () => {
  stopMic();
  start.disabled = devices.disabled = false;
  stop.hidden = true;
  status.textContent = 'Microphone off.';
  void audio.play().catch(() => {});
});
window.addEventListener('pagehide', stopMic);
