// The film is a pure function of time. The scroll story, the /film route and the launch video all seek it.
export type Beat = { id: string; start: number; end: number; line: string; note: string };

export const BEATS: Beat[] = [
  { id: "silence", start: 0, end: 8, line: "Say it without saying it.", note: "Two AirPods far apart in the dark." },
  { id: "tap", start: 8, end: 18, line: "One tap. Your voice, in their ear.", note: "A pulse crosses from Seat B to Seat A and becomes words." },
  { id: "meanings", start: 18, end: 28, line: "Four messages, ready before you begin.", note: "The tap fans out into the four fixed lines." },
  { id: "asks", start: 28, end: 38, line: "The AI drafts. You decide.", note: "A neutral draft returns to the sender and waits for a tap." },
  { id: "reveal", start: 38, end: 46, line: "It was on the whole time.", note: "Every pulse lays out on a timeline." },
];

export const FILM_SECONDS = BEATS[BEATS.length - 1].end;

export function beatAt(t: number): Beat {
  return BEATS.find(beat => t < beat.end) ?? BEATS[BEATS.length - 1];
}
