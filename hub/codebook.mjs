const PITCH = Object.freeze({
  R1: 'Slow down',
  R2: 'One minute left',
  L1: 'Show the demo now',
  OUT: 'Wrap it up now',
});

export const BOOKS = Object.freeze({
  Pitch: PITCH,
  Party: Object.freeze({
    R1: 'Come find me',
    R2: 'Save me from this conversation',
    L1: "I'm good, stay",
    OUT: "Let's leave",
  }),
  Meeting: Object.freeze({
    R1: 'Are you following?',
    R2: "Let's talk after",
    L1: 'I agree, back it up',
    OUT: "I'm stepping out",
  }),
  Custom: PITCH,
});

export const DEFAULT_CONTEXT = Object.freeze({
  Pitch: 'Telepath pitch order: hook, two-seat setup, live silent exchange, reveal. Seat A presents. Seat B watches the judges and time. Before the exchange, help A pace the explanation. During the exchange, use concrete cues about what the coach actually reports. After the wrap-up, let the presenter bring up the timeline. Keep coaching terse. Treat an unreported judge reaction as unknown.',
  Party: 'Friends in a noisy social setting. Use casual, discreet suggestions to coordinate without interrupting a conversation.',
  Meeting: 'Colleagues in a meeting. Use discreet, concise suggestions tied to what was said.',
  Custom: 'Use the shared situation and the context provided by the operator.',
});

export const CANNED_PITCH = Object.freeze([
  { delay: 0, seat: 'A', transcript: 'What if your teammate could steer your pitch without interrupting it?' },
  { delay: 450, seat: 'B', transcript: 'We are on the setup slide. I can see the clock and the judges.' },
  { delay: 900, seat: 'B', signal: 'R1' },
  { delay: 3150, seat: 'A', receipt: true },
  { delay: 3750, seat: 'A', transcript: 'One tap sends a line in my teammate’s voice.' },
  { delay: 4250, seat: 'B', signal: 'R2' },
  { delay: 7250, seat: 'B', transcript: 'The judge on the left looks lost.' },
  { delay: 7750, seat: 'B', draft: 'The judge on the left looks lost' },
  { delay: 11500, seat: 'B', confirm: 'The judge on the left looks lost' },
  { delay: 14400, seat: 'A', transcript: 'Now let’s show what went across.' },
  { delay: 15100, seat: 'B', signal: 'OUT' },
  { delay: 18400, reveal: true },
]);

export const SEATS = Object.freeze(['A', 'B']);
export const SIGNALS = Object.freeze(['R1', 'R2', 'L1', 'L2', 'LR', 'OUT', 'BACK']);

export function partnerOf(seat) {
  return seat === 'A' ? 'B' : 'A';
}

export function bitsForMode(mode) {
  return Math.log2(mode === 1 ? 3 : 4);
}
