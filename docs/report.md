# Telepathy verification

Telepathy is a two-seat hackathon demo. The MacBook runs the hub, the stage, and a third-person operator panel. Each seat can record a 30-second sample. The hub verifies the ElevenLabs voice and the partner’s phone decodes the four fixed Pitch whispers before the take.

The operator uses **O** to open the panel. Three neutral ElevenLabs announcements ship with the app. The operator can type a short custom line with real seats connected. The hub generates the line once, sends the same clip to both seats, and tracks their playback starts separately. Announcements add zero tap bits.

## Before and after

| Check | First build | Hardened build |
| --- | --- | --- |
| Blind draft approval, using 102 fault cycles on one hub | Reproduced in 102/102 | The hub requires a playback acknowledgement before approval. A tap also keeps the context from the first event of its pattern. |
| Transcript changed after Reveal, same baseline cycles | Reproduced in 102/102 | Reveal freezes the hub transcript and releases the phones’ microphones. |
| Offline operator fallback | Three fixed whispers | A hardcoded 18.4-second pitch includes a receipt, private draft, confirmation, four whispers, and the seven-bit reveal. |
| Local text model on 12 synthetic Pitch situations | 8/12 expected outcomes, 11/12 within the timeout | 11/12 expected outcomes, 12/12 within the timeout. Routine narration cases returned no drafts. |
| Overlapping one-earbud cadence, 2,000 synthetic trials without dropped events | 47 wrong classifications with the first calibrated fit | Zero wrong classifications with the wider rejection interval. It rejects more ambiguous taps. |
| Cue loudness spread, measured with Earshot | 20.6 dB | 8.7 dB. The original ElevenLabs clips stay in the bank. |
| Safari Live board, 96 synthetic transcript lines | Rendered all 96 lines and updated the hidden Reveal | Renders the last 12 per seat. The full transcript still appears on Reveal. |

## Real service and browser evidence

- **Live providers.** One run through the actual Mac hub cloned Seat B from an ElevenLabs-generated 30-second sample and made all four fixed whispers available in 4.17 seconds. Both real Scribe streams accepted synthetic PCM, and Seat B’s test phrase was transcribed word for word. One real OpenAI request produced a private ElevenLabs draft. The draft MP3 downloaded 316 ms after the decision and 4.21 seconds after the start of the emulated L-R gesture. R1 after the playback acknowledgement released the cloned sender clip. Cleanup removed the temporary clone ledger.
- **Safari.** The two browser seats completed the fixed send, receipt, private preview, confirm, wrap, and Reveal. The reveal showed four messages, 16 words, and seven tap bits. The synthetic decision-to-scheduled-playback measurement was 1.10 seconds. Safari also reported both seats’ playback starts for the operator’s sound check and in-pitch time cue. Both seats rejoined with their caches after a full hub restart. At 320 CSS pixels all nine phone screens fit. Normal-time emulated calibration improved from 21 to 32 of 33 after fixing Safari’s batching of background timers.
- **Verification commands.** `npm test`, `npm run rehearse`, and `npm run rehearse:faults -- --tls --fast --cycles=2` cover the local paths. The extended fault rehearsals exercise reconnects, an incomplete cache swap, a private draft, the frozen reveal, and full and partial operator confirmations without provider calls.

## Extended local rehearsals

The installed copy passed 153 automated tests and five of five standard-timing pitches. Each successful pitch reached Reveal with four messages and seven bits. The no-service operator replay downloaded all five voice clips and reached Reveal after 18.4 seconds.

| Run | Elapsed | Clean / attempted | Interrupted by the lid closure | Dropped packet attempts retried | Final packet losses |
| --- | --- | --- | --- | --- | --- |
| First build over WS | 18m 11s | 0 / 102 | 0 | 885 | 0 |
| Hardened session over WS | 85m 1s | 397 / 398 | 1 | 3618 | 0 |
| Mission operator over WS | 74m 10s | 336 / 337 | 1 | 3415 | 0 |
| Trusted WSS and mission operator | 67m 1s | 301 / 302 | 1 | 2979 | 0 |
| Post-calibration WSS | 16m 26s | 55 / 56 | 1 | 519 | 0 |
| Trusted WSS with idle-sleep hold | 34m 0s | 165 / 165 | 0 | 1732 | 0 |
| Installed copy, first WSS run | 17m 35s | 8 / 9 | 1 | 78 | 0 |
| Installed copy, same-seed WSS rerun | 8m 1s | 39 / 39 | 0 | 393 | 0 |

The hardened session cleared the same first 102 seeds from the first build. Across the separate hardened runs, 1,301 of 1,306 cycles completed cleanly. Five interrupted attempts coincided with two lid closures. Every other attempt completed. The installed copy passed all 39 cycles on the same-seed rerun, including the exact cycle interrupted in its first run.


## MacBook and hotspot

Four automated cycles timed out during one confirmed lid closure. The Mac entered maintenance sleep for 302 seconds from 4:44:12 to 4:49:14 p.m. ET, and the affected cycles stopped making progress in that window. A separate lid closure at 5:31:24 p.m. ET stopped the first installed-copy run during cycle nine. That run’s first eight cycles had passed. The launcher holds a temporary idle-sleep assertion while its own hub process is running. Keep the lid open during the demo.

The fresh launch passed HTTPS and WSS on the Mac’s LAN address. The later launch, after the network changed, showed no usable hotspot address and still served Mac-only rehearsal. Connect the Mac and both phones to the same hotspot before restarting.

## Hardware still to verify

The physical streak remains **0/5**. Operate one physical pair with the five-minute calibration, then run the ten-minute checklist once both phones and both pairs of earbuds are available. Verify Bluetooth callback delivery, mic and earbud coexistence, directional audio, the actual presenters’ clones, and the under-two-second decision-to-whisper target on the hotspot. Live touch buttons cover missing tap events. The bundled pitch works without either phone.

- [Five-minute calibration and ten-minute checklist](rehearsal.md)
- [Presenter, coach and MacBook operator cue sheet](pitch.md)
- [Operator screenshot](screens/mission-operator.png)
- [Offline reveal screenshot](screens/canned-reveal.png)
