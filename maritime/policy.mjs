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
