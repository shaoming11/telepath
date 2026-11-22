export const DEFAULT_TIMING = Object.freeze({
  closeMs: 1200,
  duplicateMs: 95,
  fastMaxMs: 540,
  oneEarFastMaxMs: 0,
  slowMinMs: 600,
  slowMaxMs: 1050,
  mixedMaxMs: 1050,
});

export const DEFAULT_EMULATOR = Object.freeze({
  delayMs: 72,
  jitterMs: 35,
  fastGapMs: 320,
  slowGapMs: 810,
  mixedGapMs: 385,
  duplicateGapMs: 48,
  missRate: 0.02,
  doubleRate: 0.035,
  seed: 4391,
});

export const TRACKS = Object.freeze({
  nexttrack: 'R',
  previoustrack: 'L',
});
const ONE_EAR_REJECTION_MS = 60;

export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(1664525, value) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function recognize(events, mode, timing = DEFAULT_TIMING) {
  const tracks = events.map(({ action }) => mode === 1 ? 'R' : TRACKS[action]);
  const first_gap = events[1]?.at - events[0]?.at;
  const last_gap = events[2]?.at - events[1]?.at;
  const fast_limit = mode === 1 && timing.oneEarFastMaxMs > 0 ? timing.oneEarFastMaxMs : timing.fastMaxMs;
  switch (tracks.join('')) {
    case 'R': return 'R1';
    case 'L': return 'L1';
    case 'RL': return null;
    case 'LR': return first_gap <= timing.mixedMaxMs ? 'LR' : null;
    case 'LL': return first_gap <= timing.fastMaxMs ? 'L2' : null;
    case 'RR':
      if (first_gap <= fast_limit) return 'R2';
      return mode === 1 && first_gap >= timing.slowMinMs && first_gap <= timing.slowMaxMs ? 'L2' : null;
    case 'RRR':
      return mode === 1 && first_gap <= fast_limit && last_gap <= fast_limit ? 'LR' : null;
    default: return null;
  }
}

export function touchSettings(timing, emulator, mode) {
  const safeGap = (chosen, minimum, maximum) => chosen > minimum + 10 && chosen < maximum - 10
    ? chosen : Math.round((minimum + maximum) / 2);
  const fast_limit = mode === 1 && timing.oneEarFastMaxMs > 0 ? timing.oneEarFastMaxMs : timing.fastMaxMs;
  return {
    ...emulator,
    delayMs: 0, jitterMs: 0, missRate: 0, doubleRate: 0,
    fastGapMs: safeGap(emulator.fastGapMs, timing.duplicateMs, Math.min(fast_limit, timing.closeMs - 1)),
    slowGapMs: safeGap(emulator.slowGapMs, timing.slowMinMs, Math.min(timing.slowMaxMs, timing.closeMs - 1)),
    mixedGapMs: safeGap(emulator.mixedGapMs, 0, Math.min(timing.mixedMaxMs, timing.closeMs - 1)),
  };
}

export function createMediaInput({
  mode = 2, timing = DEFAULT_TIMING, onSignal, onRaw, onError, onPlay,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let thresholds = { ...DEFAULT_TIMING, ...timing };
  let current_mode = mode;
  let events = [];
  let timer;
  let removed = false;
  let media_session;
  const registered = [];

  function clear() {
    clearTimer(timer);
    timer = undefined;
    events = [];
  }

  function flush() {
    if (!events.length) return;
    const signal = recognize(events, current_mode, thresholds);
    const trace = events;
    clear();
    if (signal) onSignal?.(signal, trace);
    else onError?.(trace);
  }

  function dispatch(action, at) {
    const stamp = Number.isFinite(at) ? at : now();
    if (action !== 'pause' && action !== 'play' && !Object.hasOwn(TRACKS, action)) return;
    onRaw?.({ action, at: stamp });
    if (action === 'pause') {
      clear();
      if (!removed) {
        removed = true;
        onSignal?.('OUT', [{ action, at: stamp }]);
      }
      return;
    }
    if (action === 'play') {
      onPlay?.();
      if (removed) {
        removed = false;
        onSignal?.('BACK', [{ action, at: stamp }]);
      }
      return;
    }
    if (events.length && stamp - events.at(-1).at >= thresholds.closeMs) flush();
    const previous = events.at(-1);
    const same_track = current_mode === 1 || previous?.action === action;
    if (previous && same_track && stamp - previous.at < thresholds.duplicateMs) return;
    events.push({ action, at: stamp });
    clearTimer(timer);
    timer = setTimer(flush, thresholds.closeMs);
  }

  function unregister() {
    for (const action of registered.splice(0)) {
      try { media_session.setActionHandler(action, null); } catch {}
    }
  }

  return {
    register(mediaSession = globalThis.navigator?.mediaSession) {
      unregister();
      media_session = mediaSession;
      if (!media_session) return [];
      for (const action of ['nexttrack', 'previoustrack', 'pause', 'play']) {
        try {
          media_session.setActionHandler(action, () => dispatch(action));
          registered.push(action);
        } catch {}
      }
      return [...registered];
    },
    dispatch,
    configure({ mode: new_mode, timing: new_timing } = {}) {
      if (new_mode && new_mode !== current_mode) clear();
      current_mode = new_mode ?? current_mode;
      if (new_timing) thresholds = { ...thresholds, ...new_timing };
    },
    flush,
    reset() { clear(); removed = false; },
    dispose() { clear(); removed = false; unregister(); },
  };
}

export function patternFor(signal, mode = 2, settings = DEFAULT_EMULATOR) {
  const { fastGapMs, slowGapMs, mixedGapMs } = { ...DEFAULT_EMULATOR, ...settings };
  const right = 'nexttrack';
  const left = mode === 1 ? right : 'previoustrack';
  const patterns = {
    R1: [[right, 0]],
    R2: [[right, 0], [right, fastGapMs]],
    L1: mode === 1 ? [] : [[left, 0]],
    L2: [[left, 0], [left, mode === 1 ? slowGapMs : fastGapMs]],
    LR: mode === 1 ? [[right, 0], [right, fastGapMs], [right, 2 * fastGapMs]] : [[left, 0], [right, mixedGapMs]],
    OUT: [['pause', 0]],
    BACK: [['play', 0]],
  };
  return (patterns[signal] ?? []).map(([action, offsetMs]) => ({ action, offsetMs }));
}

export function createEmulator({
  input, settings = DEFAULT_EMULATOR, random, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let config = { ...DEFAULT_EMULATOR, ...settings };
  let rng = random ?? seededRandom(config.seed);
  const timers = new Set();
  const stats = { scheduled: 0, delivered: 0, missed: 0, doubled: 0 };

  function deliver(action, delay_ms) {
    stats.scheduled += 1;
    const arrival = now() + delay_ms;
    const timer = setTimer(() => {
      timers.delete(timer);
      stats.delivered += 1;
      input.dispatch(action, arrival);
    }, delay_ms);
    timers.add(timer);
  }

  function gesture(action, offset_ms = 0) {
    if (rng() < config.missRate) {
      stats.missed += 1;
      return;
    }
    const delay_ms = Math.max(0, config.delayMs + (2 * rng() - 1) * config.jitterMs);
    deliver(action, offset_ms + delay_ms);
    if (rng() < config.doubleRate) {
      stats.doubled += 1;
      deliver(action, offset_ms + delay_ms + config.duplicateGapMs);
    }
  }

  return {
    gesture,
    signal(signal, mode) {
      patternFor(signal, mode, config).forEach(({ action, offsetMs }) => gesture(action, offsetMs));
    },
    configure(settings) {
      if (!random && settings.seed !== undefined && settings.seed !== config.seed) rng = seededRandom(settings.seed);
      config = { ...config, ...settings };
    },
    reset() { for (const timer of timers) clearTimer(timer); timers.clear(); },
    stats,
  };
}

function median(values, fallback) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return fallback;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function tuneCalibration(trials, defaults = {}) {
  const timing = { ...DEFAULT_TIMING, ...defaults.timing };
  const emulator = { ...DEFAULT_EMULATOR, ...defaults.emulator };
  const fast = [];
  const slow = [];
  const mixed = [];
  const prompt_delays = [];
  const duplicate_gaps = [];
  let expected = 0;
  let missed = 0;

  for (const trial of trials) {
    const pattern = patternFor(trial.signal, trial.mode, emulator);
    const received = trial.events.filter(({ action, at }) => Number.isFinite(at) && pattern.some(event => event.action === action)).toSorted((a, b) => a.at - b.at);
    const unique = [];
    expected += pattern.length;
    if (received.length && Number.isFinite(trial.promptAt) && received[0].at >= trial.promptAt) prompt_delays.push(received[0].at - trial.promptAt);
    for (const event of received) {
      const previous = unique.at(-1);
      if (previous?.action === event.action && event.at - previous.at < timing.duplicateMs) {
        duplicate_gaps.push(event.at - previous.at);
        continue;
      }
      unique.push(event);
    }
    const expected_actions = pattern.map(event => event.action);
    const available_actions = unique.map(event => event.action);
    let observed = 0;
    for (const action of expected_actions) {
      const match = available_actions.indexOf(action);
      if (match !== -1) {
        available_actions.splice(match, 1);
        observed += 1;
      }
    }
    missed += pattern.length - observed;
    const exact = unique.length === pattern.length && unique.every((event, index) => event.action === pattern[index].action);
    if (exact && pattern.length > 1) {
      const gaps = unique.slice(1).map(({ at }, index) => at - unique[index].at);
      if (trial.signal === 'L2' && trial.mode === 1) slow.push(...gaps);
      else if (trial.signal === 'LR' && trial.mode !== 1) mixed.push(...gaps);
      else fast.push(...gaps);
    }
  }

  emulator.fastGapMs = Math.round(median(fast, emulator.fastGapMs));
  emulator.slowGapMs = Math.round(median(slow, emulator.slowGapMs));
  emulator.mixedGapMs = Math.round(median(mixed, emulator.mixedGapMs));
  emulator.missRate = expected ? missed / expected : emulator.missRate;
  emulator.doubleRate = expected ? Math.min(1, duplicate_gaps.length / expected) : emulator.doubleRate;
  emulator.duplicateGapMs = Math.round(median(duplicate_gaps, emulator.duplicateGapMs));
  const variation = [...fast.map(gap => Math.abs(gap - emulator.fastGapMs)), ...slow.map(gap => Math.abs(gap - emulator.slowGapMs)), ...mixed.map(gap => Math.abs(gap - emulator.mixedGapMs))];
  emulator.jitterMs = Math.round(median(variation, emulator.jitterMs));
  if (duplicate_gaps.length && fast.length) timing.duplicateMs = Math.round(Math.min(Math.min(...fast) / 2, Math.max(timing.duplicateMs, ...duplicate_gaps.map(gap => gap * 1.25))));
  if (fast.length) timing.fastMaxMs = Math.round(Math.max(timing.fastMaxMs, ...fast));
  if (slow.length) {
    const half_band = ONE_EAR_REJECTION_MS / 2;
    const midpoint = (emulator.fastGapMs + emulator.slowGapMs) / 2;
    const earliest_slow = Math.min(...slow);
    const latest_fast = fast.length ? Math.max(...fast) : emulator.fastGapMs;
    timing.oneEarFastMaxMs = Math.round(Math.max(timing.duplicateMs + 1,
      Math.min(timing.fastMaxMs, midpoint - half_band, earliest_slow - half_band)));
    timing.slowMinMs = Math.round(Math.max(timing.oneEarFastMaxMs + ONE_EAR_REJECTION_MS,
      latest_fast + half_band, Math.min(timing.slowMinMs, earliest_slow)));
    timing.slowMaxMs = Math.round(Math.max(timing.slowMaxMs, timing.slowMinMs, ...slow));
  }
  if (mixed.length) timing.mixedMaxMs = Math.round(Math.max(timing.mixedMaxMs, ...mixed));
  timing.closeMs = Math.round(Math.max(timing.closeMs, timing.fastMaxMs + 1, timing.slowMaxMs + 1, timing.mixedMaxMs + 1));
  return {
    timing, emulator,
    metrics: {
      trials: trials.length, expected, missed, duplicates: duplicate_gaps.length,
      medianPromptToEventMs: median(prompt_delays, null), fastSamples: fast.length, slowSamples: slow.length,
    },
  };
}
