import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { bankFileName, createAudio, STATUS_LINES, STOCK_VOICES } from './audio.mjs';
import { createCodec } from './codec.mjs';
import { createMaritimeCoach } from './maritime.mjs';
import { Session } from './session.mjs';
import { findLanAddress, hotspotIPv6Peers, resolveTLS } from './tls.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../.runtime/', import.meta.url));
const MAX_SOCKET_BACKLOG = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TEST_AUDIO = {
  '/assets/test-left.mp3': bankFileName('assistant', STOCK_VOICES.assistant.id, STATUS_LINES.test_left),
  '/assets/test-right.mp3': bankFileName('assistant', STOCK_VOICES.assistant.id, STATUS_LINES.test_right),
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function audioRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return { start, end };
}

function send(socket, frame) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_SOCKET_BACKLOG) {
    socket.terminate();
    return false;
  }
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch {
    socket.terminate();
    return false;
  }
}

function end(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

export function createHub({
  env = process.env, audio, codec, coach, settings, tls = null,
  lan = env.TELEPATHY_HOST ?? findLanAddress(), localPath = null, ledgerPath,
} = {}) {
  const assets = new Map();
  const seats = new Map();
  const roomMics = new Map();
  const roomInvites = new Map();
  const stage = new Set();
  const ipv6_peer = hotspotIPv6Peers(lan);
  const hub_id = randomUUID();
  let session;
  const speech = audio ?? createAudio({
    assets, env, allowBundledFallback: true, ledgerPath,
    whisperModel: env.TELEPATHY_WHISPER_MODEL ?? 'eleven_v4_turbo',
    onTranscriptionStatus: status => session?.updateTranscriptionStatus?.(status),
  });
  const language = codec ?? createCodec({ env, localPath });
  const maritime = coach === undefined ? createMaritimeCoach({ env }) : coach;
  const scope = frame => frame.type === 'state'
    ? { ...frame, state: { ...frame.state, hubId: hub_id, serverNow: Date.now() } }
    : { sessionId: session.sessionId, ...frame, hubId: hub_id };
  function validRoomInvite(seat, token) {
    const invite = roomInvites.get(seat);
    return Boolean(invite && invite.token === token && invite.sessionId === session.sessionId && invite.expiresAt > Date.now());
  }
  function sendRoomMicState(ws, seat, state) {
    const target = state.seats[seat];
    send(ws, scope({
      type: 'room_mic_state', setupReset: state.setupReset,
      available: target.online && !target.sim && !state.canned && state.phase !== 'reveal',
      active: target.roomMicSource === 'companion' && target.listening,
      transcription: target.transcription,
    }));
  }
  session = new Session({
    emitSeat: (seat, frame) => send(seats.get(seat), scope(frame)),
    emitStage: frame => {
      const speaker = frame.voiceRole ?? frame.key?.split(':')[0];
      const voiced = frame.type === 'audio' && !frame.url && Object.hasOwn(STOCK_VOICES, speaker)
        ? { ...frame, url: '/assets/' + bankFileName(speaker, STOCK_VOICES[speaker].id, frame.text) }
        : frame;
      const tagged = scope(voiced);
      stage.forEach(socket => send(socket, tagged));
      if (frame.type === 'state') roomMics.forEach((socket, seat) => sendRoomMicState(socket, seat, frame.state));
    },
    audio: speech,
    codec: language,
    coach: maritime,
    settings,
  });
  let info = {};

  function respond(req, res, status, mime, value) {
    res.writeHead(status, {
      'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : value);
  }

  async function routes(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(req, res, 405, 'text/plain', 'Use GET.');
    try {
      const request_url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(request_url.pathname);
      if (path === '/info') return respond(req, res, 200, TYPES['.json'], JSON.stringify(info));
      if (path === '/room-mic.html' && !LOOPBACK_PEERS.has(req.socket.remoteAddress)
        && !validRoomInvite(request_url.searchParams.get('seat'), request_url.searchParams.get('token'))) {
        return respond(req, res, 403, 'text/plain', 'Open a room mic invite from Telepathy.');
      }
      if (path === '/telepathy-ca.cer' && tls?.publicRoot) {
        return respond(req, res, 200, 'application/x-x509-ca-cert', tls.publicRoot);
      }
      if (path.startsWith('/assets/')) {
        const dynamic = assets.get(path.slice('/assets/'.length));
        if (dynamic) return respond(req, res, 200, dynamic.mime, dynamic.buffer);
      }
      if (TEST_AUDIO[path]) path = '/assets/' + TEST_AUDIO[path];
      if (path === '/') path = '/index.html';
      if (path === '/stage') path = '/stage.html';
      if (path.split('/').some(segment => segment.startsWith('.'))) return respond(req, res, 404, 'text/plain', 'Not found.');
      const absolute = resolve(PUBLIC, '.' + path);
      if (!absolute.startsWith(resolve(PUBLIC) + sep)) return respond(req, res, 404, 'text/plain', 'Not found.');
      const file = await stat(absolute);
      const mime = TYPES[extname(absolute)];
      if (!file.isFile() || !mime) return respond(req, res, 404, 'text/plain', 'Not found.');
      const audio_file = mime.startsWith('audio/');
      const range = audio_file ? audioRange(req.headers.range, file.size) : null;
      const headers = {
        'Content-Type': mime, 'Content-Length': file.size, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      };
      if (audio_file) headers['Accept-Ranges'] = 'bytes';
      if (range) {
        if (range.start > range.end || range.start >= file.size) {
          res.writeHead(416, {
            ...headers, 'Content-Length': 0, 'Content-Range': 'bytes */' + file.size,
          });
          return res.end();
        }
        headers['Content-Length'] = range.end - range.start + 1;
        headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + file.size;
      }
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') res.end();
      else createReadStream(absolute, range ?? {}).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) respond(req, res, 404, 'text/plain', 'Not found.');
      else res.destroy();
    }
  }

  const http = createServer(routes);
  const https = tls ? createSecureServer({ cert: tls.cert, key: tls.key }, routes) : null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_100_000 });

  function attach(server) {
    if (ipv6_peer) {
      server?.prependListener('connection', socket => {
        const address = socket.remoteAddress;
        if (!LOOPBACK_PEERS.has(address) && !ipv6_peer(address)) socket.destroy();
      });
    }
    server?.on('upgrade', (req, socket, head) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const role = url.searchParams.get('role');
        const seat = url.searchParams.get('seat');
        const trusted = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
        const local = LOOPBACK_PEERS.has(req.socket.remoteAddress);
        const valid_seat = ['A', 'B'].includes(seat);
        const allowed_role = role === 'stage' && local || role === 'seat' && valid_seat
          || role === 'room-mic' && valid_seat && (local || !settings?.sharedRoomMic && validRoomInvite(seat, url.searchParams.get('token')));
        if (url.pathname !== '/ws' || !trusted || !allowed_role) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
          ws.alive = true;
          ws.on('error', () => {});
          ws.on('pong', () => { ws.alive = true; });
          if (role === 'stage') {
            stage.add(ws);
            send(ws, scope({ type: 'state', state: session.snapshot() }));
            send(ws, scope(session.monitorFrame()));
          } else if (role === 'room-mic') {
            roomMics.get(seat)?.close(4001, 'Room mic moved to another tab');
            roomMics.set(seat, ws);
            void session.setListening(seat, false, 'companion');
            sendRoomMicState(ws, seat, session.snapshot());
          } else {
            const old = seats.get(seat);
            if (old) session.disconnect(seat);
            seats.set(seat, ws);
            old?.close(4001, 'Seat moved to another tab');
            void session.connect(seat, url.searchParams.get('sim') === '1').catch(() => ws.terminate());
          }
          ws.on('message', raw => {
            if (role === 'seat' && seats.get(seat) !== ws) return;
            if (role === 'room-mic' && roomMics.get(seat) !== ws) return;
            let frame;
            try { frame = JSON.parse(String(raw)); } catch { return; }
            if (!frame || typeof frame.type !== 'string') return;
            if (role === 'stage' && frame.type !== 'operator') return;
            const current = (frame.hubId === undefined || frame.hubId === hub_id)
              && (frame.sessionId === undefined || frame.sessionId === session.sessionId);
            const reason = current ? {} : { reason: 'session_changed' };
            if (role === 'stage' && typeof frame.action === 'string') {
              send(ws, scope({ type: 'operator_ack', action: frame.action, accepted: current, ...reason }));
            }
            if (role === 'seat' && frame.type === 'signal' && typeof frame.id === 'string' && frame.id.length <= 128) {
              send(ws, scope({ type: 'signal_ack', id: frame.id, accepted: current, ...reason }));
            }
            if (!current) return;
            if (role === 'seat' && frame.type === 'room_mic_invite') {
              if (settings?.sharedRoomMic) {
                send(ws, scope({ type: 'room_mic_invite', error: 'Start the room mic on the Mac Stage.' }));
                return;
              }
              if (!info.secure || !info.lanAvailable) {
                send(ws, scope({ type: 'room_mic_invite', error: 'Connect the hub to the hotspot to share a room mic link.' }));
                return;
              }
              const token = randomUUID();
              roomInvites.set(seat, { token, sessionId: session.sessionId, expiresAt: Date.now() + 600_000 });
              const join = new URL('/room-mic.html', info.joinUrl);
              join.search = new URLSearchParams({ seat, token }).toString();
              send(ws, scope({ type: 'room_mic_invite', url: join.href }));
              return;
            }
            let operation;
            if (role === 'room-mic') {
              if (frame.type === 'listen') operation = session.setListening(seat, frame.enabled === true, 'companion');
              else if (frame.type === 'mic') operation = session.receiveMic(seat, frame, 'companion');
            } else operation = role === 'stage' ? session.handleStage(frame) : session.handleSeat(seat, frame);
            Promise.resolve(operation).catch(() => {});
          });
          ws.once('close', () => {
            if (role === 'stage') stage.delete(ws);
            else if (role === 'room-mic' && roomMics.get(seat) === ws) {
              roomMics.delete(seat);
              void session.setListening(seat, false, 'companion');
            } else if (seats.get(seat) === ws) {
              seats.delete(seat);
              session.disconnect(seat);
            }
          });
        });
      } catch { socket.destroy(); }
    });
  }

  attach(http);
  attach(https);
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) socket.terminate();
      else { socket.alive = false; socket.ping(); }
    }
  }, 4000).unref();

  return {
    session, assets,
    async start({ port = 5780, tlsPort = 5743, host = '0.0.0.0' } = {}) {
      if (ledgerPath) await speech.sweepLedger?.();
      const http_address = await listen(http, port, host);
      const https_address = https ? await listen(https, tlsPort, host) : null;
      const join_host = LOOPBACK_HOSTS.has(host) ? host : lan;
      const domain = join_host.includes(':') ? '[' + join_host + ']' : join_host;
      const stage_domain = host === '::1' || host === '::' ? '[::1]' : '127.0.0.1';
      info = {
        stageUrl: 'http://' + stage_domain + ':' + http_address.port + '/stage',
        joinUrl: https_address
          ? 'https://' + domain + ':' + https_address.port + '/'
          : 'http://' + domain + ':' + http_address.port + '/',
        certificateUrl: tls?.publicRoot ? 'http://' + domain + ':' + http_address.port + '/telepathy-ca.cer' : null,
        secure: Boolean(https_address),
        lanAvailable: !LOOPBACK_HOSTS.has(join_host),
        hubId: hub_id,
        leftTestUrl: '/assets/test-left.mp3',
        rightTestUrl: '/assets/test-right.mp3',
        localPort: http_address.port,
        tlsPort: https_address?.port ?? null,
        codec: language.mode ?? 'injected',
        voicePreview: true,
        roomMic: true,
        sharedRoomMic: Boolean(settings?.sharedRoomMic),
      };
      return info;
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await Promise.all([session.close(), end(http), end(https)]);
    },
  };
}

async function main() {
  const env = process.env;
  const lan = env.TELEPATHY_HOST ?? findLanAddress();
  const bind = env.TELEPATHY_BIND ?? (isIP(lan) === 6 ? '::' : '0.0.0.0');
  let tls = null;
  try { tls = resolveTLS(env, RUNTIME, LOOPBACK_HOSTS.has(bind) ? bind : lan); }
  catch (error) { console.error('LAN HTTPS was unavailable. Local rehearsal remains available. ' + (error.code ?? error.message.split('\n')[0])); }
  const hub = createHub({
    env, lan, tls,
    ledgerPath: resolve(RUNTIME, 'clone-cleanup.json'),
    localPath: env.TELEPATHY_ROOM_MODEL || null,
    settings: {
      ...(env.TELEPATHY_PITCH_CONTEXT && { pitchContext: env.TELEPATHY_PITCH_CONTEXT }),
      sharedRoomMic: env.TELEPATHY_SHARED_ROOM_MIC !== '0',
    },
  });
  try {
    const info = await hub.start({
      port: Number(env.TELEPATHY_PORT ?? 5780),
      tlsPort: Number(env.TELEPATHY_TLS_PORT ?? 5743),
      host: bind,
    });
    console.log('Stage and rehearsal  ' + info.stageUrl);
    console.log('Phone join           ' + (info.lanAvailable
      ? info.joinUrl : 'Connect the MacBook to the hotspot, then restart.'));
    if (info.lanAvailable && info.certificateUrl) console.log('LAN trust setup      ' + info.certificateUrl);
    console.log('Text model          ', info.codec);
    console.log('Pitch coach          ' + (hub.session.coach ? 'Maritime with local fallback' : 'Local'));
  } catch (error) {
    await hub.close();
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => hub.close().catch(() => { process.exitCode = 1; }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
