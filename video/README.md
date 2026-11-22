# Launch film

Source for the 62 second Telepathy launch film. Research is in `research.md`, the shot list in `script.md`.

## Render

```
cd video && npm install
npm run stage     # two simulated seats through the real hub; photographs the Wasp stage (needs `wasp start` in site/ and port 5780 free)
npm run film      # captures the 3D film at localhost:3000/film into out/film: 1280x720, every frame (software WebGL, about 2 s a frame)
npm run frames    # renders the cut into out/frames
npm run audio     # writes out/audio.wav
npm run encode    # writes out/telepathy-launch.mp4
```

`npm run render` runs all five. `npm run render:standalone` skips the 3D film and the Wasp stage and uses the composition's own 2D scenes and the hub-served stage.

- The composition scales the plates to 1920x1080. Every frame of the 3D section needs its own plate; a frame without one is blended from its neighbours, which doubles moving edges, so capture them all. For full-size plates run `node scripts/capture.mjs --film` (about an hour in software WebGL). `--keep` resumes a capture; `--step=8 --phase=N` splits one across processes.
- `node scripts/still.mjs "?film=1" 7.2 15.7` saves single frames to `out/stills`.
- Everything under `out/` is generated and ignored by git.
