# Telepathy hub protocol

The Mac serves the stage at `/stage` and the seats at `/`. The stage socket accepts loopback connections only. Phones connect to `/ws?role=seat&seat=A` or `B`. Rehearsal seats add `sim=1` and use the same input recognizer and session. Opening a replacement socket closes the earlier one for that seat.

## Phone to hub

| Frame | Fields and behavior |
| --- | --- |
| `signal` | `id` and a signal from `R1 R2 L1 L2 LR OUT BACK`. The first event in a pattern records its `draftId`, `receiptId`, and `cacheId`. A message bound to an expired draft, an expired receipt or a replaced codebook cannot send something else. |
| `heard` | `messageId`. The browser’s audio clock has reached the scheduled beginning of the whisper. A draft can be approved only after this acknowledgement. |
| `cache_ready` | `activeId`. The phone has decoded the whole manifest. Both seats acknowledge before the hub swaps codebooks. |
| `configure` | `mode` of 1 or 2 and optional `drafts`. |
| `setup` | `step` of voice, earbuds, calibrate, or ready and `complete`. A deliberate **Use premade** sends `fallback:true`, which takes effect even when a clone is building. |
| `voice` | `requestId` and base64 WAV, generated locally after the person consents. |
| `listen`, `mic` | Listening intent and base64 PCM16 mono at 16 kHz. The phone sends an RMS level with each audio frame. The hub connects to ElevenLabs for transcription. |
| `sim_transcript` | `text` and optional RMS `level`. The hub accepts this from rehearsal sockets. |

Phone frames include the most recent `hubId` and `sessionId` once known. The first event in a gesture records those identifiers. Disconnects, reset and hub restarts cancel old work.

## Stage to hub

The loopback stage sends `{type:"operator",action}`. Supported actions are `begin`, `preset`, `inject`, `replay`, `canned`, `reset`, `reveal`, and `announce`. An announcement carries up to 140 characters of text. The hub uses one neutral voice clip for both connected seats and tracks which seats started playback. It counts zero tap bits.

## Hub to clients

- A `state` frame carries the phase, scope, preset, cache IDs and current seat states. The stage receives both transcripts and the operator announcement result. A seat receives its own transcript, pending draft, and active receipt.
- A `cache` frame carries an `activeId` and `items` of `{key,url}`. A fixed message uses the decoded key and manifest generation. Dynamic speech refers to an in-memory `/assets/…` URL.
- An `audio` frame has a cue and optional speech. `kind:"announcement"` identifies a shared system line. The same clip and message ID go to every target, and the hub tracks acknowledgements separately.
- `signal_ack` acknowledges transport to the current hub/session. A missing acknowledgement produces an error cue. The phone never retries the tap. `voice_status` reports generation, verified voice, fallback, or error.

The browser code stays dependency-free. The hub owns state and providers. Node 22 or later and the `ws` package run the server and the keyless rehearsals.
