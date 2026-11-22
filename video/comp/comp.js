// The whole film is a pure function of time: draw(t) paints the frame for second t and nothing else.
const W = 1920, H = 1080;
const canvas = document.getElementById("frame");
const ctx = canvas.getContext("2d");
const query = new URLSearchParams(location.search);
const useFilm = query.get("film") === "1";

const timeline = await (await fetch("/timeline.json")).json();
const { cues, beats } = timeline;
const css = getComputedStyle(document.documentElement);
const token = name => css.getPropertyValue(name).trim();
const C = {
  void: token("--void"), raised: token("--surface-raised"), ink: token("--ink"), ink2: token("--ink-secondary"),
  ink3: token("--ink-tertiary"), a: token("--seat-a"), b: token("--seat-b"), ai: token("--assistant"), hairline: "rgba(255,255,255,0.14)",
};
const FONT = '"Inter Variable", "Helvetica Neue", sans-serif';
const MONO = 'ui-monospace, "DejaVu Sans Mono", monospace';

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, u) => a + (b - a) * u;
const span = (t, a, b) => clamp((t - a) / (b - a));
const outQuart = u => 1 - Math.pow(1 - clamp(u), 4);
const inOut = u => { u = clamp(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
const rgba = (hex, alpha) => {
  const n = parseInt(hex.replace("#", "").replace(/^(.)(.)(.)$/, "$1$1$2$2$3$3"), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
};
const window_ = (t, a, b, fadeIn = 0.6, fadeOut = 0.45) => outQuart(span(t, a, a + fadeIn)) * (1 - inOut(span(t, b - fadeOut, b)));

const A = { x: -560, y: 0 }, B = { x: 560, y: 0 };
let cam = { x: 0, y: 0, z: 1 };
const sx = x => W / 2 + (x - cam.x) * cam.z;
const sy = y => 470 + (y - cam.y) * cam.z;

const images = new Map();
function image(url) {
  if (!images.has(url)) {
    const img = new Image();
    img.src = url;
    images.set(url, img.decode().then(() => img, () => null));
  }
  return images.get(url);
}

function type(str, x, y, { size = 40, weight = 600, color = C.ink, alpha = 1, align = "center", track = -0.03, blur = 0, font = FONT } = {}) {
  if (alpha <= 0.003) return 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.letterSpacing = `${track * size}px`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  if (blur > 0.2) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  ctx.fillText(str, x, y);
  const width = ctx.measureText(str).width;
  ctx.restore();
  return width;
}

// Large claim: words rise and sharpen one after another, then leave together.
function headline(t, start, end, str, { y = 902, size = 84, weight = 600, color = C.ink, stagger = 0.075 } = {}) {
  if (t < start || t > end) return;
  const words = str.split(" ");
  ctx.save();
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.letterSpacing = `${-0.035 * size}px`;
  const gap = size * 0.24;
  const widths = words.map(word => ctx.measureText(word).width);
  ctx.restore();
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * (words.length - 1);
  const leave = 1 - inOut(span(t, end - 0.45, end));
  let x = W / 2 - total / 2;
  words.forEach((word, i) => {
    const enter = outQuart(span(t, start + i * stagger, start + i * stagger + 0.8));
    type(word, x, y + (1 - enter) * 26, { size, weight, color, alpha: enter * leave, align: "left", track: -0.035, blur: (1 - enter) * 10 });
    x += widths[i] + gap;
  });
}

function backdrop(lift = 0) {
  ctx.fillStyle = C.void;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 470, 0, W / 2, 470, 1100);
  glow.addColorStop(0, `rgba(29,29,31,${0.5 + lift * 0.5})`);
  glow.addColorStop(0.55, `rgba(11,11,13,${0.35 + lift * 0.45})`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function podPath(side) {
  const path = new Path2D();
  path.roundRect(-13, 6, 26, 158, 13);
  path.ellipse(side * -12, -20, 43, 47, side * 0.22, 0, Math.PI * 2);
  return path;
}

// A stylised AirPod: white body, seat-coloured rim light on its outer side and a pool of light beneath it.
function pod(seat, color, side, { light = 1, nudge = 0 } = {}) {
  const z = cam.z;
  ctx.save();
  ctx.translate(sx(seat.x) + nudge * z, sy(seat.y));
  ctx.scale(z, z);
  const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, 300);
  pool.addColorStop(0, rgba(color, 0.2 * light));
  pool.addColorStop(1, rgba(color, 0));
  ctx.save();
  ctx.translate(0, 206);
  ctx.scale(1, 0.16);
  ctx.fillStyle = pool;
  ctx.beginPath(); ctx.arc(0, 0, 300, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.rotate(side * -0.1);
  const shape = podPath(side);
  ctx.save();
  ctx.shadowColor = rgba(color, 0.85 * light);
  ctx.shadowBlur = 70 * z;
  ctx.fillStyle = "#000";
  ctx.fill(shape);
  ctx.restore();

  const body = ctx.createLinearGradient(-50 * side, -70, 50 * side, 170);
  body.addColorStop(0, "#ffffff");
  body.addColorStop(0.45, "#e6e6ea");
  body.addColorStop(1, "#8b8b91");
  ctx.fillStyle = body;
  ctx.globalAlpha = 0.25 + 0.75 * light;
  ctx.fill(shape);
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.clip(shape);
  const rim = ctx.createLinearGradient(side * 58, 0, side * -4, 0);
  rim.addColorStop(0, rgba(color, 0.95 * light));
  rim.addColorStop(0.55, rgba(color, 0.12 * light));
  rim.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = rim;
  ctx.fillRect(-80, -90, 160, 280);
  const shade = ctx.createLinearGradient(0, 40, 0, 170);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = shade;
  ctx.fillRect(-80, -90, 160, 280);
  const sheen = ctx.createRadialGradient(side * -26, -42, 0, side * -26, -42, 46);
  sheen.addColorStop(0, `rgba(255,255,255,${0.9 * light})`);
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(-80, -90, 160, 280);
  ctx.fillStyle = "#c9c9ce";
  ctx.fillRect(-14, 152, 28, 14);
  ctx.restore();

  ctx.fillStyle = "#19191b";
  ctx.beginPath(); ctx.ellipse(side * -47, -14, 5.5, 13, side * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, 34, 3.2, 9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function glowDot(x, y, radius, color, alpha) {
  if (alpha <= 0.003) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.35, rgba(color, alpha * 0.35));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}

const arc = (from, to, u, lift = 150) => ({ x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - Math.sin(Math.PI * u) * lift });

// A message is a pulse of light in the sender's colour.
function pulse(t, start, end, from, to, color, { lift = 150, size = 1 } = {}) {
  if (t < start || t > end + 0.5) return;
  const u = inOut(span(t, start, end));
  const fade = 1 - span(t, end, end + 0.5);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let k = 36; k >= 0; k--) {
    const uu = inOut(span(t - k * 0.016, start, end));
    if (uu <= 0) continue;
    const p = arc(from, to, uu, lift);
    const falloff = Math.pow(1 - k / 37, 2.2);
    glowDot(sx(p.x), sy(p.y), (10 + 46 * falloff) * cam.z * size, color, 0.34 * falloff * fade);
  }
  const head = arc(from, to, u, lift);
  glowDot(sx(head.x), sy(head.y), 120 * cam.z * size, color, 0.5 * fade);
  glowDot(sx(head.x), sy(head.y), 15 * cam.z * size, "#ffffff", 0.95 * fade);
  ctx.restore();
}

function ripple(t, at, seat, color, { dy = 60, count = 1 } = {}) {
  for (let i = 0; i < count; i++) {
    const age = t - at - i * 0.16;
    if (age < 0 || age > 1) continue;
    const u = outQuart(age);
    ctx.save();
    ctx.strokeStyle = rgba(color, 0.85 * Math.pow(1 - age, 2));
    ctx.lineWidth = lerp(5, 1, u) * cam.z;
    ctx.beginPath(); ctx.arc(sx(seat.x), sy(seat.y + dy), (16 + 150 * u) * cam.z, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}
const nudge = (t, at) => { const age = t - at; return age < 0 || age > 0.5 ? 0 : Math.sin(age * 26) * 3 * (1 - age / 0.5); };

function wave(t, x, y, amp, color, { bars = 37, pitch = 11 } = {}) {
  if (amp <= 0.003) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = rgba(color, 0.8);
  ctx.shadowBlur = 18 * cam.z;
  for (let i = 0; i < bars; i++) {
    const hann = Math.sin(Math.PI * (i + 0.5) / bars);
    const level = 0.12 + 0.88 * Math.abs(Math.sin(i * 0.71 + t * 8.3) * Math.sin(i * 0.23 - t * 5.1));
    const h = Math.max(4, 120 * amp * hann * level) * cam.z;
    const w = 4.5 * cam.z;
    ctx.globalAlpha = clamp(amp * 1.4);
    ctx.beginPath();
    ctx.roundRect(sx(x + (i - (bars - 1) / 2) * pitch) - w / 2, sy(y) - h / 2, w, h, w / 2);
    ctx.fill();
  }
  ctx.restore();
}

const pods = (t, opts = {}) => {
  pod(A, C.a, 1, { light: opts.light ?? 1, nudge: opts.nudgeA ?? 0 });
  pod(B, C.b, -1, { light: opts.light ?? 1, nudge: opts.nudgeB ?? 0 });
};

function sceneSilence(t) {
  cam = { x: 0, y: 0, z: lerp(0.8, 0.9, t / 8) };
  backdrop();
  pods(t, { light: inOut(span(t, 0.4, 3.4)) });
}

function sceneTap(t) {
  const close = { x: 380, y: 30, z: 1.8 }, wide = { x: 0, y: 0, z: 0.9 }, onA = { x: -330, y: 10, z: 1.75 };
  const u1 = inOut(span(t, 8, 9.9)), u2 = inOut(span(t, cues.tap + 0.25, cues.arrive + 0.2)), u3 = inOut(span(t, cues.receiptTap + 0.2, 17.6));
  const mix = (p, q, u) => ({ x: lerp(p.x, q.x, u), y: lerp(p.y, q.y, u), z: lerp(p.z, q.z, u) });
  cam = mix(mix(mix(wide, close, u1), onA, u2), { x: 0, y: 0, z: 0.9 }, u3);
  backdrop();
  pods(t, { nudgeB: nudge(t, cues.tap), nudgeA: nudge(t, cues.receiptTap) });
  ripple(t, cues.tap, B, C.b);
  pulse(t, cues.tap + 0.2, cues.arrive, { x: B.x, y: B.y - 20 }, { x: A.x, y: A.y - 20 }, C.b);
  const wx = A.x + 330, wy = A.y - 20;
  const amp = outQuart(span(t, cues.arrive, cues.arrive + 0.3)) * (1 - inOut(span(t, 13.9, 14.6)));
  wave(t, wx, wy, amp, C.b);
  const words = inOut(span(t, 14.1, 14.9)) * (1 - inOut(span(t, cues.receiptTap + 0.5, cues.receiptTap + 1.3)));
  type("Slow down", sx(wx), sy(wy), { size: 76 * cam.z / 1.75, color: C.b, alpha: words, blur: (1 - words) * 8 });
  ripple(t, cues.receiptTap, A, C.a);
  pulse(t, cues.receiptTap + 0.15, cues.receiptArrive, { x: A.x, y: A.y - 20 }, { x: B.x, y: B.y - 20 }, C.a, { lift: 110, size: 0.6 });
  ripple(t, cues.receiptArrive, B, C.a, { dy: -20 });
}

const MEANINGS = [
  ["Single tap", "Slow down"],
  ["Double tap", "One minute left"],
  ["Triple tap", "Show the demo now"],
  ["Earbud out", "Wrap it up now"],
];

function sceneMeanings(t) {
  cam = { x: lerp(770, 800, span(t, 18, 28)), y: 30, z: lerp(1.9, 2.0, span(t, 18, 28)) };
  backdrop();
  const tapNudge = cues.fan.reduce((sum, at) => sum + nudge(t, at), 0);
  pod(B, C.b, -1, { nudge: tapNudge });
  const stem = { x: sx(B.x) + 40, y: sy(B.y + 60) };
  const fold = inOut(span(t, cues.fold, cues.fold + 0.7));
  MEANINGS.forEach(([gesture, message], i) => {
    const at = cues.fan[i];
    if (t < at) return;
    if (i < 3) ripple(t, at, B, C.b, { count: i + 1 });
    const u = outQuart(span(t, at, at + 0.9)) * (1 - fold);
    const rowY = lerp(stem.y, 250 + i * 140, u);
    const rowX = lerp(stem.x, 800, u);
    ctx.save();
    ctx.strokeStyle = rgba(C.b, 0.55 * u);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(stem.x, stem.y);
    ctx.bezierCurveTo(stem.x + 130 * u, stem.y, rowX - 150 * u, rowY, rowX - 24, rowY);
    ctx.stroke();
    ctx.restore();
    const dots = i < 3 ? i + 1 : 0;
    for (let d = 0; d < dots; d++) {
      const pop = outQuart(span(t, at + d * 0.16, at + d * 0.16 + 0.35)) * (1 - fold);
      glowDot(rowX + 10 + d * 30, rowY, 30, C.b, 0.5 * pop);
      ctx.fillStyle = rgba(C.b, pop);
      ctx.beginPath(); ctx.arc(rowX + 10 + d * 30, rowY, 8, 0, Math.PI * 2); ctx.fill();
    }
    if (i === 3) {
      ctx.save();
      ctx.strokeStyle = rgba(C.b, u);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(rowX + 14, rowY, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    const text = outQuart(span(t, at + 0.15, at + 0.95)) * (1 - fold);
    type(gesture, rowX + 118, rowY - 28, { size: 26, weight: 500, color: C.ink2, alpha: text, align: "left", track: -0.01 });
    type(message, rowX + 116, rowY + 16, { size: 62, color: C.ink, alpha: text, align: "left", blur: (1 - text) * 8 });
  });
}

const DRAFT = "The judge on the left looks lost";

function sceneAsks(t) {
  cam = { x: lerp(0, 60, span(t, 28, 38)), y: lerp(-40, -50, span(t, 28, 38)), z: lerp(0.9, 0.98, span(t, 28, 38)) };
  backdrop();
  pods(t, { nudgeB: nudge(t, cues.approveTap) });
  const orb = { x: 0, y: -30 };
  const present = outQuart(span(t, cues.assistant, cues.assistant + 0.9)) * (1 - inOut(span(t, cues.approveTap + 0.2, cues.approveTap + 1.2)));
  const breathe = 1 + 0.08 * Math.sin(t * 2.4);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  glowDot(sx(orb.x), sy(orb.y), 170 * cam.z * breathe, C.ai, 0.22 * present);
  glowDot(sx(orb.x), sy(orb.y), 46 * cam.z * breathe, C.ai, 0.9 * present);
  ctx.restore();
  for (let ring = 0; ring < 3; ring++) {
    const phase = (t * 0.45 + ring / 3) % 1;
    ctx.save();
    ctx.strokeStyle = `rgba(245,245,247,${0.22 * present * Math.sin(Math.PI * phase)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx(orb.x), sy(orb.y), lerp(230, 60, phase) * cam.z, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  pulse(t, cues.draftLeave, cues.draftPreview, orb, { x: B.x, y: B.y - 20 }, C.ai, { lift: 90, size: 0.7 });
  const cx = B.x - 40, cy = B.y - 215;
  const shown = outQuart(span(t, cues.draftPreview, cues.draftPreview + 0.8));
  const sent = inOut(span(t, cues.approveTap, cues.approveTap + 0.5));
  const gone = 1 - inOut(span(t, cues.approveTap + 0.35, cues.approveTap + 0.9));
  type("Draft. Only the sender hears it.", sx(cx), sy(cy - 58), { size: 26, weight: 500, color: C.ink2, alpha: shown * (1 - sent), track: -0.01 });
  wave(t, cx, cy + 62, 0.36 * shown * (1 - inOut(span(t, cues.draftPreview + 2.1, cues.draftPreview + 2.6))), C.ai, { bars: 25, pitch: 9 });
  type(`\u201C${DRAFT}\u201D`, sx(cx), sy(cy) + (1 - shown) * 20, { size: 46, color: C.ai, alpha: shown * (1 - sent) * gone, blur: (1 - shown) * 8 });
  type(`\u201C${DRAFT}\u201D`, sx(cx), sy(cy), { size: 46, color: C.b, alpha: sent * gone });
  const waiting = span(t, cues.draftPreview + 2.2, cues.approveTap) > 0 && t < cues.approveTap;
  if (waiting) {
    const beat = (t * 1.1) % 1;
    ctx.save();
    ctx.strokeStyle = rgba(C.b, 0.6 * (1 - beat));
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx(B.x), sy(B.y + 60), (20 + 46 * beat) * cam.z, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  ripple(t, cues.approveTap, B, C.b);
  pulse(t, cues.approveTap + 0.3, cues.draftArrive, { x: B.x, y: B.y - 20 }, { x: A.x, y: A.y - 20 }, C.b);
  const ax = A.x + 60, ay = A.y - 215;
  const heard = outQuart(span(t, cues.draftArrive, cues.draftArrive + 0.3));
  wave(t, ax, ay + 62, 0.5 * heard * (1 - inOut(span(t, 36.9, 37.4))), C.b, { bars: 25, pitch: 9 });
  const words = inOut(span(t, cues.draftArrive + 0.2, cues.draftArrive + 0.9));
  type(`\u201C${DRAFT}\u201D`, sx(ax), sy(ay), { size: 46, color: C.b, alpha: words, blur: (1 - words) * 8 });
}

const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const CROSSED = [
  { at: cues.tap, color: C.b, who: "Seat B", text: "Slow down" },
  { at: cues.receiptTap, color: C.a, who: "Seat A", text: "Heard" },
  { at: cues.draftPreview, color: C.ai, who: "Assistant, to Seat B only", text: "Draft preview" },
  { at: cues.approveTap, color: C.b, who: "Seat B", text: "The judge on the left looks lost" },
];

function sceneReveal(t) {
  const lift = inOut(span(t, 38, 39.2));
  cam = { x: 0, y: 0, z: 1 };
  backdrop(lift);
  const left = 300, right = 1620, y = 470, total = beats.reveal[0];
  const grow = inOut(span(t, 38.05, 39.0));
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(lerp(left, right, grow), y); ctx.stroke();
  type(clock(0), left - 28, y, { size: 24, weight: 500, color: C.ink3, alpha: grow, align: "right", font: MONO, track: 0 });
  type(clock(total), right + 28, y, { size: 24, weight: 500, color: C.ink3, alpha: span(t, 38.9, 39.3), align: "left", font: MONO, track: 0 });
  type("Everything that crossed in this film", W / 2, 150, { size: 30, weight: 500, color: C.ink2, alpha: window_(t, 38.3, 45.6), track: -0.01 });
  CROSSED.forEach((item, i) => {
    const at = cues.dots[i];
    if (t < at) return;
    const u = outQuart(span(t, at, at + 0.7));
    const x = lerp(left, right, item.at / total);
    const up = i % 2 === 0 ? -1 : 1;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    glowDot(x, y, 90 * (2 - u), item.color, 0.5 * u);
    ctx.restore();
    ctx.fillStyle = item.color;
    ctx.globalAlpha = u;
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgba(item.color, 0.5 * u);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y + up * 22); ctx.lineTo(x, y + up * lerp(22, 92, u)); ctx.stroke();
    const align = x > 1300 ? "right" : x < 700 ? "left" : "center";
    const tx = align === "right" ? x + 14 : align === "left" ? x - 14 : x;
    const base = y + up * 150;
    type(item.text, tx, base + (1 - u) * up * 14, { size: 40, color: C.ink, alpha: u, align, blur: (1 - u) * 6 });
    type(`${clock(item.at)}  ${item.who}`, tx, base + up * 46, { size: 23, weight: 500, color: item.color, alpha: u * 0.9, align, track: 0 });
  });
}

let stageShots = null;
async function sceneStage(t) {
  backdrop(0.4);
  const live = t < cues.stageReveal;
  const [from, to] = live ? [cues.stageLive, cues.stageReveal] : [cues.stageReveal, beats.stage[1]];
  let url = live ? "/out/stage/live-whisper.png" : "/out/stage/reveal.png";
  if (!live && stageShots?.burst?.length) {
    const elapsed = (t - cues.stageReveal) * 0.9;
    const frame = stageShots.burst.findLast(item => item.at <= elapsed + stageShots.burst[0].at) ?? stageShots.burst[0];
    url = `/out/stage/${frame.name}.png`;
  }
  const img = await image(url);
  const scale = lerp(live ? 0.7 : 0.72, live ? 0.725 : 0.775, span(t, from, to));
  const w = W * scale, h = H * scale, x = (W - w) / 2, y = 54 + (850 - h) / 2;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 80;
  ctx.shadowOffsetY = 30;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 22); ctx.fillStyle = "#0b0b0d"; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 22); ctx.clip();
  if (img) ctx.drawImage(img, x, y, w, h);
  ctx.restore();
  ctx.strokeStyle = C.hairline;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 22); ctx.stroke();
}

function sceneLockup(t) {
  cam = { x: 0, y: 0, z: 1 };
  backdrop(0.15);
  pulse(t, cues.lockupPulse, cues.lockupPulse + 2.6, { x: 1150, y: 40 }, { x: -1150, y: 40 }, C.b, { lift: 60, size: 0.9 });
  pulse(t, cues.lockupPulse + 1.5, cues.lockupPulse + 4.1, { x: -1150, y: 110 }, { x: 1150, y: 110 }, C.a, { lift: -40, size: 0.7 });
}

function titles(t) {
  type("Some things can\u2019t be said out loud.", W / 2, 470, { size: 40, weight: 500, color: C.ink2, alpha: window_(t, 1.4, 4.5, 0.9, 0.5), track: -0.015 });
  headline(t, 5.0, 7.95, "Say it without saying it.");
  headline(t, 13.2, 17.7, "One tap. Your voice, in their ear.");
  headline(t, 23.2, 27.75, "Four messages, ready before you begin.");
  headline(t, 35.6, 37.9, "The AI drafts. You decide.", { y: 930 });
  headline(t, 41.6, 45.75, "It was on the whole time.", { y: 930 });
  headline(t, 46.3, 53.75, "Then the room sees all of it.", { y: 958, size: 64 });
  type("Stage captured from the working hub with two simulated seats.", W / 2, 1030, { size: 22, weight: 500, color: C.ink3, alpha: window_(t, 47.0, 53.75), track: 0 });
  if (t >= cues.wordmark - 0.2) {
    const out = 1 - inOut(span(t, 60.6, 61.6));
    const enter = outQuart(span(t, cues.wordmark, cues.wordmark + 1.2));
    type("Telepathy", W / 2, 500 + (1 - enter) * 18, { size: 190, weight: 600, alpha: enter * out, track: -0.045, blur: (1 - enter) * 14 });
    const sub = outQuart(span(t, cues.wordmark + 1.3, cues.wordmark + 2.2));
    type("Say it without saying it.", W / 2, 648 + (1 - sub) * 14, { size: 44, weight: 500, color: C.ink2, alpha: sub * out, track: -0.02 });
    const fine = outQuart(span(t, cues.wordmark + 2.6, cues.wordmark + 3.4));
    type("A hackathon demo. Works with the AirPods you already have.", W / 2, 1000, { size: 22, weight: 500, color: C.ink3, alpha: fine * out, track: 0 });
  }
}

const SCENES = [
  ["silence", sceneSilence], ["tap", sceneTap], ["meanings", sceneMeanings], ["asks", sceneAsks],
  ["reveal", sceneReveal], ["stage", sceneStage], ["lockup", sceneLockup],
];

async function draw(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  const [id, scene] = SCENES.find(([name]) => t < beats[name][1]) ?? SCENES[SCENES.length - 1];
  const filmFrame = useFilm && t < filmSeconds ? await image(`/out/film/f${String(Math.round(t * timeline.fps)).padStart(5, "0")}.jpg`) : null;
  if (filmFrame) ctx.drawImage(filmFrame, 0, 0, W, H);
  else await scene(t);
  if (!filmFrame || query.get("titles") !== "0") titles(t);
  const open = inOut(span(t, 0, 0.8)), close = inOut(span(t, timeline.seconds - 1.2, timeline.seconds - 0.2));
  const veil = Math.max(1 - open, close);
  if (veil > 0) { ctx.fillStyle = `rgba(0,0,0,${veil})`; ctx.fillRect(0, 0, W, H); }
  document.body.dataset.scene = id;
}

let filmSeconds = 0;
if (useFilm) filmSeconds = Number(query.get("filmSeconds")) || beats.reveal[1];
stageShots = await fetch("/out/stage/manifest.json").then(r => r.ok ? r.json() : null, () => null);
await document.fonts.load(`600 84px ${FONT}`);
await document.fonts.load(`500 40px ${FONT}`);
await document.fonts.ready;

window.__film = {
  seconds: timeline.seconds,
  seek: async t => {
    await draw(t);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  },
};
await draw(Number(query.get("t")) || 0);
document.body.dataset.ready = "1";
