import { COACH_CUES, normalizeCueRequest, normalizePitch, normalizePitchHelp, validatePitchHelpPlan } from '../maritime/policy.mjs';

const MARITIME_API = 'https://api.maritime.sh';
const OPENAI_RESPONSES = 'https://api.openai.com/v1/responses';
const MAX_REASON_LENGTH = 180;
const ASSIST_TIMEOUT_MS = 2400;
const CAPACITY_BACKOFF_MS = 15_000;
const BILLING_BACKOFF_MS = 60_000;
const SOURCES = { model: 'maritime', rules: 'maritime-rules', assisted: 'maritime-assisted' };
const ASSIST_INSTRUCTIONS = [
  'Suggest one cue for a two-minute Telepath pitch using only these five telemetry values.',
  'Choose reveal-cue in closing or after an acknowledged live demo when no time reminder is needed.',
  'Choose demo-cue if the problem explanation has crossed 60 seconds or the opening is ready to move into the demo.',
  'Choose sound-check if seat readiness or playback is uncertain.',
  'Choose time-cue when at least 90 seconds have elapsed and the pitch is still running.',
  'The Maritime coach will review your cue before suggesting it to the operator.',
].join(' ');

async function suggestCue(input, env, fetchImpl, shared_signal) {
  const key = env.OPENAI_API_KEY?.trim();
  if (env.TELEPATHY_MARITIME_ASSIST !== 'openai' || !key) return null;
  const timeout = AbortSignal.timeout(ASSIST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(OPENAI_RESPONSES, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.TELEPATHY_OPENAI_MODEL || 'gpt-4.1-mini',
        store: false,
        max_output_tokens: 64,
        instructions: ASSIST_INSTRUCTIONS,
        input: JSON.stringify(input),
        text: { format: { type: 'json_schema', name: 'telepathy_pitch_cue', strict: true, schema: {
          type: 'object', properties: { cueId: { type: 'string', enum: COACH_CUES } },
          required: ['cueId'], additionalProperties: false,
        } } },
      }),
      signal: shared_signal ? AbortSignal.any([timeout, shared_signal]) : timeout,
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (result.status !== 'completed') return null;
    const output = result.output?.flatMap(item => item.content ?? []).find(item => item.type === 'output_text')?.text;
    const { cueId } = JSON.parse(output) ?? {};
    return COACH_CUES.includes(cueId) ? cueId : null;
  } catch {
    return null;
  }
}

function retryDelay(response, at) {
  const value = response.headers.get('retry-after');
  if (value && /^\d+$/.test(value.trim()) && Number.isFinite(Number(value))) return Number(value) * 1000;
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - at) : CAPACITY_BACKOFF_MS;
}

export function createMaritimeCoach({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const key = env.MARITIME_API_KEY?.trim();
  const agent_id = env.TELEPATHY_MARITIME_AGENT_ID?.trim();
  if (!key || !agent_id || env.TELEPATHY_MARITIME !== 'on') return null;

  let pausedUntil = 0;
  async function chat(message, signal) {
    const at = now();
    if (at < pausedUntil) throw new Error('Maritime is in its retry window');
    const response = await fetchImpl(MARITIME_API + '/api/agents/' + encodeURIComponent(agent_id) + '/chat', {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: JSON.stringify(message) }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) pausedUntil = Math.max(pausedUntil, now() + retryDelay(response, now()));
      if (response.status === 402) pausedUntil = Math.max(pausedUntil, now() + BILLING_BACKOFF_MS);
      throw new Error('Maritime returned HTTP ' + response.status);
    }
    const { response: reply, error } = await response.json();
    if (error) throw new Error('Maritime did not confirm the response');
    if (typeof reply !== 'string' || reply.length > 1_000) throw new Error('Invalid Maritime reply');
    return JSON.parse(reply) ?? {};
  }

  return {
    ...(env.TELEPATHY_MARITIME_CUE_RACE === 'on' && {
      async draftPitchCue(context, { signal } = {}) {
        const input = normalizeCueRequest({ ...context, type: 'pitch_cue' });
        if (!input) throw new Error('Invalid Maritime cue context');
        return chat(input, signal);
      },
      async verifyPitchCue(context, { signal } = {}) {
        const input = normalizeCueRequest({ ...context, type: 'pitch_cue_review' });
        if (!input) throw new Error('Invalid Maritime cue review context');
        return chat(input, signal);
      },
    }),
    ...(env.TELEPATHY_MARITIME_PITCH_HELP === 'on' && {
      async planPitchHelp(context, { signal } = {}) {
        const input = normalizePitchHelp(context);
        if (!input) throw new Error('Invalid Maritime pitch help context');
        signal?.throwIfAborted();
        const result = await chat(input, signal);
        const plan = validatePitchHelpPlan(result, input);
        if (!plan || !['model', 'rules'].includes(result.engine)) throw new Error('Invalid Maritime pitch help plan');
        return { ...plan, source: SOURCES[result.engine] };
      },
    }),
    async recommend(pitch, { signal } = {}) {
      const input = normalizePitch(pitch);
      if (!input) throw new Error('Invalid pitch state');
      signal?.throwIfAborted();
      if (now() < pausedUntil) throw new Error('Maritime is in its retry window');
      const candidate = await suggestCue(input, env, fetchImpl, signal);
      signal?.throwIfAborted();
      const message = candidate ? { ...input, candidateCueId: candidate } : input;
      const { cueId, reason, engine } = await chat(message, signal);
      if (!COACH_CUES.includes(cueId) || typeof engine !== 'string' || !Object.hasOwn(SOURCES, engine)
        || engine === 'assisted' && cueId !== candidate
        || typeof reason !== 'string' || !reason.trim() || reason.length > MAX_REASON_LENGTH) {
        throw new Error('Invalid Maritime recommendation');
      }
      return {
        cueId,
        reason: reason.replace(/\s+/g, ' ').trim(),
        source: SOURCES[engine],
      };
    },
  };
}
