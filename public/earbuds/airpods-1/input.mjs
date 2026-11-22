export const AIRPODS_1_ID = 'next-only';
export const COUNT_CALIBRATION_WINDOW_MS = 2500;
const DEFAULT_WINDOW_MS = 1200;
const BOUNCE_MS = 95;
const SIGNALS = ['R1', 'R2', 'L1'];

export function createAirPods1Input({ onRaw, onSignal, onError, onPlay, now, setTimer, clearTimer }) {
  let window_ms = DEFAULT_WINDOW_MS;
  let events = [];
  let timer;

  function reset() {
    clearTimer(timer);
    timer = undefined;
    events = [];
  }

  function flush() {
    if (!events.length) return;
    const trace = events;
    reset();
    const signal = SIGNALS[trace.length - 1];
    if (signal) onSignal?.(signal, trace);
    else onError?.(trace);
  }

  return {
    receive(action) {
      if (action === 'play') onPlay?.();
      if (action !== 'nexttrack') return;
      const event = { action, at: now() };
      onRaw?.(event);
      const gap = event.at - events.at(-1)?.at;
      if (gap >= window_ms) flush();
      if (gap < BOUNCE_MS) return;
      events.push(event);
      clearTimer(timer);
      timer = setTimer(flush, window_ms);
    },
    configure({ countWindowMs }) { window_ms = countWindowMs ?? DEFAULT_WINDOW_MS; },
    flush,
    reset,
  };
}

export function countPattern(signal) {
  return Array.from({ length: SIGNALS.indexOf(signal) + 1 }, () => ({ action: 'nexttrack' }));
}

export function buildCountTrials(mode, trials_per_pattern) {
  return SIGNALS.slice(1).flatMap(signal => Array.from({ length: trials_per_pattern }, (_, trial) =>
    ({ signal, trial, mode, kind: 'tap', gestureModel: AIRPODS_1_ID })));
}

export function fitCountTiming(gaps) {
  if (!gaps.length) return {};
  const sorted = gaps.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const upper = sorted[Math.ceil(sorted.length * 0.85) - 1];
  return {
    countMedianMs: Math.round(median),
    countWindowMs: Math.round(Math.min(COUNT_CALIBRATION_WINDOW_MS, Math.max(350, upper + 220, median * 1.35))),
  };
}
