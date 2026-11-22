import { useEffect, useState } from "react";
import { Film } from "./Film";
import { FILM_SECONDS } from "./timeline";

declare global {
  interface Window { __film?: { seconds: number; seek: (t: number) => Promise<void> } }
}

// /film?t=12.5 shows one frame. window.__film.seek(t) resolves after that frame has painted, for frame capture.
export function FilmPage() {
  const [t, setT] = useState(() => Number(new URLSearchParams(location.search).get("t")) || 0);
  useEffect(() => {
    window.__film = {
      seconds: FILM_SECONDS,
      seek: next => new Promise(resolve => {
        setT(next);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    };
    return () => { delete window.__film; };
  }, []);
  return <Film t={t} />;
}
