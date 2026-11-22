import { planPitchHelp, validatePitchHelpPlan } from '../maritime/policy.mjs';

const REMOTE_TIMEOUT_MS = 6500;
const CONTEXT_TTL_MS = 15_000;
const MIN_REQUEST_INTERVAL_MS = 3_000;

export function createPitchPlanner({ remote, now = Date.now, minIntervalMs = MIN_REQUEST_INTERVAL_MS } = {}) {
  const recent = new Map();
  let lastStarted = -Infinity;

  function prepare(context) {
    if (!remote) return null;
    const key = JSON.stringify([context.turns, context.passages]);
    const at = now();
    const previous = recent.get(context.seat);
    if (previous?.key === key && at - previous.at < CONTEXT_TTL_MS) return previous;
    if (at - lastStarted < minIntervalMs) return null;
    lastStarted = at;
    previous?.controller.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REMOTE_TIMEOUT_MS)]);
    const entry = { key, at, controller, result: null, task: null };
    entry.task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const reply = await remote(context, { signal });
      const plan = validatePitchHelpPlan(reply, context);
      if (!plan || signal.aborted) return null;
      entry.result = { plan, source: reply.source ?? 'maritime' };
      return entry.result;
    }).catch(() => null);
    recent.set(context.seat, entry);
    return entry;
  }

  async function select(context, { signal, waitMs }) {
    const entry = prepare(context);
    if (entry?.result) return entry.result;
    if (entry && waitMs > 0) {
      const timeout = new AbortController();
      const wait = AbortSignal.any([signal, timeout.signal]);
      let timer;
      let stop;
      try {
        timer = setTimeout(() => timeout.abort(), waitMs);
        const deadline = new Promise(resolve => {
          stop = () => resolve(null);
          if (wait.aborted) stop();
          else wait.addEventListener('abort', stop, { once: true });
        });
        const result = await Promise.race([entry.task, deadline]);
        if (result && !signal.aborted) return result;
      } finally {
        clearTimeout(timer);
        wait.removeEventListener('abort', stop);
      }
    }
    signal.throwIfAborted();
    return { plan: planPitchHelp(context), source: 'local-policy' };
  }

  function clear() {
    for (const entry of recent.values()) entry.controller.abort();
    recent.clear();
    lastStarted = -Infinity;
  }

  return { prepare, select, clear };
}
