import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { Worker } from 'node:worker_threads';
import { bankFileName, createAudio, STATUS_LINES, STOCK_VOICES } from './audio.mjs';
import { createCodec } from './codec.mjs';
import { Session } from './session.mjs';
import { findLanAddress, resolveTLS } from './tls.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../.runtime/', import.meta.url));
const MAX_SOCKET_BACKLOG = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
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
  env = process.env, audio, codec, settings, tls = null,
  lan = env.TELEPATHY_HOST ?? findLanAddress(), localPath = null, ledgerPath,
} = {}) {
  const assets = new Map();
  const seats = new Map();
  const stage = new Set();
  const hub_id = randomUUID();
  let session;
  const speech = audio ?? createAudio({
    assets, env, allowBundledFallback: true, ledgerPath,
    whisperModel: env.TELEPATHY_WHISPER_MODEL ?? 'eleven_v4_turbo',
    onTranscriptionStatus: status => session?.updateTranscriptionStatus?.(status),
  });
  const language = codec ?? createCodec({ env, localPath });
  const scope = frame => frame.type === 'state'
    ? { ...frame, state: { ...frame.state, hubId: hub_id, serverNow: Date.now() } }
    : { sessionId: session.sessionId, ...frame, hubId: hub_id };
  session = new Session({
    emitSeat: (seat, frame) => send(seats.get(seat), scope(frame)),
    emitStage: frame => {
      const speaker = frame.voiceRole ?? frame.key?.split(':')[0];
      const voiced = frame.type === 'audio' && !frame.url && Object.hasOwn(STOCK_VOICES, speaker)
        ? { ...frame, url: '/assets/' + bankFileName(speaker, STOCK_VOICES[speaker].id, frame.text) }
        : frame;
      const tagged = scope(voiced);
      stage.forEach(socket => send(socket, tagged));
    },
    audio: speech,
    codec: language,
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
    if (req.url === '/references' && req.method === 'POST') {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const current = req.headers['x-telepathy-hub'] === hub_id && req.headers['x-telepathy-session'] === session.sessionId;
      if (!local || !current) return respond(req, res, 403, TYPES['.json'], JSON.stringify({ error: 'Reconnect to the local stage and try again.' }));
      if (session.phase !== 'lobby' || session.referencesLoading) return respond(req, res, 409, TYPES['.json'], JSON.stringify({ error: 'Upload documents in the lobby before starting.' }));
      const generation = session.generation;
      session.referencesLoading = true;
      session.publish();
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) throw new Error('Upload exceeds 8 MB of files.');
          chunks.push(chunk);
        }
        const files = JSON.parse(Buffer.concat(chunks).toString('utf8')).files;
        const documents = await new Promise((resolve, reject) => {
          const worker = new Worker(new URL('./reference-worker.mjs', import.meta.url), { workerData: files, resourceLimits: { maxOldGenerationSizeMb: 192 } });
          const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Document parsing timed out. Try a smaller file.')); }, 20_000);
          worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.documents); });
          worker.once('error', error => { clearTimeout(timer); reject(error); });
          worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Could not parse these documents.')); });
        });
        if (generation !== session.generation || session.phase !== 'lobby') throw new Error('Session changed; upload again.');
        session.references = documents;
        respond(req, res, 200, TYPES['.json'], JSON.stringify({ documents: documents.map(({ id, name, characters }) => ({ id, name, characters })) }));
      } catch (error) {
        if (!res.headersSent) respond(req, res, 400, TYPES['.json'], JSON.stringify({ error: error.message || 'Upload failed.' }));
      } finally {
        if (generation === session.generation) { session.referencesLoading = false; session.publish(); }
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(req, res, 405, 'text/plain', 'Use GET.');
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/info') return respond(req, res, 200, TYPES['.json'], JSON.stringify(info));
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
      res.writeHead(200, {
        'Content-Type': mime, 'Content-Length': file.size, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(absolute).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) respond(req, res, 404, 'text/plain', 'Not found.');
      else res.destroy();
    }
  }

  const http = createServer(routes);
  const https = tls ? createSecureServer({ cert: tls.cert, key: tls.key }, routes) : null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_100_000 });

  function attach(server) {
    server?.on('upgrade', (req, socket, head) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const role = url.searchParams.get('role');
        const seat = url.searchParams.get('seat');
        const trusted = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (url.pathname !== '/ws' || !trusted || !(role === 'stage' && local || role === 'seat' && ['A', 'B'].includes(seat))) {
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
          } else {
            const old = seats.get(seat);
            if (old) session.disconnect(seat);
            seats.set(seat, ws);
            old?.close(4001, 'Seat moved to another tab');
            void session.connect(seat, url.searchParams.get('sim') === '1').catch(() => ws.terminate());
          }
          ws.on('message', raw => {
            if (role === 'seat' && seats.get(seat) !== ws) return;
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
            const operation = role === 'stage' ? session.handleStage(frame) : session.handleSeat(seat, frame);
            Promise.resolve(operation).catch(() => {});
          });
          ws.once('close', () => {
            if (role === 'stage') stage.delete(ws);
            else if (seats.get(seat) === ws) {
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
  const bind = env.TELEPATHY_BIND ?? '0.0.0.0';
  let tls = null;
  try { tls = resolveTLS(env, RUNTIME, LOOPBACK_HOSTS.has(bind) ? bind : lan); }
  catch (error) { console.error('LAN HTTPS was unavailable. Local rehearsal remains available. ' + (error.code ?? error.message.split('\n')[0])); }
  const hub = createHub({
    env, lan, tls,
    ledgerPath: resolve(RUNTIME, 'clone-cleanup.json'),
    localPath: env.TELEPATHY_ROOM_MODEL || null,
    settings: env.TELEPATHY_PITCH_CONTEXT ? { pitchContext: env.TELEPATHY_PITCH_CONTEXT } : {},
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
