import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { COACH_CUES, normalizePitch, recommendLocally, reviewCue } from './policy.mjs';

const MAX_BODY_BYTES = 8192;
const MAX_REASON_LENGTH = 160;
const MODEL_TIMEOUT_MS = 4000;
const DEFAULT_MODEL = 'gpt-5-mini';
const INSTRUCTIONS = [
  'You are the backstage coach for a two-minute Telepathy pitch.',
  'Use only the supplied pitch beat, elapsed time, number of online and ready seats, and count of acknowledged messages.',
  'Choose one cue and give a reason under 160 characters for the operator.',
  'sound-check: Check that both seats can hear the system when readiness or playback is uncertain.',
  'demo-cue: Show the working demo now. Choose this when still on the problem beat after 60 seconds.',
  'time-cue: Thirty seconds left. Use this during the final 30 seconds when the pitch has not reached closing.',
  'reveal-cue: Bring up the reveal. Choose this during closing or when a confirmed demo exchange is ready to explain.',
  'Return a JSON object with cueId and reason. The operator reviews the suggestion before any cue is sent.',
].join('\n');

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readPitch(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) return { status: 413, error: 'Payload too large.' };
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const message = typeof envelope?.message === 'string' ? JSON.parse(envelope.message) : null;
  const pitch = normalizePitch(message);
  if (!pitch) return { status: 400, error: 'Invalid pitch telemetry.' };
  const candidate = COACH_CUES.includes(message.candidateCueId) ? message.candidateCueId : null;
  return { pitch, candidate };
}

function validateAdvice(value) {
  const reason = typeof value?.reason === 'string' ? value.reason.replace(/\s+/g, ' ').trim() : '';
  if (!COACH_CUES.includes(value?.cueId) || !reason || reason.length > MAX_REASON_LENGTH) return null;
  return { cueId: value.cueId, reason, engine: 'model' };
}

async function recommend(pitch, { endpoint, key, model, fetchImpl, timeoutMs }) {
  if (endpoint && key) {
    try {
      const result = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: INSTRUCTIONS },
            { role: 'user', content: JSON.stringify(pitch) },
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: 'low',
          max_completion_tokens: 400,
          store: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (result.ok) {
        const body = await result.json();
        const advice = validateAdvice(JSON.parse(body.choices?.[0]?.message?.content));
        if (advice) return advice;
      }
    } catch {}
  }
  return { ...recommendLocally(pitch), engine: 'rules' };
}

export function createCoachServer({ env = process.env, fetchImpl = fetch, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const base = env.OPENAI_BASE_URL?.trim().replace(/\/+$/, '');
  const config = {
    endpoint: base ? base + '/chat/completions' : null,
    key: env.OPENAI_API_KEY?.trim(),
    model: env.TELEPATHY_MARITIME_MODEL?.trim() || DEFAULT_MODEL,
    fetchImpl,
    timeoutMs,
  };
  return createServer(async (request, response) => {
    const path = request.url.split('?')[0];
    if (path === '/health' && request.method === 'GET') return sendJson(response, 200, { ok: true });
    if (path !== '/chat' && path !== '/health') return sendJson(response, 404, { error: 'Not found.' });
    if (path !== '/chat' || request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
    let input;
    try {
      input = await readPitch(request);
    } catch {
      return sendJson(response, 400, { error: 'Invalid pitch telemetry.' });
    }
    if (!input.pitch) {
      request.resume();
      return sendJson(response, input.status, { error: input.error });
    }
    const advice = input.candidate ? reviewCue(input.pitch, input.candidate) : await recommend(input.pitch, config);
    return sendJson(response, 200, { response: JSON.stringify(advice) });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PORT to a valid TCP port.');
  createCoachServer().listen(port, '0.0.0.0');
}
