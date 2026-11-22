import React from "react";
import { createRoot } from "react-dom/client";
import { DefaultLoadingManager } from "three";
import packed from "telepathy:hardware";
import { CinemaPage, FilmPage } from "./src/cinema/Cinema.jsx";

const resolved = new Map();
DefaultLoadingManager.setURLModifier((url) => {
  if (!Object.hasOwn(packed, url)) return url;
  if (!resolved.has(url)) {
    const [mime, encoded] = packed[url];
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    resolved.set(url, URL.createObjectURL(new Blob([bytes], { type: mime })));
  }
  return resolved.get(url);
});

createRoot(document.getElementById("root")).render(
  location.pathname === "/film.html" ? <FilmPage /> : <CinemaPage />,
);
