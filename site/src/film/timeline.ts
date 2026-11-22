// The film is a pure function of time. `hold` is the composed frame a beat settles on when stepped through.
// The scroll story, the /film route and the launch video all seek it.
export type Beat = { id: string; start: number; end: number; hold: number; line: string; note: string };

export const BEATS: Beat[] = [
  { id: "silence", start: 0, end: 8, hold: 7.2, line: "Say it without saying it.", note: "Two people in one room. Anything they say to each other, everyone hears." },
  { id: "tap", start: 8, end: 18, hold: 15.7, line: "One tap. Your voice, in their ear.", note: "Tap an AirPod and your partner hears the line as a whisper, in your voice." },
  { id: "meanings", start: 18, end: 28, hold: 26.3, line: "Four messages, ready before you begin.", note: "One tap, two taps, three taps, or an earbud out. Each sends a line you chose." },
  { id: "asks", start: 28, end: 38, hold: 37.1, line: "The AI drafts. You decide.", note: "The assistant suggests a line to you alone. It goes nowhere until you tap." },
  { id: "reveal", start: 38, end: 46, hold: 45.4, line: "It was on the whole time.", note: "Every message from this pitch, in order." },
];

export const FILM_SECONDS = BEATS[BEATS.length - 1].end;

export function beatAt(t: number): Beat {
  return BEATS.find(beat => t < beat.end) ?? BEATS[BEATS.length - 1];
}
