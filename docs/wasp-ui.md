# Telepathy on Wasp

## Active frontend stack

Wasp builds React routes for the phone and Mac Stage. The Node hub serves both on the same origin.

Wasp 0.26 defines the phone route at `/` and the Mac Stage at `/stage`. Their React markup connects to the existing media and session controllers using stable control IDs.

## Hub and browser controllers

The same Mac hub serves Wasp's generated client and handles the WebSocket, microphone ownership, provider calls, and audio delivery. This allows the phones to stay on the current trusted HTTPS origin and preserves the Stage's loopback controls. No Wasp service or database needs to run to serve this client. The minimal Wasp project declares PostgreSQL because the compiler rejects SQLite in a production config. The deployed surface uses static Wasp-generated client files.

Question Mode and the private cue panel are React-owned. The phone controller publishes scoped state to these components and keeps control of the media session and WebSocket. The arm button shows why it is disabled when the hub is offline or the Stage has not started. A cue highlight starts from the existing Web Audio speech-start callback, so queued text alone cannot indicate playback.

The Stage room console is also React-owned. The capture controller handles microphone permission, selected-device constraints, and hub scope. The input meter gets its own audio-level updates, so audio frames do not rebuild the transcript or replace the focused speaker controls.

## Session evidence in the interface

The Wasp phone highlights a private cue on the `telepathy:pitch-speech-start` event. Calibration shows received earbud events immediately and shows acceptance after the timing check. Sources: wasp-ui/src/PhonePitchControls.tsx, wasp-ui/src/CalibrationTrial.tsx.

The Live phone shows **Send**, **Discard**, and **Acknowledge whisper** above the monitor when they are available. The cue controls scroll separately from the navigation row.

The Operator dock keeps the Stage controls available and retains the last announcement while you compose another. The paired Live cards show dispatch on the sender’s side, playback start on the recipient’s side, then acknowledgement for the matching cue. Each seat reports when Web Audio starts. Reveal puts confirmed bit and word counts first and labels canned results as scripted.

The launcher compares a hash of the build inputs before reusing the compiled Wasp client. The Node hub compresses transport by serving precompressed hashed scripts and styles to browsers that accept gzip. Sources: scripts/build-wasp-ui, hub/server.mjs.

The coach uses a curated set of React and Wasp files from the deployed build. Rebuilding updates those code excerpts. Project notes still refresh from the checkout while the hub is running.

## Build, run and verify

Use Node.js 24.22.1 or later, npm, and Python 3. The first build downloads the pinned Wasp compiler and dependencies. From the repository root:

```sh
./start-wasp
```

The launcher builds the Wasp client when the artifact is missing or its inputs change. The hub prints the Stage and phone addresses when it starts. Wasp can refresh its dependency lockfile on a first build. The launcher records the resolved dependencies for the next start.

To force a rebuild, run `./scripts/build-wasp-ui`. If you edit the source HTML, run `python3 scripts/generate-wasp-surfaces.py` before building. The generator preserves the controller hooks in the React surfaces. Wasp output and staged client files live in ignored build folders.

The regular `./start` command opens the classic frontend. To test the Wasp presentation against an isolated hub instead of the live rehearsal, start a separate port with provider credentials absent from that process.

```sh
npm test
npm run rehearse -- --fast --runs=1
npm run rehearse:faults -- --tls --fast --cycles=5
```

## Rehearse on two phones

1. Put the Mac and both phones on the same private hotspot. Open the printed Stage address on the Mac and the printed HTTPS phone address in Safari. Install and trust **Telepathy Local Demo** on each iPhone if prompted. [iPhone certificate steps](rehearsal.md)
2. Pair each set of AirPods with its own phone. Join as Seat A for the presenter and Seat B for the coach. Choose **Use the premade voice**, select the earbud model, and tap **Test audio**. Each person should hear the test in their own earbuds.
3. For AirPods 1, map double-tap to **Next Track** in Bluetooth settings. Run two double-event trials and two triple-event trials after the initial check. For AirPods Pro, check single, double, and triple squeezes. Choose **Pitch** and tap **Ready** on both phones.
4. On Stage, select the MacBook microphone under **Device and transcript**. Click **Start listening** and confirm that speech appears. Begin the session once both seats are ready.
5. Have the coach send **Slow down**. On the presenter’s phone, tap **Acknowledge whisper** after it plays. Arm **Question Mode** and have a third person ask about the project. Verify that only the presenter gets the answer cue. Use the coach’s private **Send** action to approve a draft.
6. Open **Operator**, send **Thirty seconds left**, and confirm playback from both seats before clicking **Reveal**. Test **Canned take** with both phone tabs closed.

The branch passed a local two-seat rehearsal using the iPhone SE and iPhone 17 Pro Safari simulators with fixture transcription and bundled audio. That test checked browser playback, which starts the Stage receipt. The five-run physical check still needs both phones, both AirPods pairs, and the live provider configuration.

## Visual direction

Telepathy uses a glass treatment for the control layer, with solid text panels beneath it. Press and release are timed separately. Realtime status changes use the actual local recognition, calibration, speech, and acknowledgement events. Each phone’s Question Mode control sits above the monitor, so the presenter can see the armed state without scrolling. The stylesheet respects reduced motion and the contrast and transparency preferences the browser exposes. Choose **Solid surfaces** under **Appearance** in Phone Settings or Operator to remove navigation blur. The choice stays in that browser.

The direction draws on the touch-origin menu, rounded nesting, and specular edges in Apple's official [Meet Liquid Glass demo](https://developer.apple.com/videos/play/wwdc2025/219/?time=302), plus Apple's [materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials). The [Wasp spec and routing guide](https://wasp.sh/docs/features/pages-and-routes) explains route generation.
