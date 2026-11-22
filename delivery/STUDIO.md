# Telepathy Studio

The cinema and the launch film share the classic AirPods scene, camera and signal paths. The presenter edition uses six spoken cues and a static layout. Both sites open a live React stage connected to the Telepathy hub. The stage stays mounted through the handoff.

## Run on Sharon’s computer

Open the cinema at http://127.0.0.1:5801/cinema.html, the presenter edition at http://127.0.0.1:5801/studio.html, or the stage at http://127.0.0.1:5801/studio-stage.html. The separate review package contains a local launcher for a new session. The original hub screen remains available at /stage on a rehearsal server.

## Wasp source

Place the web and film directories alongside hub, public and package.json in a Telepathy checkout, or pass an absolute checkout path to the preparation tools. Install Node 24.22.1 or later with npm 11.11 or later and Wasp CLI 0.26.1. On Windows, the verified Wasp build ran in WSL. The core hub and the packaged rehearsal also ran with native Windows Node 22.14.

From web, run the following. Replace the path with the actual checkout.

```sh
node prepare.mjs /path/to/telepathy
wasp install
wasp compile
wasp start --client-port 4131 --server-port 4132
```

Run the existing Telepathy hub separately on its usual port 5780. For a local rehearsal, install its dependencies once in the checkout and run its documented startup. The cinema is at /cinema, the presenter edition at /, the bare seekable 3D scene at /film and the projector stage at /stage on the Wasp port. The development proxy accepts the stage from the operator’s loopback browser. TELEPATHY_PORT can select a different local hub before starting Wasp.

The projector operator and both seats have a matching run of show in web/CINEMA-CUES.md. Space or the right arrow plays the next cinema chapter. The left arrow returns to the previous hold. The chapter buttons also work. On a small screen, with reduced motion, or without WebGL, five illustrated chapters lead to the same stage. The presenter edition supports its arrow buttons, the left and right arrow keys, Page Up and Page Down. The stage operator opens with O and closes with Escape.

## Rebuild the illustrated fallback and offline edition

The source-only package excludes rendered images. The ready-to-run review includes them. To regenerate the five stills from source, install film dependencies with npm ci and use Chromium through CHROME_PATH or Playwright’s installed Chromium. From film run this command.

```sh
node render.mjs --mode=posters
```

From web run the following after preparing the hub assets and installing Wasp dependencies.

```sh
node build-offline.mjs
node rehearsal.mjs /path/to/telepathy 5801
```

The portable build embeds the model and decoder and serves its local fonts, image assets and client modules from the original hub’s static file server. The launcher builds an isolated temporary copy of the upstream runtime and starts a loopback-only, keyless hub. It removes that copy on orderly shutdown. Use the Wasp stage against the original hub for a physical-device demonstration.

## Rebuild the launch film

The edit runs 62 seconds at 30 fps. It uses the same Film component as the cinema. The source edit, soundtrack code, cue timings and provenance are in film/edit. The six-beat presenter’s proposed production script is in film/SHOT-LIST.md. The file film/MASTER.md describes the delivered cut.

Install Python with NumPy and SciPy, FFmpeg with libx264 and AAC, Node and Chromium. Set CHROME_PATH to the Chrome or Chromium executable if it is outside Playwright’s cache. Set FFMPEG when ffmpeg is outside PATH. Install dependencies in the base checkout, prepare web and build its offline bundle as above. From film run these commands.

```sh
npm ci
node capture-proof.mjs /path/to/telepathy
TELEPATHY_ASSETS=/path/to/telepathy/public/assets python edit/audio/make_audio.py
node render.mjs
```

On PowerShell set environment variables using `$env:TELEPATHY_ASSETS` before invoking Python. The capture script starts its own local hub, sets up two simulated phone pages, proves a receipt and approval, then captures the real stage at 1920 × 1080. A previously recorded proof directory can be supplied with --proof and an audio file with --audio. The default movie is film/out/telepathy-launch.mp4.

Use --mode=plates to render the 3D sequence and --mode=encode to compose the edit from existing plates. --mode=serve prints the local bare film URL. The capture checks a product frame before rendering. If the graphics driver fails that check, --angle=swiftshader selects Chromium’s software renderer. The renderer keeps separate plate caches for different scene bundles, digital assets and capture settings.

## Original material

Telepathy’s hub and helper functions come from telepathy-demo at cb4dee8. The finished five-beat 3D direction comes from the existing parallel site at 832bb27. The launch timeline, typography and local audio composition come from the existing parallel video at 63107fe. This edition adds the presenter story, React stage and live controls, GPU compatibility and deterministic capture, reduced-motion and mobile product stills, a portable offline runtime and a freshly captured two-seat edit.

The classic GLB was adapted in the source site from foasho/r3f-wireless-earphones. See web/public/models/README.md. The opening product photo in the presenter edition is from Apple’s original AirPods announcement. [Apple announcement](https://www.apple.com/newsroom/2016/09/apple-reinvents-the-wireless-headphones-with-airpods/)



