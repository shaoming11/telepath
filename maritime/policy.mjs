export const PITCH_BEATS = Object.freeze(['opening', 'problem', 'demo', 'closing']);
export const COACH_CUES = Object.freeze(['sound-check', 'demo-cue', 'time-cue', 'reveal-cue']);

const DEMO_TARGET_SECONDS = 60;
const PITCH_BUDGET_SECONDS = 120;
const FINAL_CUE_SECONDS = PITCH_BUDGET_SECONDS - 30;
const SEAT_COUNT = 2;
const MAX_ELAPSED_SECONDS = 86_400;
const MAX_ACKNOWLEDGED_MESSAGES = 10_000;

function boundedInteger(value, upper) {
  return Number.isSafeInteger(value) && value >= 0 && value <= upper;
}

export function normalizePitch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { beat, elapsedSeconds, onlineSeats, readySeats, acknowledgedMessages } = value;
  if (!PITCH_BEATS.includes(beat) || !boundedInteger(elapsedSeconds, MAX_ELAPSED_SECONDS)
    || !boundedInteger(onlineSeats, SEAT_COUNT) || !boundedInteger(readySeats, onlineSeats)
    || !boundedInteger(acknowledgedMessages, MAX_ACKNOWLEDGED_MESSAGES)) return null;
  return { beat, elapsedSeconds, onlineSeats, readySeats, acknowledgedMessages };
}

export function recommendLocally({ beat, elapsedSeconds, readySeats, acknowledgedMessages }) {
  if (beat === 'closing') {
    return { cueId: 'reveal-cue', reason: 'The pitch is closing. Bring up the reveal to show what each seat heard.' };
  }
  if (beat === 'problem' && elapsedSeconds > DEMO_TARGET_SECONDS) {
    return { cueId: 'demo-cue', reason: 'The explanation crossed the one-minute mark. Let the working demo make the point.' };
  }
  if (readySeats < SEAT_COUNT || acknowledgedMessages === 0) {
    return { cueId: 'sound-check', reason: 'Check that both seats can hear the cue before relying on a live exchange.' };
  }
  if (elapsedSeconds >= FINAL_CUE_SECONDS) {
    return { cueId: 'time-cue', reason: 'The pitch has reached its final thirty seconds. Cue both seats to wrap up.' };
  }
  if (beat === 'demo') {
    return { cueId: 'reveal-cue', reason: 'A live exchange has been acknowledged. The reveal can show how it worked.' };
  }
  return { cueId: 'demo-cue', reason: 'Both seats are ready. Show the exchange while there is time to explain it.' };
}

export function reviewCue(pitch, candidateCueId) {
  const baseline = recommendLocally(pitch);
  if (candidateCueId === baseline.cueId) return { ...baseline, engine: 'assisted' };
  if (candidateCueId === 'demo-cue' && pitch.beat === 'opening'
    && pitch.readySeats === SEAT_COUNT && pitch.elapsedSeconds < FINAL_CUE_SECONDS) {
    return { cueId: candidateCueId, reason: 'Both seats completed setup. Begin the live demo to establish the first exchange.', engine: 'assisted' };
  }
  if (candidateCueId === 'reveal-cue' && pitch.beat === 'demo'
    && pitch.readySeats === SEAT_COUNT && pitch.acknowledgedMessages > 0) {
    return { cueId: candidateCueId, reason: 'A live exchange has been acknowledged. Lead with the reveal to explain it before time runs out.', engine: 'assisted' };
  }
  return { ...baseline, engine: 'rules' };
}

const PITCH_HELP_INTENTS = ['answer', 'add_point', 'next_beat'];
const MAX_HELP_TURNS = 6;
const MAX_HELP_PASSAGES = 4;

export function normalizePitchHelp(value) {
  if (value?.type !== 'pitch_help' || !['A', 'B'].includes(value.seat)
      || !boundedInteger(value.elapsedSeconds, MAX_ELAPSED_SECONDS)
      || !Array.isArray(value.turns) || !Array.isArray(value.passages)) return null;
  const clip = (input, size) => typeof input === 'string' ? input.trim().slice(0, size) : '';
  return {
    type: 'pitch_help',
    seat: value.seat,
    elapsedSeconds: value.elapsedSeconds,
    turns: value.turns.slice(-MAX_HELP_TURNS).flatMap(turn => {
      const text = clip(turn?.text, 260);
      return text ? [{ text, speaker: clip(turn.speaker, 32) }] : [];
    }),
    passages: value.passages.slice(0, MAX_HELP_PASSAGES).flatMap(passage => {
      const id = clip(passage?.id, 100);
      const text = clip(passage?.text, 560);
      return id && text ? [{ id, text }] : [];
    }),
  };
}

export function validatePitchHelpPlan(value, input) {
  if (!PITCH_HELP_INTENTS.includes(value?.intent) || !Array.isArray(value.passageIds)
      || value.passageIds.length > MAX_HELP_PASSAGES || !value.passageIds.every(id => input.passages.some(passage => passage.id === id))) return null;
  return { intent: value.intent, passageIds: [...new Set(value.passageIds)] };
}

export function planPitchHelp(input) {
  const recent = input.turns.slice(-3);
  const question = recent.findLastIndex(turn => /\?|^\s*(?:could you|can you|what|why|how|who|when|where|does|do you|is it)\b/i.test(turn.text));
  const unanswered = question === recent.length - 1 || recent.slice(question + 1).every(turn => turn.speaker === recent[question]?.speaker);
  return {
    intent: question < 0 ? 'next_beat' : unanswered ? 'answer' : 'add_point',
    passageIds: input.passages.slice(0, 2).map(passage => passage.id),
  };
}
