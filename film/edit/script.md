This is the editorial outline from the parallel video at 63107fe. The delivered cut and its captured stage sequence are described in ../MASTER.md.

# Telepathy launch film: script and shot list

62 seconds, 1920x1080, 30 fps, no voiceover. One claim per beat. Timings are in `timeline.json`; the 3D beats follow `site/src/film/timeline.ts` and `choreo.ts`.

Provenance key: **3D** = the parent session's time-seekable film at `/film`, captured as plates with its headline copy and title card hidden (its in-scene labels are kept). **Own** = authored in `video/comp/comp.js`. **Stage** = screenshots of the Wasp stage at `/stage`, driven by two simulated seats through the real hub.

| # | Time | Beat | Picture | Words on screen | Sound | Source |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:05 | Silence | Black. One earbud is lit in from darkness, close. | Some things can't be said out loud. | Room tone, low drone fades up. No rhythm. | 3D plate, own type |
| 2 | 0:05 to 0:08 | Silence | Camera pulls wide: two earbuds far apart, one warm, one cool. Nothing moves. | **Say it without saying it.** | Pad enters on the headline. | 3D plate, own type |
| 3 | 0:08 to 0:14 | The tap | Push in on Seat B. A tap at 0:10.4; a blue pulse leaves, crosses the dark, lands at Seat A at 0:13.6. | Label in scene: Slow down / In your partner's voice | Tap, travelling whoosh panned right to left, the app's whisper chime, then the line "Slow down". | 3D plate |
| 4 | 0:14 to 0:18 | The tap | Hold on Seat A. Its receipt returns in orange. | **One tap. Your voice, in their ear.** | Tap on the left, the app's receipt tone on the right. | 3D plate, own type |
| 5 | 0:18 to 0:28 | Four meanings | Wide. The tap fans into four arcs, each named: One tap, Two taps, Three taps, Earbud out. | **Four messages, ready before you begin.** | Four taps, each with a rising pluck. | 3D plate, own type |
| 6 | 0:28 to 0:34 | It asks first | Close on Seat B. A neutral white draft arrives at the sender only and waits. | Label in scene: The judge on the left looks lost / A draft. Only you hear it. | Soft pluck, the app's draft cue, the assistant's preview line panned to Seat B only. | 3D plate |
| 7 | 0:34 to 0:38 | It asks first | Seat B taps at 0:34. The draft crosses in blue to Seat A. | **The AI drafts. You decide.** | Tap, the app's sent cue, whoosh, chime, the line in Seat A's ear. Riser into the next beat. | 3D plate, own type |
| 8 | 0:38 to 0:46 | Reveal | The arcs flatten into one line between the earbuds; every whisper becomes a labelled dot. | **It was on the whole time.** | Low hit on the cut, one pluck per dot. | 3D plate, own type |
| 9 | 0:46 to 0:48.5 | Stage | Hard cut to the working product: the live board with "Slow down" crossing from Coach to Presenter. | Then the room sees all of it. / Stage captured from the working hub with two simulated seats. | Hit on the cut. | Stage, own type |
| 10 | 0:48.5 to 0:54 | Stage | The Reveal screen from that run: 4 messages, 16 words heard, 7 bits tapped, and the timeline. | (same) | Second hit, pad opens. | Stage, own type |
| 11 | 0:54 to 1:02 | Lockup | Black. A blue pulse and an orange pulse cross. The wordmark resolves and holds. | **Telepathy** / Say it without saying it. / A hackathon demo. Works with the AirPods you already have. | Final hit, two whooshes, pad rings out. | Own |

## Copy rules applied

- The five lines from the narrative plan are used unchanged. Two lines are added: the opening "Some things can't be said out loud." and the bridge "Then the room sees all of it."
- No speed claims and no statistics. The only numbers on screen are the counts on the captured Reveal screen, which are that simulated run's own counts.
- The stage shots carry a caption saying they come from two simulated seats. The seat cards in the product itself read "Simulated" and "Premade voice".
- "Your voice" is the plan's line for a cloned voice. The whispers heard in the film are the repo's bundled lines, not a clone. No cloned voice, phone or AirPods hardware was used to make this film.
- No call to action. The film ends on the name.

## Sound

Synthesised locally by `audio/make_audio.py` (numpy and scipy): drone, pads, plucks, hits, taps, whooshes, riser. The whisper chime, receipt, draft and sent cues and the three spoken lines are the app's own files from `public/assets`. Seat B is panned right and Seat A left, matching the picture. Mixed to about -15 LUFS with peaks under -1 dBFS.

## Fallback cut

Without `?film=1` the composition draws its own 2D scenes for beats 1 to 8, so the film renders with no Wasp server and no 3D capture.

