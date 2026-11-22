// Room mic page: captures the MacBook microphone, streams 16 kHz PCM to the hub,
// and shows the hub's diarized transcripts split into Seat A and Seat B.

const $ = id => document.getElementById(id);
const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

const WORKLET = `
class RoomTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('room-tap', RoomTap);
`;

let socket = null;
let state = { status: 'off', speakers: [], lines: [], level: 0 };
let capture = null;
let reconnect_ms = 600;

function send(frame) {
  if (socket?.readyState !== 1) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function to_base64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Linear resample from the context rate to 16 kHz when the browser ignored the requested rate.
function resampler(from_rate) {
  const ratio = from_rate / 16000;
  let carry = new Float32Array(0);
  let position = 0;
  return input => {
    const data = new Float32Array(carry.length + input.length);
    data.set(carry);
    data.set(input, carry.length);
    const out = [];
    while (position + 1 < data.length) {
      const index = Math.floor(position);
      const frac = position - index;
      out.push(data[index] * (1 - frac) + data[index + 1] * frac);
      position += ratio;
    }
    const keep = Math.floor(position);
    carry = data.slice(keep);
    position -= keep;
    return Float32Array.from(out);
  };
}

async function start_capture() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  let context;
  try { context = new AudioContext({ sampleRate: 16000 }); } catch { context = new AudioContext(); }
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'room-tap');
  const resample = context.sampleRate === 16000 ? x => x : resampler(context.sampleRate);
  let buffer = new Float32Array(0);
  node.port.onmessage = ({ data }) => {
    const samples = resample(data);
    const next = new Float32Array(buffer.length + samples.length);
    next.set(buffer);
    next.set(samples, buffer.length);
    buffer = next;
    while (buffer.length >= FRAME_SAMPLES) {
      const frame = buffer.subarray(0, FRAME_SAMPLES);
      buffer = buffer.slice(FRAME_SAMPLES);
      const pcm = new Int16Array(FRAME_SAMPLES);
      let sum = 0;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const value = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
        sum += value * value;
      }
      const level = Math.min(1, Math.sqrt(sum / FRAME_SAMPLES) * 4);
      $('meter').style.width = Math.round(level * 100) + '%';
      send({ type: 'room_split_audio', audio: to_base64(pcm), level });
    }
  };
  source.connect(node);
  await context.resume();
  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach(track => track.stop());
      void context.close();
      $('meter').style.width = '0%';
    },
  };
}

async function toggle() {
  const button = $('toggle');
  if (capture) {
    capture.stop();
    capture = null;
    send({ type: 'room_split', action: 'stop' });
    render();
    return;
  }
  button.disabled = true;
  try {
    capture = await start_capture();
    send({ type: 'room_split', action: 'start' });
  } catch (error) {
    set_status('error', 'Microphone: ' + (error?.message || error?.name || 'unavailable'));
  }
  button.disabled = false;
  render();
}

function set_status(kind, text) {
  $('status').dataset.state = kind;
  $('status-text').textContent = text;
}

const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function render() {
  const labels = { off: 'Off', connecting: 'Connecting to ElevenLabs…', live: 'Listening · ' + (state.model ?? ''), error: 'Error' };
  set_status(state.status, state.status === 'error' && state.detail ? 'Error · ' + state.detail : labels[state.status] ?? state.status);
  $('toggle').textContent = capture ? 'Stop listening' : 'Start listening';
  $('toggle').classList.toggle('primary', !capture);

  const speakers = $('speakers');
  speakers.replaceChildren(...state.speakers.map(speaker => {
    const card = document.createElement('div');
    card.className = 'speaker';
    const name = document.createElement('b');
    name.textContent = speaker.id.replace('speaker_', 'Voice ') + ' · ' + speaker.words + ' words';
    const last = document.createElement('p');
    last.textContent = speaker.last ? '“' + speaker.last + '”' : '…';
    const row = document.createElement('div');
    row.className = 'row';
    for (const seat of ['A', 'B', null]) {
      const button = document.createElement('button');
      button.textContent = seat ? 'Seat ' + seat : 'Ignore';
      button.dataset.seat = seat ?? '';
      button.setAttribute('aria-pressed', String(speaker.seat === seat));
      button.addEventListener('click', () => send({ type: 'room_split', action: 'assign', speaker: speaker.id, seat }));
      row.append(button);
    }
    card.append(name, last, row);
    return card;
  }));

  for (const seat of ['A', 'B', null]) {
    const list = $(seat ? 'lane-' + seat : 'lane-none');
    const lines = state.lines.filter(line => line.seat === seat);
    if (!lines.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = seat ? 'Nothing yet.' : '';
      list.replaceChildren(...(seat ? [empty] : []));
    } else {
      list.replaceChildren(...lines.map(line => {
        const item = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = clock(line.at) + (line.speaker ? ' · ' + line.speaker.replace('speaker_', 'voice ') : '');
        item.append(time, document.createTextNode(line.text));
        return item;
      }));
    }
    if (!seat) $('unassigned-wrap').hidden = !lines.length;
  }
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const next = new WebSocket(scheme + '//' + location.host + '/ws?role=stage');
  socket = next;
  next.addEventListener('open', () => {
    reconnect_ms = 600;
    if (capture) send({ type: 'room_split', action: 'start' });
  });
  next.addEventListener('message', event => {
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    if (frame?.type === 'room_split' && frame.room) {
      state = frame.room;
      render();
    }
  });
  next.addEventListener('close', () => {
    if (socket !== next) return;
    set_status('error', 'Hub offline. Reconnecting…');
    setTimeout(connect, reconnect_ms);
    reconnect_ms = Math.min(8000, reconnect_ms * 1.6);
  });
}

$('toggle').addEventListener('click', () => void toggle());
$('swap').addEventListener('click', () => send({ type: 'room_split', action: 'swap' }));
$('clear').addEventListener('click', () => send({ type: 'room_split', action: 'clear' }));
render();
connect();
