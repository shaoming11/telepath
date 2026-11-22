# Telepath technical reference

## Project overview

Telepath helps two teammates in the same room give each other discreet feedback without interrupting a conversation. The demo is a pitch about Telepath itself. A presenter and a coach each wear earbuds paired to their own phone. Cached cues let them steer pace and timing. A Mac operator can send an announcement to both seats. One earbud gesture requests a private answer grounded in the room conversation and project references. The presenter speaks their own answer. These are two-seat hackathon workflows, without user accounts.

## How we built the project

The implementation connects Safari earbud controls, a Mac hub, and private cues written by OpenAI and voiced by ElevenLabs. To explain how we developed Telepath, start with the phone translating a hardware gesture to a media event. Then show the Mac routing that event and listening to the room. Finish by showing how the live question becomes a private cue in the presenter's ear. That is a walkthrough of the implementation, not a claim about the order in which the team wrote each component.

## Phone client, AirPods and control routing

Safari or Chrome renders the phone UI and handles Media Session events. AirPods 1 converts a configured double-tap into a next-track event. Its recognizer counts one, two or three next-track events using a calibrated window. Calibration uses two successful doubles and two successful triples; failures retry. AirPods Pro maps single squeeze to play or pause, double to next track, triple to previous track. Browser media events do not identify which earbud produced them. In a Mac room pitch, one AirPods 1 double-tap or one Pro squeeze asks for an answer. Draft approval and receipts have their own screen controls. The UI has touch fallbacks. Sources: public/input.mjs, public/earbuds/airpods-1/input.mjs, public/earbuds/airpods-pro/input.mjs, public/phone.mjs.

## Hub, WebSockets and private routing

The Mac hub runs Node.js 22.13+ using standard HTTP/HTTPS, the ws package, and in-memory session state. Both phones join over the same hotspot using HTTPS and WebSockets. The Stage operator uses the local loopback URL. Session and hub IDs scope frames and prevent stale commands after a reset or reconnect. The hub caches generated and fixed assets and routes a private cue to the requesting seat only. Operator announcements go to both seats. Fixed messages and approved drafts are distinct from private coaching, and phone playback acknowledgements report Web Audio start rather than human audibility. Sources: hub/server.mjs, hub/session.mjs, public/phone-audio.mjs, docs/protocol.md.

## Audio capture, speech recognition and speaker identity

Only the Mac Stage owns the default room microphone. Moving room recording off the phones leaves the phones in playback mode for earbud controls. A Web Audio worklet converts microphone audio to mono 16 kHz PCM; the Mac sends it through one ElevenLabs Scribe v3 Live WebSocket with diarization. The stream emits partial text, completed segments, and optional speaker labels. Labels are anonymous speaker clusters, not voice recognition or identity verification. The operator can assign known clusters to seats. The room transcript stays in hub memory during the take. Sources: public/capture.mjs, public/stage.mjs, hub/audio.mjs, hub/session.mjs.

## On-demand coaching

Squeeze AirPods Pro once, double-tap AirPods 1 once, or use **Cue now**. The hub sends the entire room transcript so far, the project overview, and selected passages to OpenAI Responses. OpenAI infers the most recent genuine question and writes one short answer. The default answer model is gpt-4.1-mini. ElevenLabs alone receives raw mic audio; OpenAI receives transcript snapshots and project evidence. ElevenLabs whispers the answer only to the requesting seat. Sources: hub/session.mjs, hub/codec.mjs, hub/audio.mjs.

## Retrieval, grounding and document ingestion

The Mac indexes project docs, uploaded references, retained Fiber findings, and selected code. For each requested answer, lexical and exact-code retrieval run alongside cosine search over hashed token vectors in an in-memory SQLite database. The hub combines the ranked passages and checks that cited IDs and supporting quotes appear in evidence sent to OpenAI. Sources: hub/references.mjs, hub/context-vectors.mjs, hub/questions.mjs.

## Latency, failures and fallback behavior

The hub overlaps OpenAI drafting with speech recognition, opens the Realtime connection when armed, bounds model and synthesis waits, and plays a short cached chime before the private whisper. If Realtime fails, the hub can use OpenAI Responses with gpt-4.1-mini by default. If OpenAI misses the budget, a short local cue keeps the pitch moving. If speech synthesis fails, the cue remains visible on the phone. A lost Realtime connection can reopen on a later question. Fixed messages use cached ElevenLabs audio; the operator can also play a canned take. Stage evidence records planner source and can show time to browser playback start. These timings do not include an independently measured physical Bluetooth delay. Sources: hub/session.mjs, hub/codec.mjs, public/phone-audio.mjs, scripts/rehearse.mjs.

## Providers, credentials and lifecycle

ElevenLabs supplies transcription, speech, optional playback voice clones, and the generated chime assets. Neutral cue synthesis uses ElevenLabs Flash v2.5 by default. Clones are optional and do not identify speakers. Hosted Maritime is an opt-in planner; its custom agent can precompute a plan from bounded excerpts while OpenAI writes the cue. With hosted Maritime disabled, the Mac runs the planning policy locally. API credentials remain on the hub; relevant transcript and document excerpts go to the enabled providers. The software clears session state and uploaded references on reset. App-created voice clones are cleaned up on reset or normal shutdown. Sources: hub/audio.mjs, hub/maritime.mjs, hub/pitch-planner.mjs, maritime/server.mjs, docs/maritime.md.
