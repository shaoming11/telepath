import { COUNT_CALIBRATION_WINDOW_MS, DEFAULT_TIMING, patternFor, tuneCalibration } from './input.mjs';
import { CALIBRATION_SIGNALS, MEASURE_TEXT, SIGNAL_LABELS } from './phone-data.mjs';

export const TRIALS_PER_PATTERN = 3;
export const MIN_RESPONSE_RATE = 0.6;
const MIN_RECOGNITION_RATE = 0.75;

const PROFILE_VERSION = 1;
const TRACK_ACTIONS = new Set(['nexttrack', 'previoustrack']);
const ACTION_LABELS = { nexttrack: 'Next Track', previoustrack: 'Previous Track', pause: 'Pause', play: 'Play' };
const CONTROL_STEPS = [
  ['pause', 'single squeeze either stem'],
  ['nexttrack', 'double squeeze either stem'],
  ['previoustrack', 'triple squeeze either stem'],
];
const SQUEEZE_LABELS = { pause: 'Single squeeze', nexttrack: 'Double squeeze', previoustrack: 'Triple squeeze' };
const PATTERNS = {
  1: { R1: 'Next Track once', R2: 'Next Track twice quickly', L2: 'Next Track, pause, Next Track', LR: 'Next Track three times quickly' },
  2: { R1: 'Next Track once', R2: 'Next Track twice quickly', L1: 'Previous Track once', L2: 'Previous Track twice quickly', LR: 'Previous Track, then Next Track' },
};

const $ = id => document.getElementById(id);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function build_plan(scope, current_mode, model) {
  if (model === 'next-only') {
    return ['R2', 'L1'].flatMap(signal => Array.from({ length: TRIALS_PER_PATTERN }, (_, trial) =>
      ({ signal, trial, mode: current_mode, kind: 'tap', gestureModel: model })));
  }
  const modes = scope === 'both' ? [2, 1] : [current_mode];
  const plan = [];
  for (const mode of modes) {
    for (const signal of CALIBRATION_SIGNALS[mode]) {
      for (let trial = 0; trial < TRIALS_PER_PATTERN; trial += 1) plan.push({ signal, mode, kind: 'tap', trial });
    }
  }
  for (let trial = 0; trial < TRIALS_PER_PATTERN; trial += 1) {
    plan.push({ signal: 'OUT', mode: current_mode, kind: 'remove', trial });
    plan.push({ signal: 'BACK', mode: current_mode, kind: 'insert', trial });
  }
  return plan;
}

export function normalize_trial(record) {
  const events = record.events.map(({ action, at }) => ({
    action: record.mode === 1 && TRACK_ACTIONS.has(action) ? 'nexttrack' : action,
    at,
  }));
  return {
    signal: record.signal, mode: record.mode, gestureModel: record.gestureModel,
    promptAt: record.promptAt, events, matched: record.recognized?.includes(record.signal),
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize_trials(records) {
  const delay_for = kind => median(records
    .filter(record => record.kind === kind && record.events.length && record.events[0].at >= record.promptAt)
    .map(record => record.events[0].at - record.promptAt));
  const responded = records.filter(record => record.events.length).length;
  const recognized = records.filter(record => record.recognized.includes(record.signal)).length;
  return {
    responded,
    recognized,
    responseRate: records.length ? responded / records.length : 0,
    recognizedRate: records.length ? recognized / records.length : 0,
    earlyEvents: records.reduce((total, record) => total + record.early.length, 0),
    cueToTapMs: delay_for('tap'),
    cueToRemovalMs: delay_for('remove'),
    cueToReinsertionMs: delay_for('insert'),
  };
}

function format_ms(value) {
  return Number.isFinite(value) ? Math.round(value) + ' ms' : 'No data';
}

function format_percent(value) {
  return Number.isFinite(value) ? Math.round(value * 100) + '%' : 'No data';
}

function metric_rows(profile) {
  const { metrics, emulator, timing } = profile;
  if (profile.gestureModel === 'next-only') {
    return [
      ['Recognized', metrics.recognized + ' of ' + metrics.trials],
      ['Median gap between Next Track events', format_ms(timing.countMedianMs)],
      ['Personal gesture window', format_ms(timing.countWindowMs)],
    ];
  }
  return [
    ['Trials answered', metrics.responded + ' of ' + metrics.trials],
    ['Recognized', metrics.recognized + ' of ' + metrics.trials],
    ['Missed events', metrics.missed + ' of ' + metrics.expected + ' (' + format_percent(emulator.missRate) + ')'],
    ['Doubled events', metrics.duplicates + ' (' + format_percent(emulator.doubleRate) + ')'],
    ['Cue to first tap', format_ms(metrics.cueToTapMs)],
    ['Cue to removal', format_ms(metrics.cueToRemovalMs)],
    ['Cue to reinsertion', format_ms(metrics.cueToReinsertionMs)],
    ['Input jitter', format_ms(emulator.jitterMs)],
    ['Fast gap', format_ms(emulator.fastGapMs)],
    ['Slow gap', format_ms(emulator.slowGapMs)],
    ['Fast limit', format_ms(timing.fastMaxMs)],
    ['One-ear fast limit', format_ms(timing.oneEarFastMaxMs || timing.fastMaxMs)],
    ['Pattern close', format_ms(timing.closeMs)],
  ];
}

export function createCalibration(services) {
  const elements = {
    intro: $('cal-intro'), run: $('cal-run'), result: $('cal-result'),
    seat_row: $('cal-seat'), emulate_row: $('cal-emulate-row'), emulate: $('cal-emulate'),
    start: $('cal-start'), skip: $('cal-skip'), stop: $('cal-stop'), run_skip: $('cal-run-skip'),
    count: $('cal-count'), phase: $('cal-phase'), pattern: $('cal-pattern'), detail: $('cal-detail'),
    bar: $('cal-bar'), ticks: $('cal-ticks'),
    verdict: $('cal-verdict'), metrics: $('cal-metrics'), applied: $('cal-applied'),
    apply: $('cal-apply'), download: $('cal-download'), done: $('cal-done'), again: $('cal-again'),
    measure: $('cal-measure'), hint: $('cal-start-hint'),
    quick: $('cal-quick'), quick_start: $('cal-quick-start'),
    quick_continue: $('cal-quick-continue'), quick_status: $('cal-quick-status'),
    quick_model: $('cal-earbud-model'),
  };
  let run_token = 0;
  let running = false;
  let plan = [];
  let records = [];
  let current = null;
  let lead = null;
  let waiter = null;
  let manual_events = 0;
  let original_mode = 2;
  let last_output = null;
  let applied = false;
  let context = { from: 'settings' };
  let checking = false;
  const checked_actions = new Set();

  elements.measure.textContent = MEASURE_TEXT;

  function show(section) {
    elements.intro.hidden = section !== 'intro';
    elements.run.hidden = section !== 'run';
    elements.result.hidden = section !== 'result';
  }

  function selected_scope() {
    return document.querySelector('input[name="cal_scope"]:checked')?.value === 'both' ? 'both' : 'mode';
  }

  function render_intro() {
    const has_seat = Boolean(services.get_seat());
    const sim = services.is_sim();
    elements.seat_row.hidden = has_seat;
    elements.emulate_row.hidden = !sim;
    elements.emulate.disabled = !sim;
    elements.quick.hidden = sim;
    elements.quick_start.disabled = !has_seat;
    elements.quick_model.disabled = checking;
    if (!checking) elements.quick_start.textContent = elements.quick_model.value === 'pro' ? 'Test squeezes' : 'Calibrate timing';
    if (!checking && has_seat && !sim) elements.quick_status.textContent = elements.quick_model.value === 'pro'
      ? 'Use either stem. Keep the earbuds in while testing.'
      : 'Set an AirPods double-tap to Next Track. Repeat it two or three times at your normal pace.';
    $('cal-full').hidden = !sim;
    $('cal-quick-controls').hidden = !checking;
    elements.start.disabled = !has_seat;
    elements.skip.hidden = context.from !== 'setup';
    elements.hint.textContent = !has_seat ? 'Pick a seat to start.'
      : sim ? 'Simulated seat. Keys R, L, O and I send raw actions, or let the emulator tap.'
      : 'Choose your AirPods model before starting.';
  }

  function render_ticks(active_index) {
    const groups = [];
    for (const [index, step] of plan.entries()) {
      const label = step.kind === 'tap' ? SIGNAL_LABELS[step.signal] : step.kind === 'remove' ? 'Out' : 'Back';
      const key = step.kind === 'tap' ? step.signal + step.mode : step.kind;
      let group = groups.find(item => item.key === key);
      if (!group) {
        group = { key, label, cells: [] };
        groups.push(group);
      }
      const record = records[index];
      const state = index === active_index ? 'active'
        : !record ? 'todo'
        : record.recognized.includes(record.signal) ? 'hit' : 'miss';
      group.cells.push(state);
    }
    elements.ticks.replaceChildren(...groups.map(group => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = group.label;
      const cells = document.createElement('span');
      cells.className = 'tick-cells';
      for (const state of group.cells) {
        const cell = document.createElement('i');
        cell.dataset.state = state;
        cells.append(cell);
      }
      row.append(name, cells);
      return row;
    }));
  }

  function render_trial(step, index, phase) {
    elements.count.textContent = 'Step ' + (index + 1) + ' of ' + plan.length;
    elements.phase.textContent = phase;
    elements.phase.dataset.phase = phase === 'Now' ? 'now' : phase === 'Got it' ? 'hit' : phase === 'Not recognized' ? 'miss' : 'ready';
    elements.pattern.textContent = step.gestureModel ? 'Next Track ' + (step.signal === 'R2' ? 'twice' : 'three times')
      : step.kind === 'remove' ? 'Remove an earbud'
      : step.kind === 'insert' ? 'Put the earbud back' : PATTERNS[step.mode][step.signal];
    elements.detail.textContent = 'Try ' + (step.trial + 1) + ' of ' + TRIALS_PER_PATTERN;
    elements.bar.style.transform = 'scaleX(' + (index + (phase === 'Get ready' ? 0 : 0.5)) / plan.length + ')';
    render_ticks(index);
  }

  function wait_for_response(window_ms, settle_ms) {
    return new Promise(resolve => {
      let settle_timer;
      const finish = () => {
        clearTimeout(window_timer);
        clearTimeout(settle_timer);
        waiter = null;
        resolve();
      };
      const window_timer = setTimeout(finish, window_ms);
      waiter = {
        poke() {
          clearTimeout(settle_timer);
          settle_timer = setTimeout(finish, settle_ms);
        },
        cancel: finish,
      };
    });
  }

  async function run_trial(step, index, alive) {
    const settings = services.get_settings();
    const app = settings.app;
    const record = { ...step, promptAt: null, events: [], early: [], recognized: [], rejected: 0 };
    services.input.configure({ mode: step.mode });
    if (step.gestureModel) services.input.configure({ timing: { countWindowMs: COUNT_CALIBRATION_WINDOW_MS } });
    if (step.kind !== 'insert') {
      services.input.reset();
      services.resume_media();
    }
    const is_tap = step.kind === 'tap';
    if (is_tap) {
      lead = record;
      render_trial(step, index, 'Get ready');
      await sleep(app.calibrationLeadMs);
      if (!alive()) return;
    }

    if (step.gestureModel) services.input.reset();
    record.promptAt = services.audio.play_cue('system') ?? performance.now();
    lead = null;
    current = record;
    render_trial(step, index, 'Now');
    if (services.is_sim() && elements.emulate.checked) {
      for (const { action, offsetMs } of patternFor(step.signal, step.mode, settings.emulator)) {
        services.emulator.gesture(action, app.emulatedReactionMs + offsetMs);
      }
    }
    await wait_for_response(
      step.gestureModel ? Math.max(app.calibrationWindowMs, 2 * COUNT_CALIBRATION_WINDOW_MS + 1500)
        : is_tap ? app.calibrationWindowMs : app.calibrationRemovalWindowMs,
      step.gestureModel ? COUNT_CALIBRATION_WINDOW_MS : is_tap ? app.calibrationSettleMs : app.calibrationRemovalSettleMs,
    );
    if (!alive()) return;
    services.input.flush();
    current = null;
    records[index] = record;
    const matched = record.recognized.includes(step.signal);
    const leads_to_reinsertion = step.kind === 'remove';
    if (!matched || !leads_to_reinsertion) services.audio.play_cue(matched ? 'sent' : 'error');
    render_trial(step, index, matched ? 'Got it' : 'Not recognized');
    if (!matched) {
      const detail = record.events.length
        ? 'Received ' + record.events.map(event => ACTION_LABELS[event.action]).join(', ') + '.'
        : record.early.length ? 'Received an event early. Wait for Now.' : 'Safari received no media event.';
      elements.detail.textContent = detail + (step.gestureModel ? ' Retrying this step.' : '');
    }
    render_ticks(-1);
    await sleep(leads_to_reinsertion ? 0 : app.calibrationRestMs);
    return matched;
  }

  function restore_input() {
    services.emulator.reset();
    services.input.configure({ mode: original_mode, timing: {
      countWindowMs: undefined, ...services.get_settings().timing,
    } });
    services.input.reset();
    services.resume_media();
  }

  function source_label() {
    if (services.is_sim()) return 'emulated';
    return manual_events ? 'manual' : 'real';
  }

  function build_output() {
    const settings = services.get_settings();
    const tuned = tuneCalibration(records.map(normalize_trial), {
      timing: settings.timing ?? DEFAULT_TIMING,
      emulator: settings.emulator,
    });
    const summary = summarize_trials(records);
    const profile = {
      version: PROFILE_VERSION,
      seat: services.get_seat(),
      source: source_label(),
      gestureModel: records[0]?.gestureModel,
      createdAt: new Date().toISOString(),
      timing: tuned.timing,
      emulator: tuned.emulator,
      metrics: { ...tuned.metrics, ...summary },
    };
    return {
      profile,
      trials: records.map(record => ({
        signal: record.signal, mode: record.mode, kind: record.kind, trial: record.trial,
        promptAt: record.promptAt, events: record.events, early: record.early,
        recognized: record.recognized, rejected: record.rejected,
      })),
    };
  }

  function apply_output() {
    const outcome = services.on_apply(last_output.profile);
    applied = outcome.applied;
    elements.apply.hidden = true;
    if (outcome.applied) {
      elements.applied.textContent = last_output.profile.gestureModel
        ? 'Saved on this phone.'
        : last_output.profile.source === 'real'
        ? 'Applied to this phone and sent to the hub.'
        : 'Applied for testing. Labeled ' + last_output.profile.source + ', not a real earbud profile.';
    } else {
      elements.applied.textContent = outcome.reason;
    }
    return outcome.applied;
  }

  function finish() {
    running = false;
    restore_input();
    services.on_run_state(false);
    try {
      last_output = build_output();
    } catch (error) {
      last_output = null;
      elements.verdict.textContent = 'Calibration failed';
      elements.metrics.replaceChildren();
      elements.applied.textContent = 'Nothing changed. ' + (error?.message ?? '');
      elements.apply.hidden = true;
      elements.download.hidden = true;
      show('result');
      return;
    }
    const { profile } = last_output;
    const enough_events = profile.metrics.responseRate >= MIN_RESPONSE_RATE;
    const personal = profile.gestureModel === 'next-only';
    const calibrated = personal
      ? ['R2', 'L1'].every(signal => records.filter(trial => trial.signal === signal && trial.recognized.includes(signal)).length >= 2)
      : enough_events && profile.metrics.recognizedRate >= MIN_RECOGNITION_RATE;
    // No events at all means the earbuds never reached the phone. That is not a timing fit: an all-miss
    // profile would be stored as the seat's real profile and make the simulator drop every tap.
    const silent = profile.metrics.responded === 0;
    elements.verdict.textContent = silent ? 'No earbud events'
      : calibrated ? 'Calibrated' : enough_events ? 'Review the timing' : 'Too few taps';
    elements.metrics.replaceChildren(...metric_rows(profile).map(([label, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      row.append(term, description);
      return row;
    }));
    elements.download.hidden = personal;
    if (silent) {
      elements.applied.textContent = 'The phone received no earbud events, so nothing changed.';
      elements.apply.hidden = true;
    } else if (calibrated) {
      apply_output();
    } else {
      elements.applied.textContent = 'Recognized ' + profile.metrics.recognized + ' of '
        + profile.metrics.trials + ' patterns. The current profile is still active.';
      elements.apply.hidden = personal;
    }
    show('result');
  }

  async function run() {
    const token = ++run_token;
    const alive = () => token === run_token;
    const settings = services.get_settings();
    original_mode = settings.mode;
    plan = build_plan(selected_scope(), original_mode, services.is_sim() ? null : settings.gesture_model);
    records = [];
    manual_events = 0;
    last_output = null;
    applied = false;
    running = true;
    elements.run_skip.hidden = context.from !== 'setup';
    services.on_run_state(true);
    show('run');
    for (let index = 0; index < plan.length; index += 1) {
      if (!alive()) return;
      const step = plan[index];
      while (alive()) {
        if (await run_trial(step, index, alive) || !step.gestureModel) break;
      }
    }
    if (alive()) finish();
  }

  function stop() {
    if (!running) return;
    run_token += 1;
    running = false;
    current = null;
    lead = null;
    waiter?.cancel();
    restore_input();
    services.on_run_state(false);
    render_intro();
    show('intro');
  }

  function download() {
    if (!last_output) return;
    const payload = JSON.stringify(last_output, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    const stamp = last_output.profile.createdAt.replaceAll(':', '-').replace(/\..+$/, '');
    anchor.href = url;
    anchor.download = 'telepathy-calibration-' + last_output.profile.seat + '-' + stamp + '.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function stop_check() {
    if (!checking) return;
    checking = false;
    checked_actions.clear();
    services.input.reset();
    elements.quick_continue.hidden = true;
    elements.quick_start.textContent = 'Test earbud controls';
    elements.quick_status.textContent = '';
    services.on_run_state(false);
  }

  function render_control_check(received) {
    if (elements.quick_model.value !== 'pro') {
      const item = $('cal-quick-nexttrack');
      item.textContent = checked_actions.has('nexttrack') ? 'Next Track received' : 'Waiting for one Next Track event';
      $('cal-quick-pause').hidden = true;
      $('cal-quick-previoustrack').hidden = true;
      elements.quick_status.textContent = received === 'nexttrack'
        ? 'Safari received the double-tap. Start the timing trials when ready.'
        : received ? 'Safari sent ' + ACTION_LABELS[received] + '. Set the earbud double-tap to Next Track.'
          : 'Double-tap the earbud assigned to Next Track once. If nothing changes, check that Control Center shows Telepathy in Now Playing.';
      elements.quick_continue.textContent = 'Start timing trials';
      elements.quick_continue.hidden = !checked_actions.has('nexttrack');
      return;
    }
    $('cal-quick-pause').hidden = false;
    $('cal-quick-previoustrack').hidden = false;
    elements.quick_continue.textContent = 'Continue with defaults';
    for (const [action, gesture] of CONTROL_STEPS) {
      const item = $('cal-quick-' + action);
      item.textContent = SQUEEZE_LABELS[action] + (checked_actions.has(action) ? ' · received' : ' · ' + gesture);
    }
    const next = CONTROL_STEPS.find(([action]) => !checked_actions.has(action));
    elements.quick_status.textContent = !received
      ? 'Pause Spotify or other audio first. Start with a single squeeze.'
      : !next ? 'All three squeezes reached Telepathy.'
        : 'Received ' + SQUEEZE_LABELS[received].toLowerCase() + '. Try ' + SQUEEZE_LABELS[next[0]].toLowerCase() + ' next.';
    elements.quick_continue.hidden = !checked_actions.size;
  }

  elements.quick_model.addEventListener('change', () => {
    services.set_gesture_model?.(elements.quick_model.value);
    render_intro();
  });
  elements.quick_start.addEventListener('click', () => {
    if (checking) return stop_check();
    if (!services.get_seat() || services.is_sim() || running) return;
    services.set_gesture_model?.(elements.quick_model.value);
    services.input.reset();
    checking = true;
    elements.quick_start.textContent = 'Stop listening';
    render_control_check();
    services.arm();
    services.on_run_state(true);
  });
  elements.quick_continue.addEventListener('click', () => {
    if (!checking || !checked_actions.size) return;
    const calibrate_timing = elements.quick_model.value !== 'pro';
    if (calibrate_timing && !checked_actions.has('nexttrack')) return;
    stop_check();
    if (calibrate_timing) {
      services.arm();
      void run();
    } else services.on_exit({ skipped: true });
  });
  elements.start.addEventListener('click', () => {
    stop_check();
    services.arm();
    void run();
  });
  elements.again.addEventListener('click', () => {
    services.arm();
    void run();
  });
  elements.stop.addEventListener('click', stop);
  elements.run_skip.addEventListener('click', () => {
    stop();
    services.on_exit({ skipped: true });
  });
  elements.skip.addEventListener('click', () => {
    stop_check();
    services.on_exit({ skipped: true });
  });
  elements.apply.addEventListener('click', apply_output);
  elements.download.addEventListener('click', download);
  elements.done.addEventListener('click', () => services.on_exit({ skipped: false, completed: applied }));

  return {
    open(options = {}) {
      context = { from: options.from ?? 'settings' };
      if (running) return;
      const model = services.get_settings().gesture_model;
      if (model) elements.quick_model.value = model;
      elements.emulate.checked = services.is_sim();
      render_intro();
      show('intro');
    },
    refresh() { if (!running) render_intro(); },
    stop,
    active: () => running || checking,
    note_media_event(action) {
      if (checking && elements.quick_model.value !== 'pro') {
        if (action === 'nexttrack') checked_actions.add(action);
        render_control_check(action);
        return;
      }
      if (action === 'play') action = 'pause';
      if (!checking || !Object.hasOwn(SQUEEZE_LABELS, action)) return;
      checked_actions.add(action);
      render_control_check(action);
    },
    mark_manual() { if (running) manual_events += 1; },
    note_raw(event) {
      if (!running) return;
      if (current) {
        current.events.push({ action: event.action, at: event.at });
        if (!services.is_sim() && ACTION_LABELS[event.action]) {
          elements.detail.textContent = 'Received ' + current.events.map(entry => ACTION_LABELS[entry.action]).join(', ') + '.';
        }
        waiter?.poke();
      } else if (lead) {
        lead.early.push({ action: event.action, at: event.at });
      }
    },
    note_signal(signal) { if (current) current.recognized.push(signal); },
    note_reject() { if (current) current.rejected += 1; },
  };
}
