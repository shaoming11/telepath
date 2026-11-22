import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../tokens.css";
import "./story.css";
import { Film } from "../film/Film";
import { BEATS, FILM_SECONDS } from "../film/timeline";
import { LiveStage } from "../stage/LiveStage";

const PX_PER_SECOND = 120;
const FILM_PX = FILM_SECONDS * PX_PER_SECOND;
const HOLDS = BEATS.map(beat => beat.hold);

function hasWebGL() {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

export function StoryPage() {
  const clock = useRef(0);
  const play = useRef<{ from: number; to: number; elapsed: number } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLParagraphElement>(null);
  const [webgl] = useState(hasWebGL);
  const reduced = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const timeAtScroll = () => Math.min(FILM_SECONDS, Math.max(0, (window.scrollY - (track.current?.offsetTop ?? 0)) / PX_PER_SECOND));
  const scrollToTime = (t: number) => window.scrollTo(0, (track.current?.offsetTop ?? 0) + t * PX_PER_SECOND);

  const onFrame = useCallback((delta: number) => {
    const playing = play.current;
    if (playing) {
      playing.elapsed += delta;
      const t = Math.min(playing.to, playing.from + playing.elapsed);
      clock.current = t;
      scrollToTime(t);
      if (t >= playing.to) play.current = null;
    } else {
      const target = timeAtScroll();
      clock.current += (target - clock.current) * (reduced ? 1 : 1 - Math.exp(-delta * 7));
    }
    if (progress.current) progress.current.style.transform = "scaleX(" + (clock.current / FILM_SECONDS).toFixed(4) + ")";
    if (hint.current) hint.current.style.opacity = String(Math.max(0, 1 - clock.current / 1.5));
  }, [reduced]);

  useEffect(() => {
    const step = (direction: 1 | -1) => {
      const now = play.current?.to ?? timeAtScroll();
      if (direction === 1) {
        const next = HOLDS.find(hold => hold > now + 0.05);
        if (next === undefined) {
          document.getElementById("live")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
          return;
        }
        if (reduced) scrollToTime(next);
        else play.current = { from: clock.current, to: next, elapsed: 0 };
      } else {
        play.current = null;
        const earlier = HOLDS.filter(hold => hold < now - 0.05);
        scrollToTime(earlier.length ? earlier[earlier.length - 1] : 0);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, button, [contenteditable], [data-stage]")) return;
      if (window.scrollY > (track.current?.offsetTop ?? 0) + FILM_PX + 4) return;
      if ([" ", "ArrowDown", "ArrowRight", "PageDown"].includes(event.key)) {
        event.preventDefault();
        step(1);
      } else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        step(-1);
      }
    };
    const stop = () => { play.current = null; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
    };
  }, [reduced]);

  return (
    <main className="story">
      <header className="story-bar">
        <span className="story-mark">Telepathy</span>
        <a className="story-skip" href="#live">Live stage</a>
      </header>

      {webgl ? (
        <div className="story-track" ref={track} style={{ height: `calc(${FILM_PX}px + 100vh)` }}>
          <div className="story-sticky">
            <Film clock={clock} onFrame={onFrame} />
            <p className="story-hint" ref={hint}>Scroll, or press space</p>
            <div className="story-progress" aria-hidden><div ref={progress} /></div>
          </div>
          <ol className="story-text">
            {BEATS.map(beat => <li key={beat.id}>{beat.line} {beat.note}</li>)}
          </ol>
        </div>
      ) : (
        <ol className="story-static">
          {BEATS.map(beat => (
            <li key={beat.id}>
              <h2>{beat.line}</h2>
              <p>{beat.note}</p>
            </li>
          ))}
        </ol>
      )}

      <section className="story-live" id="live">
        <LiveStage embedded />
      </section>
    </main>
  );
}
