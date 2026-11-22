# Question coaching

## From judge speech to cue

Question Mode is armed before the judge asks, using the phone control or the configured single earbud action in Pitch. Receipt or draft confirmation takes priority when applicable. While armed, the hub maintains a text-only OpenAI Realtime WebSocket. A likely question from the ElevenLabs transcript can start the cue request during the partial turn. A materially expanded partial can supersede an early draft. Playback waits for the committed question. The hub compares partial and final text and throws away a stale draft when they materially differ.

OpenAI sees a small recent transcript window, including the question, a project overview, and retrieved evidence. It does not receive the raw microphone stream in the Question Mode path. Its in-ear instruction should lead with the concrete mechanism or next step. The system rejects meta phrasing such as “grounded in project references” when the judge asked about the implementation. A ready project-reference cue provides a walkthrough for a broad “how did you develop it?” question. It describes how the parts fit, without inventing a chronology of who wrote which code first.

ElevenLabs synthesizes the final text. The browser plays it more softly than normal messages. When the shared transcript starts to pick up speech over an active cue, the hub can stop that specific clip and reassess the completed answer. It offers one missing point when it has enough evidence. A full answer needs no correction. Since the room mic hears everyone, unassigned speech can be ambiguous; assigning presenters to speaker clusters improves review accuracy.

## How retrieval and citation work

The reference corpus combines current design and implementation documents, the historical spec, and selected source code. A sparse in-memory index lets the hub match question terms and technical paraphrases. Current documentation explains meaning, tradeoffs and product results. The code index is a separate lookup lane for requests about files, handlers, methods, functions, or named identifiers. This keeps raw code from crowding out prose answers to a general judge question. Source-code excerpts preserve their file and line-range labels.

The Realtime request packs a few short excerpts from the ranked material. It can reserve a source-code excerpt when the question asks for implementation detail. The Responses API fallback works with a broader ranked collection. The hub validates the model’s quote against the actual evidence sent. The evidence check can recover added terminal punctuation by taking the original exact span. It rejects added or changed words that do not occur there. Citation integrity cannot by itself establish the truth of an entire model answer. When source coverage is uncertain, the safer cue is to clarify or show a concrete demo.

Documents under the handbook help answer questions about the project and its technical architecture. Real room audio, uploaded private reference files, local startup logs and credentials are outside the built-in project corpus. User-uploaded references are indexed separately for the current take, with the upload limits intact. Only selected passages leave the hub in an enabled model request.

## What makes it fast

The hub opens the OpenAI Realtime connection when Question Mode is armed and composes from partial speech. Retrieval is local and uses an inverted sparse index, so it does not add a network round trip. The response is a brief speaking prompt, not a script. The browser plays a short cached chime before the whisper. Capturing, recognizing and committing a final transcript, generating text, synthesizing audio, sending an audio frame, and Bluetooth playback each contribute separate latency. A synthetic test can time the audio frame after final transcript without measuring the microphone, judge pause, or Bluetooth legs.

If Realtime is slow or disconnects, the hub can fall back to the Responses API within its deadline and reconnect later. If the model misses the overall cue budget, a short local cue supplies a useful next move. If ElevenLabs speech synthesis is unavailable, the text cue remains on the requesting phone. Fixed signals continue to use their previously cached audio where available.
