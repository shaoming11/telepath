import { CatmullRomCurve3, QuadraticBezierCurve3, Vector3 } from "three";

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ramp = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const span = (t: number, inA: number, inB: number, outA: number, outB: number) =>
  Math.min(ramp(t, inA, inB), 1 - ramp(t, outA, outB));

export const SEAT_A = "#ff9f0a";
export const SEAT_B = "#4da3ff";
export const NEUTRAL = "#f5f5f7";

export const A_POS = new Vector3(-3.2, 0.5, 0);
export const B_POS = new Vector3(3.2, 0.5, 0);
const A_EAR = new Vector3(-2.62, 0.55, 0.25);
const B_EAR = new Vector3(2.62, 0.55, 0.25);

const arc = (from: Vector3, to: Vector3, apex: number, z = 0) =>
  new QuadraticBezierCurve3(from, new Vector3((from.x + to.x) / 2, from.y + apex * 2, z), to);

export type Pulse = {
  id: string;
  curve: QuadraticBezierCurve3;
  color: string;
  launch: number;
  land: number;
  fade: number;
  label?: { text: string; taps: string; at: "apex" | "A" | "B"; caption?: string };
  inReveal: boolean;
};

export const TAP_1 = 10.4;
export const TAP_2 = 34.0;

const FAN = [
  { text: "Slow down", taps: "One tap" },
  { text: "One minute left", taps: "Two taps" },
  { text: "Show the demo now", taps: "Three taps" },
  { text: "Wrap it up now", taps: "Earbud out" },
];

export const PULSES: Pulse[] = [
  {
    id: "first", curve: arc(B_EAR, A_EAR, 0.7), color: SEAT_B, launch: 10.7, land: 13.6, fade: 17.6, inReveal: true,
    label: { text: "Slow down", taps: "", at: "A", caption: "In your partner’s voice" },
  },
  { id: "receipt", curve: arc(A_EAR, B_EAR, -0.45, 0.4), color: SEAT_A, launch: 16.3, land: 17.9, fade: 18.4, inReveal: true },
  ...FAN.map((entry, i): Pulse => ({
    id: "fan" + i, curve: arc(B_EAR, A_EAR, 0.55 + i * 0.62, -0.2 * i), color: SEAT_B,
    launch: 19.6 + i * 1.15, land: 21.8 + i * 1.15, fade: 27.4, inReveal: i < 2,
    label: { ...entry, at: "apex" },
  })),
  {
    id: "draft", curve: new QuadraticBezierCurve3(new Vector3(0.4, -4.2, 1.5), new Vector3(3.4, -2.6, 2.2), new Vector3(3.1, 0.2, 0.7)),
    color: NEUTRAL, launch: 29.2, land: 31.4, fade: 34.4, inReveal: false,
    label: { text: "The judge on the left looks lost", taps: "", at: "B", caption: "A draft. Only you hear it." },
  },
  {
    id: "approved", curve: arc(B_EAR, A_EAR, 1.1), color: SEAT_B, launch: 34.25, land: 36.5, fade: 37.7, inReveal: true,
    label: { text: "The judge on the left looks lost", taps: "", at: "A", caption: "Sent after your tap" },
  },
];

type Key = { t: number; pos: [number, number, number]; look: [number, number, number] };

const KEYS: Key[] = [
  { t: 0, pos: [5.9, 0.65, 3.4], look: [3.2, -0.65, 0.0] },
  { t: 4, pos: [4.6, 0.25, 6.4], look: [2.5, -0.75, 0.0] },
  { t: 7.6, pos: [0.0, 0.05, 13.4], look: [0.0, -0.95, 0.0] },
  { t: 10.2, pos: [4.3, -0.05, 5.8], look: [2.9, -0.95, 0.0] },
  { t: 12.6, pos: [0.4, 0.65, 12.2], look: [0.0, -0.45, 0.0] },
  { t: 15.2, pos: [-4.4, -0.05, 6.2], look: [-2.5, -0.75, 0.0] },
  { t: 17.6, pos: [-3.4, 0.35, 8.6], look: [-1.6, -0.65, 0.0] },
  { t: 20.4, pos: [0.0, 2.35, 14.2], look: [0.0, 0.35, 0.0] },
  { t: 26.6, pos: [0.5, 2.65, 13.4], look: [0.0, 0.45, 0.0] },
  { t: 30, pos: [4.6, -1.15, 7.2], look: [2.7, -1.25, 0.0] },
  { t: 33.8, pos: [4.2, -0.55, 6.4], look: [2.8, -0.95, 0.0] },
  { t: 36.4, pos: [-0.6, 0.45, 12.6], look: [-0.4, -0.55, 0.0] },
  { t: 39.6, pos: [0.0, 0.65, 14.6], look: [0.0, -0.65, 0.0] },
  { t: 46, pos: [0.0, 0.15, 16.2], look: [0.0, -0.75, 0.0] },
];

const posCurve = new CatmullRomCurve3(KEYS.map(k => new Vector3(...k.pos)), false, "centripetal");
const lookCurve = new CatmullRomCurve3(KEYS.map(k => new Vector3(...k.look)), false, "centripetal");

function keyU(t: number) {
  const last = KEYS.length - 1;
  if (t <= KEYS[0].t) return 0;
  if (t >= KEYS[last].t) return 1;
  const i = KEYS.findIndex(k => k.t > t) - 1;
  const local = (t - KEYS[i].t) / (KEYS[i + 1].t - KEYS[i].t);
  return (i + local * local * (3 - 2 * local)) / last;
}

// Narrow viewports back the camera away so both earbuds stay in frame.
export function cameraAt(t: number, aspect: number, pos: Vector3, look: Vector3) {
  const u = keyU(t);
  posCurve.getPoint(u, pos);
  lookCurve.getPoint(u, look);
  const widen = Math.max(1, 1.5 / aspect);
  if (widen > 1) pos.sub(look).multiplyScalar(widen).add(look);
}

export const REVEAL_START = 38;
export const REVEAL_Y = 0.55;
export const TAPS = [
  { t: TAP_1, seat: "B" as const },
  { t: 16.1, seat: "A" as const },
  ...[0, 1, 2, 3].map(i => ({ t: 19.35 + i * 1.15, seat: "B" as const })),
  { t: TAP_2, seat: "B" as const },
];
