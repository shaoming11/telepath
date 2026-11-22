import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const DEFAULT_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-mini';
const CONNECT_MS = 2400;
const MAX_OUTPUT_TOKENS = 160;
const CUE_TOOL = {
  type: 'function', name: 'submit_pitch_cue', description: 'Return the short private cue and its supporting evidence.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['answer', 'sourceId', 'quote'],
    properties: { answer: { type: 'string' }, sourceId: { type: 'string' }, quote: { type: 'string' } },
  },
};

export function openRealtimePitch({ env, signal, instructions, WebSocketImpl = WebSocket }) {
  const url = new URL(env.TELEPATHY_REALTIME_URL || DEFAULT_URL);
  url.searchParams.set('model', env.TELEPATHY_REALTIME_MODEL || DEFAULT_MODEL);
  const socket = new WebSocketImpl(url, { headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, handshakeTimeout: CONNECT_MS });
  const requests = new Map();
  const abandoned = new Set();
  let stopped = false;
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const connectTimeout = setTimeout(close, CONNECT_MS);
  connectTimeout.unref();

  function send(frame) {
    if (socket.readyState !== 1 || stopped) return false;
    try { socket.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(connectTimeout);
    signal.removeEventListener('abort', close);
    markReady(false);
    for (const request of requests.values()) request.finish(null);
    abandoned.clear();
    socket.close();
  }

  socket.on('error', close);
  socket.on('close', close);
  socket.on('message', data => {
    let event;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (event.type === 'session.created') {
      if (!send({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions, tools: [CUE_TOOL] } })) close();
      return;
    }
    if (event.type === 'session.updated') {
      clearTimeout(connectTimeout);
      markReady(true);
      return;
    }
    if (event.type === 'error') {
      const request = requests.get(event.error?.event_id);
      if (request) request.finish(null);
      return;
    }
    const response = event.response;
    const id = response?.metadata?.telepathy_request;
    if (!id) return;
    if (abandoned.has(id)) {
      if (event.type === 'response.created') send({ type: 'response.cancel', response_id: response.id });
      if (event.type === 'response.done') abandoned.delete(id);
      return;
    }
    const request = requests.get(id);
    if (!request) return;
    if (event.type === 'response.created') request.responseId = response.id;
    if (event.type !== 'response.done') return;
    if (response.status !== 'completed') return request.finish(null);
    const argumentsJson = response.output?.find(item => item.type === 'function_call' && item.name === CUE_TOOL.name)?.arguments;
    const text = response.output?.flatMap(item => item.content ?? [])
      .filter(content => content.type === 'output_text').map(content => content.text).join('') ?? '';
    const output = argumentsJson ?? text.match(/\{[\s\S]*\}/)?.[0];
    try {
      const value = JSON.parse(output);
      request.finish({
        status: value.answer && value.sourceId && value.quote ? 'answer' : 'unsupported',
        question: request.question,
        answer: value.answer ?? '',
        sources: [{ id: value.sourceId, quote: value.quote }],
      });
    } catch { request.finish(null); }
  });

  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();

  async function generate(input, requestSignal) {
    if (!(await ready) || stopped || signal.aborted || requestSignal.aborted) return null;
    const id = randomUUID();
    return new Promise(resolve => {
      const request = {
        question: input.turns?.at(-1)?.text ?? 'Next pitch cue',
        finish(value) {
          requests.delete(id);
          requestSignal.removeEventListener('abort', abort);
          resolve(value);
        },
      };
      function abort() {
        if (request.responseId) send({ type: 'response.cancel', response_id: request.responseId });
        else {
          abandoned.add(id);
          if (abandoned.size > 32) abandoned.delete(abandoned.values().next().value);
        }
        request.finish(null);
      }
      requests.set(id, request);
      requestSignal.addEventListener('abort', abort, { once: true });
      if (!send({ type: 'response.create', event_id: id, response: {
        conversation: 'none',
        metadata: { telepathy_request: id },
        instructions,
        tools: [CUE_TOOL],
        tool_choice: { type: 'function', name: CUE_TOOL.name },
        output_modalities: ['text'],
        max_output_tokens: MAX_OUTPUT_TOKENS,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }],
      } })) request.finish(null);
    });
  }

  return { generate, get closed() { return stopped; } };
}
