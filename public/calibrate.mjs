import { DEFAULT_TIMING, patternFor, tuneCalibration } from './input.mjs';
import { CALIBRATION_SIGNALS, MEASURE_TEXT, PATTERN_LABELS, SIGNAL_LABELS } from './phone-data.mjs';

export const TRIALS_PER_PATTERN = 3;
export const MIN_RESPONSE_RATE = 0.6;
const MIN_RECOGNITION_RATE = 0.75;

const PROFILE_VERSION = 1;
const TRACK_ACTIONS = new Set(['nexttrack', 'previoustrack']);

const $ = id => document.getElementById(id);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function build_plan(scope, current_mode) {
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
  return { signal: record.signal, mode: record.mode, promptAt: record.promptAt, events };
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
    ['Left-right gap', format_ms(emulator.mixedGapMs)],
    ['Fast limit', format_ms(timing.fastMaxMs)],
    ['One-ear fast limit', format_ms(timing.oneEarFastMaxMs || timing.fastMaxMs)],
    ['Pattern close', format_ms(timing.closeMs)],
  ];
}

export function createCalibration(services) {
  const elements = {
    intro: $('cal-intro'), run: $('cal-run'), result: $('cal-result'),
    seat_row: $('cal-seat'), emulate_row: $('cal-emulate-row'), emulate: $('cal-emulate'),
    start: $('cal-start'), skip: $('cal-skip'), stop: $('cal-stop'),
    count: $('cal-count'), phase: $('cal-phase'), pattern: $('cal-pattern'), detail: $('cal-detail'),
    bar: $('cal-bar'), ticks: $('cal-ticks'),
    verdict: $('cal-verdict'), metrics: $('cal-metrics'), applied: $('cal-applied'),
    apply: $('cal-apply'), download: $('cal-download'), done: $('cal-done'), again: $('cal-again'),
    measure: $('cal-measure'), hint: $('cal-start-hint'),
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
    elements.start.disabled = !has_seat;
    elements.skip.hidden = context.from !== 'setup';
    elements.hint.textContent = !has_seat ? 'Pick a seat to start.'
      : sim ? 'Simulated seat. Keys R, L, O and I send raw actions, or let the emulator tap.'
      : 'Wear your earbuds. The steps advance on their own, so you do not need to touch the phone.';
  }

  function render_ticks(active_index) {
    const groups = [];
    for (const [index, step] of plan.entries()) {
      const label = step.kind === 'tap' ? SIGNAL_LABELS[step.signal] + ' · ' + (step.mode === 1 ? 'One' : 'Two') : step.kind === 'remove' ? 'Out' : 'Back';
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
    elements.pattern.textContent = PATTERN_LABELS[step.mode][step.signal];
    elements.detail.textContent = (step.kind === 'tap' ? (step.mode === 1 ? 'One-earbud' : 'Two-earbud') + ' pattern' : 'Earbud') + ', try ' + (step.trial + 1) + ' of ' + TRIALS_PER_PATTERN;
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
      is_tap ? app.calibrationWindowMs : app.calibrationRemovalWindowMs,
      is_tap ? app.calibrationSettleMs : app.calibrationRemovalSettleMs,
    );
    if (!alive()) return;
    services.input.flush();
    current = null;
    records[index] = record;
    const matched = record.recognized.includes(step.signal);
    const leads_to_reinsertion = step.kind === 'remove';
    if (!matched || !leads_to_reinsertion) services.audio.play_cue(matched ? 'sent' : 'error');
    render_trial(step, index, matched ? 'Got it' : 'Not recognized');
    render_ticks(-1);
    await sleep(leads_to_reinsertion ? 0 : app.calibrationRestMs);
  }

  function restore_input() {
    services.emulator.reset();
    services.input.configure({ mode: original_mode });
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
      elements.applied.textContent = last_output.profile.source === 'real'
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
    const calibrated = enough_events && profile.metrics.recognizedRate >= MIN_RECOGNITION_RATE;
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
    elements.download.hidden = false;
    if (silent) {
      elements.applied.textContent = 'The phone received no earbud events, so nothing changed.';
      elements.apply.hidden = true;
    } else if (calibrated) {
      apply_output();
    } else {
      elements.applied.textContent = 'Recognized ' + profile.metrics.recognized + ' of '
        + profile.metrics.trials + ' patterns. The current profile is still active.';
      elements.apply.hidden = false;
    }
    show('result');
  }

  async function run() {
    const token = ++run_token;
    const alive = () => token === run_token;
    const settings = services.get_settings();
    original_mode = settings.mode;
    plan = build_plan(selected_scope(), original_mode);
    records = [];
    manual_events = 0;
    last_output = null;
    applied = false;
    running = true;
    services.on_run_state(true);
    show('run');
    for (let index = 0; index < plan.length; index += 1) {
      if (!alive()) return;
      await run_trial(plan[index], index, alive);
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

  elements.start.addEventListener('click', () => {
    services.arm();
    void run();
  });
  elements.again.addEventListener('click', () => {
    services.arm();
    void run();
  });
  elements.stop.addEventListener('click', stop);
  elements.skip.addEventListener('click', () => services.on_exit({ skipped: true }));
  elements.apply.addEventListener('click', apply_output);
  elements.download.addEventListener('click', download);
  elements.done.addEventListener('click', () => services.on_exit({ skipped: false, completed: applied }));

  return {
    open(options = {}) {
      context = { from: options.from ?? 'settings' };
      if (running) return;
      elements.emulate.checked = services.is_sim();
      render_intro();
      show('intro');
    },
    refresh() { if (!running) render_intro(); },
    stop,
    active: () => running,
    mark_manual() { if (running) manual_events += 1; },
    note_raw(event) {
      if (!running) return;
      if (current) {
        current.events.push({ action: event.action, at: event.at });
        waiter?.poke();
      } else if (lead) {
        lead.early.push({ action: event.action, at: event.at });
      }
    },
    note_signal(signal) { if (current) current.recognized.push(signal); },
    note_reject() { if (current) current.rejected += 1; },
  };
}
