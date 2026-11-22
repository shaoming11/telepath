import { useCallback, useEffect, useState } from "react";
import { Film } from "./Film";
import { FILM_SECONDS } from "./timeline";

declare global {
  interface Window { __film?: { seconds: number; seek: (t: number) => Promise<void> } }
}

// /film?t=12.5 shows one frame. window.__film appears once the scene has loaded; seek(t) resolves after that frame has painted.
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
  return <Film t={t} onReady={onReady} />;
}
