# Add the Telepathy cinema, presenter stage and launch-film source

Local branch `codex/telepathy-studio` targets `telepathy-demo` at `cb4dee8`. All project additions are under `web/` and `film/`. The source bundle contains the branch and the source ZIP contains its added files.

## What changed

- Add an independent, six-beat presenter edition and a React stage with one shared hub connection. The final chapter hands off to the actual session.
- Adapt the existing parallel 3D camera direction for Intel projector graphics, deterministic seeking, stable keyboard holds, reduced motion and a narrow-screen fallback.
- Package the film, fonts, decoder and React client for a loopback-only, offline rehearsal. Simulated phones and the original stage are available in the same process.
- Adapt the existing 62-second launch edit to use a freshly recorded, two-seat Wasp-style stage. New capture tooling rebuilds the product plates, documentable stage proof, final edit and locally generated soundtrack.

## Verification

- Wasp compilation, all 257 existing hub tests and the fast keyless rehearsal passed.
- Tested three viewport sizes, five cinematic holds, six presenter chapters, twelve seekable film frames, no WebGL and reduced motion. Browser tests checked the stage connection and key-repeat navigation.
- Drove setup, Begin, fixed cue, receipt, private preview, approval, delivery, Reveal and Canned take against the original hub. Coach, announcements, references, preset, replay, injection and guarded reset updated actual hub state.
- Verified the H.264 master at 1080p30 and the 48 kHz stereo AAC soundtrack. The 62-second movie and rehearsal screenshots are separate from this source branch.

## Review locally

From a checkout containing the stated base, import the branch without changing the currently checked-out files.

```sh
git fetch /path/to/Telepathy-source.bundle refs/heads/codex/telepathy-studio:refs/heads/codex/telepathy-studio
git diff --stat telepathy-demo...codex/telepathy-studio
```

The setup guide is in web/STUDIO.md. Model provenance is in web/public/models/README.md. The original parallel creative material is credited in the narrative and master notes. Physical devices, the venue and live providers were outside the simulated verification.

