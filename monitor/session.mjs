const SEATS = ['A', 'B'];
const HISTORY = 12;
const FRESH_MS = 1800;
const PLAYBACK_STATES = new Set(['idle', 'queued', 'playing', 'paused']);

function level(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function createSessionMonitor(now = Date.now) {
  const inputs = new Map();
  const outputs = new Map();
  const partials = new Map();
  let agent;
  let read_context;

  function reset() {
    inputs.clear();
    outputs.clear();
    partials.clear();
    agent = { phase: 'idle', summary: '', at: null };
    read_context = {};
  }

  function updateInput(seat, value) {
    const previous = inputs.get(seat);
    const at = now();
    const recent = previous && at - previous.at <= FRESH_MS ? previous.bars : [];
    inputs.set(seat, { at, bars: [...recent.slice(1 - HISTORY), level(value)] });
  }

  function updateOutput(seat, value) {
    if (!PLAYBACK_STATES.has(value.phase)) return false;
    outputs.set(seat, {
      phase: value.phase,
      title: text(value.title, 120),
      bars: Array.isArray(value.bars) ? value.bars.slice(0, HISTORY).map(level) : [],
      at: now(),
    });
    return true;
  }

  function clearSeat(seat) {
    inputs.delete(seat);
    outputs.delete(seat);
    partials.delete(seat);
  }

  function updatePartial(seat, value) {
    const clean = text(value, 145);
    if (clean) partials.set(seat, clean);
    else partials.delete(seat);
  }

  function startAnalysis(seats, { preset, mode, requestedSeat } = {}) {
    read_context = Object.fromEntries([...SEATS, 'room'].map(seat => {
      const lines = seats[seat]?.transcript ?? [];
      return [seat, { count: lines.length, excerpt: text(lines.at(-1)?.text, 190) }];
    }));
    agent = {
      phase: 'evaluating',
      summary: requestedSeat ? 'Reviewing a requested signal' : 'Reading recent room context',
      at: now(),
      preset: text(preset, 35),
      mode: text(mode, 32),
    };
  }

  function setAnalysis(phase, summary) {
    agent = { ...agent, phase, summary: text(summary, 100), at: now() };
  }

  function snapshot(seats, viewer, { room, activity } = {}) {
    const visible = viewer == null ? SEATS : [viewer];
    return {
      agent: activity ?? agent,
      sharedRoom: room ? 'A' : null,
      seats: Object.fromEntries(visible.map(seat => {
        const state = seats[seat];
        const source = room ? 'room' : seat;
        const input = inputs.get(source);
        const input_state = room ?? state;
        const latest = input_state.transcript.at(-1);
        const output = outputs.get(seat);
        const input_fresh = input_state.listening && input && now() - input.at <= FRESH_MS;
        const output_fresh = state.online && output && now() - output.at <= FRESH_MS;
        return [seat, {
          name: text(state.name, 30),
          online: state.online,
          source: room ? 'companion' : input_state.roomMicSource ?? null,
          listening: input_state.listening,
          transcription: input_state.transcription,
          input: input_fresh ? input.bars : [],
          output: output_fresh ? output : { phase: 'idle', bars: [], title: '' },
          recent: text(latest?.text, 190),
          partial: input_state.listening ? partials.get(source) ?? '' : '',
          speakers: [...new Set((latest?.speakers ?? []).map(run => text(run.label, 28)).filter(Boolean))],
          recentRuns: input_state.transcript.slice(-3).flatMap(entry => entry.speakers?.length ? entry.speakers : [
            { label: 'Room', text: entry.text },
          ]).slice(-2).map(run => ({ label: text(run.label, 28), text: text(run.text, 145) })),
          situation: text(state.situation, 100),
          context: read_context[source] ?? { count: 0, excerpt: '' },
          drafted: Boolean(state.pending),
        }];
      })),
    };
  }

  reset();
  return { reset, updateInput, updateOutput, updatePartial, clearSeat, startAnalysis, setAnalysis, snapshot };
}
