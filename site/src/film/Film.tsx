import { Suspense, useCallback, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import "../tokens.css";
import "./film.css";
import { Scene } from "./Scene";
import { BEATS } from "./timeline";
import { PULSES, REVEAL_PULSES, SEAT_A, SEAT_B, easeOut, ramp } from "./choreo";

type Clock = { current: number };

// Renders the frame for a moment in time. Pass `t` for a fixed frame or `clock` to drive it every frame.
type Props = {
  t?: number;
  clock?: Clock;
  copy?: boolean;
  paused?: boolean;
  onFrame?: (delta: number) => void;
  onReady?: () => void;
};

export function Film({ t, clock, copy = true, paused = false, onFrame, onReady }: Props) {
  const own = useRef(0);
  const source = clock ?? own;
  if (t !== undefined && !clock) own.current = t;
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const revealLabels = useRef<(HTMLDivElement | null)[]>([]);
  const title = useRef<HTMLParagraphElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const lines = useRef<(HTMLParagraphElement | null)[]>([]);
  const words = useMemo(() => BEATS.map(beat => beat.line.split(" ")), []);

  const onTime = useCallback((now: number) => {
    if (veil.current) veil.current.style.opacity = String(1 - ramp(now, 0.9, 2.6));
    if (title.current) {
      const shown = 1 - ramp(now, 0.5, 1.5);
      title.current.style.opacity = String(shown);
      title.current.style.visibility = shown > 0 ? "visible" : "hidden";
      title.current.style.transform = "scale(" + (1 + now * 0.03).toFixed(4) + ")";
    }
    BEATS.forEach((beat, i) => {
      const line = lines.current[i];
      if (!line) return;
      const start = beat.start + (i === 0 ? 3.8 : 1.0);
      const out = i === BEATS.length - 1 ? 1 : 1 - ramp(now, beat.end - 0.9, beat.end - 0.3);
      const visible = now >= start && out > 0;
      line.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      Array.from(line.children).forEach((word, index) => {
        const shown = easeOut(ramp(now, start + index * 0.11, start + index * 0.11 + 0.9));
        const style = (word as HTMLElement).style;
        style.opacity = String(shown * out);
        style.transform = "translate3d(0," + ((1 - shown) * 0.4).toFixed(3) + "em,0)";
        style.filter = shown < 1 ? "blur(" + ((1 - shown) * 12).toFixed(2) + "px)" : "none";
      });
    });
  }, []);

  return (
    <div className="film" data-film>
      <Canvas
        className="film-canvas"
        frameloop={paused ? "never" : "always"}
        dpr={[1, 2]}
        camera={{ fov: 30, near: 0.1, far: 80, position: [0, 0, 13] }}
        gl={{ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true }}
        aria-hidden
      >
        <Suspense fallback={null}>
          <Scene clock={source} labels={labels} revealLabels={revealLabels} onTime={onTime} onFrame={onFrame} onReady={onReady} />
        </Suspense>
      </Canvas>
      <div className="film-veil" ref={veil} />
      {copy && <p className="film-title" ref={title}>Telepathy</p>}
      <div className="film-labels">
        {REVEAL_PULSES.map((pulse, i) => (
          <div key={pulse.id} className="film-anchor" ref={node => { revealLabels.current[i] = node; }}>
            <div className="film-tick" data-seat={pulse.color === SEAT_A ? "A" : "B"} data-side={i % 2 ? "above" : "below"}>{pulse.reveal}</div>
          </div>
        ))}
        {PULSES.map((pulse, i) => pulse.label && (
          <div key={pulse.id} className="film-anchor" ref={node => { labels.current[i] = node; }}>
            <div className="film-label" data-at={pulse.label.at} data-seat={pulse.color === SEAT_B ? "B" : "N"}>
              {pulse.label.taps && <span className="film-label-taps">{pulse.label.taps}</span>}
              <span className="film-label-text">{pulse.label.text}</span>
              {pulse.label.caption && <span className="film-label-caption">{pulse.label.caption}</span>}
            </div>
          </div>
        ))}
      </div>
      {copy && (
        <div className="film-copy">
          {BEATS.map((beat, i) => (
            <p key={beat.id} className="film-line" ref={node => { lines.current[i] = node; }}>
              {words[i].map((word, index) => <span key={index}>{word}</span>)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
