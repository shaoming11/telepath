import { createCapture } from './capture.mjs';

const seat = document.getElementById('room-seat');
const start = document.getElementById('room-start');
const stop = document.getElementById('room-stop');
const status = document.getElementById('room-status');
const params = new URLSearchParams(location.search);
const token = params.get('token');
const paired = token && ['A', 'B'].includes(params.get('seat'));
if (paired) {
  seat.value = params.get('seat');
  seat.disabled = true;
}
let socket;
let context;
let scope;
let active = false;
let started = false;

const capture = createCapture({
  get_context: () => context,
  frame_ms: () => 250,
  on_frame(frame) {
    if (active && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 192_000) {
      socket.send(JSON.stringify({ type: 'mic', ...scope, ...frame }));
    }
  },
  on_state(state, detail) {
    if (['blocked', 'unsupported', 'error', 'lost'].includes(state)) end(detail);
  },
});

function end(message) {
  const connection = socket;
  socket = null;
  active = false;
  started = false;
  scope = null;
  capture.stop();
  connection?.close();
  start.hidden = false;
  stop.hidden = true;
  seat.disabled = Boolean(paired);
  status.textContent = message ?? 'Room microphone stopped.';
}

start.addEventListener('click', async () => {
  if (socket) return;
  context ??= new AudioContext();
  void context.resume().catch(() => {});
  start.hidden = true;
  stop.hidden = false;
  seat.disabled = true;
  status.textContent = 'Connecting to the hub…';
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', 'room-mic');
  url.searchParams.set('seat', seat.value);
  if (paired) url.searchParams.set('token', token);
  const connection = socket = new WebSocket(url);
  const permission = capture.start();
  connection.addEventListener('message', async ({ data }) => {
    if (socket !== connection) return;
    const state = JSON.parse(data);
    if (state.type !== 'room_mic_state') return;
    if (!state.available) return end('Join that seat on the primary phone before starting the room mic.');
    if (scope && scope.sessionId !== state.sessionId) return end('Session reset. Open a fresh room mic link.');
    if (!scope) {
      scope = { hubId: state.hubId, sessionId: state.sessionId };
      if (!await permission || socket !== connection) return;
      connection.send(JSON.stringify({ type: 'listen', enabled: true, ...scope }));
      return;
    }
    active = state.active;
    if (!active && started) return end('Room transcription stopped.');
    if (!active && state.transcription === 'unavailable') return end('Room transcription is unavailable.');
    started ||= active;
    status.textContent = active ? 'Room mic active for Seat ' + seat.value + '.' : 'Starting room transcription…';
  });
  connection.addEventListener('close', () => {
    if (socket === connection) end('Room mic connection closed. Open a fresh room mic link from Telepathy.');
  });
});

stop.addEventListener('click', () => end());
