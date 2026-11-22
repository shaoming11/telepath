import React, { useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { advance } from "@react-three/fiber";
import { Film } from "./film/Film";
import { FILM_SECONDS } from "./film/timeline";

function CapturePage() {
  const clock = useRef(0);
  const onReady = useCallback(() => {
    const gl = document.querySelector("canvas").getContext("webgl2");
    async function seek(seconds) {
      if (!Number.isFinite(seconds)) throw Error("A seek needs a finite time.");
      clock.current = Math.max(0, Math.min(FILM_SECONDS, seconds));
      // The scene projects DOM anchors using the camera's world matrix from the preceding draw.
      advance(clock.current, true);
      advance(clock.current, true);
      gl.finish();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    document.fonts.ready
      .then(() => seek(0))
      .then(() => {
        window.__film = { seconds: FILM_SECONDS, seek };
      });
  }, []);
  return <Film clock={clock} pixelRatio={1.5} paused onReady={onReady} />;
}
createRoot(document.getElementById("root")).render(<CapturePage />);
