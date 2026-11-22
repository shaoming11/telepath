import { useCallback, useEffect, useRef, useState } from "react";
import { Film } from "./Film";
import { FILM_SECONDS } from "./timeline";

declare global {
  interface Window { __film?: { seconds: number; seek: (t: number) => Promise<void> } }
}

// /film?play=1 plays the film on a loop. /film?t=12.5 shows one frame. window.__film appears once the scene has loaded; seek(t) resolves after that frame has painted.
export function FilmPage() {
  const [t, setT] = useState(() => Number(new URLSearchParams(location.search).get("t")) || 0);
  const onReady = useCallback(() => {
    window.__film = {
      seconds: FILM_SECONDS,
      seek: next => new Promise(resolve => {
        setT(next);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    };
  }, []);
  useEffect(() => () => { delete window.__film; }, []);

  const clock = useRef(0);
  const onFrame = useCallback((delta: number) => {
    clock.current = (clock.current + Math.min(delta, 0.1)) % (FILM_SECONDS + 2);
  }, []);
  if (new URLSearchParams(location.search).has("play")) return <Film clock={clock} onFrame={onFrame} />;

  return <Film t={t} onReady={onReady} />;
}
