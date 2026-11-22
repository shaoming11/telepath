import React, {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { HubProvider, useHub } from "../transport.jsx";
import { Stage } from "../Stage.jsx";
import { Brand } from "../Studio.jsx";
import { BEATS, FILM_SECONDS } from "./film/timeline";
import "./cinema.css";

const Film = lazy(() =>
  import("./film/Film").then((m) => ({ default: m.Film })),
);
const px = 120;
const staticMedia = "(prefers-reduced-motion: reduce), (max-width: 700px)";
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const nextKeys = [" ", "ArrowRight", "ArrowDown", "PageDown"];
const previousKeys = ["ArrowLeft", "ArrowUp", "PageUp"];

function hasGraphics() {
  try {
    const context = document.createElement("canvas").getContext("webgl2");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
class SceneBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
function Posters() {
  return (
    <div className="cinema-stills">
      {BEATS.map((beat, i) => (
        <section key={beat.id} id={"still-" + beat.id} tabIndex={-1}>
          <div className="still-head">
            <Brand />
            <a href="#cinema-live">Live stage ↗</a>
          </div>
          <figure>
            <img
              src={"/posters/" + beat.id + ".png"}
              alt=""
              width="1040"
              height="585"
              loading={i ? "lazy" : "eager"}
            />
          </figure>
          <div className="still-copy">
            <h2>{beat.line}</h2>
            <p>{beat.note}</p>
          </div>
        </section>
      ))}
    </div>
  );
}
function CinemaStory() {
  const { link, state } = useHub();
  const [graphics, setGraphics] = useState(
    () => !matchMedia(staticMedia).matches && hasGraphics(),
  );
  const [simple, setSimple] = useState(() => matchMedia(staticMedia).matches);
  const [visible, setVisible] = useState(true);
  const [parked, setParked] = useState(false);
  const settledFrames = useRef(0);
  const wake = useCallback(() => {
    settledFrames.current = 0;
    setParked(false);
  }, []);
  const [beat, setBeat] = useState(-1);
  const track = useRef(null),
    sticky = useRef(null),
    progress = useRef(null);
  const time = useRef(0),
    play = useRef(null);
  const stills = simple || !graphics;
  useEffect(() => {
    const media = matchMedia(staticMedia);
    function change() {
      setSimple(media.matches);
      if (!media.matches) setGraphics(hasGraphics());
      play.current = null;
    }
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const node = sticky.current;
    if (!node) return;
    wake();
    const observer = new IntersectionObserver(([e]) =>
      setVisible(e.isIntersecting),
    );
    observer.observe(node);
    window.addEventListener("scroll", wake, { passive: true });
    window.addEventListener("resize", wake);
    const lost = (event) => {
      event.preventDefault();
      setGraphics(false);
    };
    node.addEventListener("webglcontextlost", lost, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", wake);
      window.removeEventListener("resize", wake);
      node.removeEventListener("webglcontextlost", lost, true);
    };
  }, [stills]);
  const scrollTime = () =>
    Math.max(
      0,
      Math.min(
        FILM_SECONDS,
        (window.scrollY - (track.current?.offsetTop || 0)) / px,
      ),
    );
  const goTime = (t) =>
    window.scrollTo({
      top: (track.current?.offsetTop || 0) + t * px,
      behavior: "instant",
    });
  const onFrame = useCallback((delta) => {
    if (play.current) {
      const target = play.current.to;
      time.current = Math.min(target, time.current + Math.min(0.12, delta));
      goTime(time.current);
      if (time.current >= target) play.current = null;
    } else {
      const target = scrollTime();
      time.current +=
        (target - time.current) * (1 - Math.exp(-Math.max(0, delta) * 9));
    }
    if (!play.current && Math.abs(time.current - scrollTime()) < 0.001) {
      if (++settledFrames.current >= 5) setParked(true);
    } else settledFrames.current = 0;
    if (progress.current)
      progress.current.style.transform =
        "scaleX(" + time.current / FILM_SECONDS + ")";
    const index = BEATS.findIndex((b) => time.current < b.end);
    setBeat(time.current < 1 ? -1 : index < 0 ? BEATS.length - 1 : index);
  }, []);
  function step(direction) {
    if (stills) {
      const sections = Array.from(
        document.querySelectorAll(".cinema-stills section, #cinema-live"),
      );
      const active = sections.reduce(
        (a, n, i) =>
          n.getBoundingClientRect().top <= innerHeight * 0.42 ? i : a,
        0,
      );
      const el =
        sections[
          Math.max(0, Math.min(sections.length - 1, active + direction))
        ];
      el?.scrollIntoView();
      el?.focus({ preventScroll: true });
      return;
    }
    wake();
    const position = scrollTime();
    if (direction > 0) {
      if (play.current) return;
      const next = BEATS.find((b) => b.hold > position + 0.075);
      if (next) play.current = { to: next.hold };
      else document.getElementById("cinema-live")?.scrollIntoView();
    } else {
      play.current = null;
      const previous = BEATS.filter((b) => b.hold < position - 0.075).at(-1);
      time.current = previous?.hold || 0;
      goTime(time.current);
    }
  }
  useEffect(() => {
    const cancel = () => {
      play.current = null;
    };
    function key(e) {
      if (
        ![...nextKeys, ...previousKeys].includes(e.key) ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        document.querySelector("dialog[open]")
      )
        return;
      if (e.target.closest("input,select,textarea,button,a,[contenteditable]"))
        return;
      if (
        document.getElementById("cinema-live")?.getBoundingClientRect().top <
        innerHeight * 0.4
      )
        return;
      e.preventDefault();
      if (!e.repeat) step(nextKeys.includes(e.key) ? 1 : -1);
    }
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
    };
  }, [stills]);
  return (
    <div className="cinema" id="cinema-top">
      {stills ? (
        <Posters />
      ) : (
        <div
          className="cinema-track"
          ref={track}
          style={{ height: "calc(100svh + " + FILM_SECONDS * px + "px)" }}
        >
          <div className="cinema-pinned" ref={sticky}>
            <SceneBoundary onFailure={() => setGraphics(false)}>
              <Suspense fallback={<div className="cinema-load">Telepathy</div>}>
                <Film
                  clock={time}
                  onFrame={onFrame}
                  paused={!visible || parked}
                  onReady={wake}
                />
              </Suspense>
            </SceneBoundary>
            <header className="cinema-head">
              <Brand />
              <a
                href="#cinema-live"
                onClick={() => {
                  play.current = null;
                }}
              >
                Live stage ↗
              </a>
            </header>
            <footer className="cinema-foot">
              <span>
                {beat < 0
                  ? "Scroll, or press space"
                  : "Stage · " + (link === "online" ? state.phase : link)}
              </span>
              <nav aria-label="Film chapters">
                <button
                  type="button"
                  aria-label="Previous chapter"
                  onClick={() => step(-1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  aria-label="Next chapter"
                  onClick={() => step(1)}
                >
                  →
                </button>
              </nav>
            </footer>
            <div className="cinema-progress">
              <div ref={progress} />
            </div>
          </div>
          <ol className="visually-hidden">
            {BEATS.map((b) => (
              <li key={b.id}>
                {b.line} {b.note}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div id="cinema-live" tabIndex={-1}>
        <Stage back="#cinema-top" />
      </div>
    </div>
  );
}
export function CinemaPage() {
  return (
    <HubProvider>
      <CinemaStory />
    </HubProvider>
  );
}
export function FilmPage() {
  const time = useRef(0);
  const onReady = useCallback(() => {
    const canvas = document.querySelector(".film canvas");
    async function seek(t) {
      if (!Number.isFinite(t)) throw Error("A seek requires a finite time.");
      time.current = Math.max(0, Math.min(FILM_SECONDS, t));
      const { advance } = await import("@react-three/fiber");
      advance(time.current, true);
      advance(time.current, true);
      document.querySelector(".film canvas")?.getContext("webgl2")?.finish();
      await frame();
    }
    document.fonts.ready
      .then(() =>
        seek(Number(new URLSearchParams(location.search).get("t")) || 0),
      )
      .then(() => {
        if (canvas && canvas === document.querySelector(".film canvas"))
          window.__film = { seconds: FILM_SECONDS, seek };
      });
  }, []);
  useEffect(
    () => () => {
      delete window.__film;
    },
    [],
  );
  return (
    <Suspense fallback={null}>
      <Film clock={time} paused onReady={onReady} />
    </Suspense>
  );
}
