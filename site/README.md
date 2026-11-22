# Telepathy story site

A Wasp app with the page we project during the pitch: a scroll-driven 3D film that ends in the live stage.

| Route | What it is |
| --- | --- |
| `/` | The story. Five film beats, then the live stage as the last section. |
| `/stage` | The live stage on its own (Lobby, Live board, Reveal, Operator). |
| `/film` | The bare film for frame capture. `/film?t=12.5` shows one frame; `window.__film.seek(t)` resolves once that frame has painted. |

## Run

Needs Node 24.22.1 or newer and npm 11.11 or newer.

```bash
npm i -g @wasp.sh/wasp-cli
cd site
wasp install
wasp db migrate-dev --name init
wasp start            # http://127.0.0.1:3000
```

Start the hub as usual in another terminal (`./start` at the repo root). The site reaches it through the dev server, which forwards `/hub/*` to `http://localhost:5780`; set `TELEPATHY_HUB_URL` to point somewhere else. The hub only accepts the stage socket from the Mac itself, so the dev server listens on `127.0.0.1` only. Open the site on the Mac that runs the hub.

Without a hub the film still plays and the stage shows its offline state.

## Presenting

- Space, Right or Down plays the next beat and settles on its composed frame. Left or Up goes back a beat. Scrolling scrubs freely.
- Space after the last beat opens the hub's Reveal if a session is live, then moves to the stage.
- `O` opens the Operator panel once the stage is on screen.

## Where things are

- `src/film/timeline.ts`: the beats, their lines and timings.
- `src/film/choreo.ts`: the camera path and every pulse, with its timing, colour and label.
- `src/film/Scene.tsx`: the 3D scene. It is a pure function of time, so the scroll page and the launch video render identical frames.
- `src/stage/`, `src/hub/`: the rebuilt stage and its single shared connection to the hub.
- `src/tokens.css`: colours, type, spacing and easing.
- `public/models/`: the AirPods model and where it came from.
