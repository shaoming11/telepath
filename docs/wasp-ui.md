# Telepathy on Wasp

## Active frontend stack

Wasp builds React routes for the phone and Mac Stage. The Node hub serves both on the same origin.

Wasp 0.26 defines the phone route at `/` and the Mac Stage at `/stage`. Their React markup connects to the existing media and session controllers using stable control IDs.

## Hub and browser controllers

The same Mac hub serves Wasp's generated client and handles the WebSocket, microphone ownership, provider calls, and audio delivery. This allows the phones to stay on the current trusted HTTPS origin and preserves the Stage's loopback controls. No Wasp service or database needs to run to serve this client. The minimal Wasp project declares PostgreSQL because the compiler rejects SQLite in a production config. The deployed surface uses static Wasp-generated client files.

Question Mode and the private cue panel are React-owned. The phone controller publishes scoped state to these components and keeps control of the media session and WebSocket. The arm button shows why it is disabled when the hub is offline or the Stage has not started. A cue highlight starts from the existing Web Audio speech-start callback, so queued text alone cannot indicate playback.

The Stage room console is also React-owned. The capture controller handles microphone permission, selected-device constraints, and hub scope. The input meter gets its own audio-level updates, so audio frames do not rebuild the transcript or replace the focused speaker controls.

## Build, run and verify

Use Node.js 24.22.1 or later for the Wasp compiler. From the repository root:

```sh
./start-wasp
```

The launcher builds the Wasp client if the artifact is missing. The hub then prints Stage and phone addresses as usual. Rebuild after UI changes with `./scripts/build-wasp-ui`. If the source HTML changes, run `python3 scripts/generate-wasp-surfaces.py` before building. The generator preserves the current event hooks while rendering the surfaces as React components. Wasp output and the staged static client live in ignored build folders.

The regular `./start` command opens the classic frontend. To test the Wasp presentation against an isolated hub instead of the live rehearsal, start a separate port with provider credentials absent from that process.

```sh
npm test
npm run rehearse -- --fast --runs=1
```

## Visual direction

Telepathy uses a glass treatment for the control layer, with solid text panels beneath it. Press and release are timed separately. Realtime status changes use the actual local recognition, calibration, speech, and acknowledgement events. Each phone’s Question Mode control sits above the monitor, so the presenter can see the armed state without scrolling. The stylesheet supports reduced motion, reduced transparency, keyboard focus, and increased contrast. There are no Apple recordings or brand assets in the app.

The direction draws on the touch-origin menu, rounded nesting, and specular edges in Apple's official [Meet Liquid Glass demo](https://developer.apple.com/videos/play/wwdc2025/219/?time=302), plus Apple's [materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials). The [Wasp spec and routing guide](https://wasp.sh/docs/features/pages-and-routes) explains route generation.
