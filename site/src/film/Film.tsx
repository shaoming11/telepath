import { useCallback, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import "../tokens.css";
import "./film.css";
import { Scene } from "./Scene";
import { BEATS } from "./timeline";
import { easeOut, ramp } from "./choreo";

type Clock = { current: number };

// Renders the frame for a moment in time. Pass `t` for a fixed frame or `clock` to drive it every frame.
export function Film({ t, clock, copy = true }: { t?: number; clock?: Clock; copy?: boolean }) {
  const own = useRef(0);
  const source = clock ?? own;
  if (t !== undefined && !clock) own.current = t;
  const lines = useRef<(HTMLParagraphElement | null)[]>([]);
  const words = useMemo(() => BEATS.map(beat => beat.line.split(" ")), []);

  const onTime = useCallback((now: number) => {
    BEATS.forEach((beat, i) => {
      const line = lines.current[i];
      if (!line) return;
      const start = beat.start + (i === 0 ? 2.4 : 1.0);
      const out = 1 - ramp(now, beat.end - 0.9, beat.end - 0.3);
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
        dpr={[1, 2]}
        camera={{ fov: 30, near: 0.1, far: 80, position: [0, 0, 13] }}
        gl={{ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true }}
        aria-hidden
      >
        <Scene clock={source} onTime={onTime} />
      </Canvas>
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
