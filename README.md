# Telepathy

Two fixed seats, one MacBook hub. A double-tap sends a cached whisper from the partner’s ElevenLabs voice. A suggestion goes to the sender in the assistant voice and requires a tap before the partner hears it.

## Start

From this folder, run `./start`. Node 22.13 or newer is required. The launcher installs missing npm dependencies, starts the stage on loopback, prints the HTTPS phone address, and shows which text model the hub will use.

Set `ELEVENLABS_API_KEY` and optionally `OPENAI_API_KEY` in the launcher’s environment, or point `TELEPATHY_ENV_FILE` and `TELEPATHY_OPENAI_ENV_FILE` to owner-only environment files. The default files are `.env.local` and `.env.openai.local`, both ignored by Git. The phones never receive the keys.

`TELEPATHY_VOICE_A` and `TELEPATHY_VOICE_B` can name the two presenters’ existing, verified ElevenLabs clones for setup fallback. Those voice IDs are not deleted. Session-created clones are deleted on reset or a normal exit. When a clone is unavailable the UI labels any fallback. Keep the operator’s canned take ready for a service or hardware failure.

The hub uses OpenAI for text when its key is present. Set `TELEPATHY_LLM=local` to keep the room-read text on the Mac via Apple’s local language model, or `TELEPATHY_LLM=off` for fixed messages only. By default, the stage captures the Mac's microphone and the hub sends its PCM audio to ElevenLabs for transcription. Phone room microphones remain off; phones still play whispers and handle approval. No recording or transcript is saved to disk by the app.

## Listen through the Mac microphone

Open the printed local stage URL on the Mac. In **Room microphone**, click **Start Mac microphone** and allow browser microphone access. Choose **MacBook Microphone** as the macOS Sound input (not AirPods), or select that device in the stage's input menu. If device names were hidden before permission, stop the microphone, select the now-labelled Mac input, and start it again. The input meter should move and **Shared room transcript** should fill as you speak. This can be checked in the lobby before connecting phones.

Load the references and prepare seats A and B as usual, then begin the session. The shared room transcript drives both question answers and missed-point reminders through the existing private preview and approval flow. Use the phones' on-screen Send/Discard and fixed-message buttons if earbud gestures are unavailable. Phone microphone permission is only needed if you choose to record a voice sample; premade voices avoid that step.

**Stop microphone**, Reveal, Reset, losing the stage connection or closing its tab stops room listening and cancels pending answers. Start the microphone again for a new session or after reconnecting. Only one stage tab owns capture at a time. Browser capture needs the local `localhost`/`127.0.0.1` stage URL or trusted HTTPS. On macOS, also allow the browser under System Settings → Privacy & Security → Microphone. An ElevenLabs key is still required for transcription.

To explicitly return to the old phone-microphone mode, start the hub with `TELEPATHY_ROOM_INPUT=phones`. Starting the Mac microphone switches the running session to Mac input again.

## Answer questions from your documents

Before **Begin session**, use **Team brief & references** on the local stage to load TXT, Markdown, text-based PDF or DOCX files (up to eight files, 5 MB each / 8 MB total, 200,000 extracted characters). Each upload replaces the set. Scanned PDFs need OCR first. Documents remain in hub memory and are cleared on reset; nothing is saved to disk.

Document answers require `OPENAI_API_KEY` and the OpenAI text provider (`TELEPATHY_LLM=openai`, or the default when that key is present), plus ElevenLabs for live transcription and whispers. Relevant passages and recent conversation are sent to the configured model. Maritime is not used. Without references, ordinary coaching works as before.

Completed speech triggers a debounced question check. The coach uses the references to propose a short supported answer when someone asks for help, expresses uncertainty, or leaves a question unanswered. L-R explicitly requests help. The assistant previews answers to the coach (or the requesting seat); a tap still approves delivery in that person's voice. New speech cancels pending answers immediately, including during generation, and the next completed transcript is re-evaluated. The stage shows answer status and evidence. Unsupported questions stay silent; no web search is performed.

Use real seats to exercise generated answer audio. Simulated seats retain their bundled-audio behavior and cannot speak arbitrary new answers. Verify microphone/earbud coexistence and latency on the actual hardware before presenting.

The same coach also checks completed answers for important omissions. For example, if you describe a pilot but omit its documented duration, it can propose "You forgot to mention the six-week pilot." It waits for a pause or a help request, checks the point against your references and the actual spoken answer, and uses the same private preview and approval flow. The stage shows the answer excerpt and supporting source. Covering the point, moving on, or any new speech cancels a pending reminder before re-evaluation; reminders are suppressed after approval, rejection or expiry for that question.

## Rehearse now

1. Open the printed stage URL. Open the two rehearsal-seat links and complete the simulated setup in both tabs. Start the session from the stage.
2. Touch a signal or use `R` and `L` for right and left track callbacks, `O` to remove an earbud, and `I` to put it back. Press R or L twice within the fast gap for a two-tap signal. The simulated controls feed the same browser input dispatcher as Media Session.
3. Send from Seat B, acknowledge with R1 on Seat A after hearing it, and give Seat B the simulated transcript “The judge on the left looks lost.” Wait for a draft, confirm with R1, then Reveal from stage.
4. In Operator, choose a preset announcement and send it to check playback on both seats. For an offline fallback, choose **Canned take** to play the bundled pitch, receipt and confirmed draft through the stage. Keep slides on the projector during a real pitch and bring up the stage for the reveal.

The browser rehearsal uses bundled ElevenLabs audio and scripted excerpts without paid API calls. With real seats, the operator can also type a short announcement in the neutral ElevenLabs voice. It is sent once to both connected phones. `npm test` checks timestamp patterns, signal logic, and service integrations. `npm run rehearse` runs five WebSocket rehearsals with seeded loss, jitter, and delayed retry plus the offline operator take. `npm run rehearse -- --fast --runs=1` is the quick smoke test. `npm run rehearse:faults -- --tls --fast --cycles=5` also checks pre-playback approval, reconnect, preset changes and the operator's full/partial playback confirmations. The automated seat clients verify asset delivery and receipt timing using application frames. The physical browser and Bluetooth playback checks are in the rehearsal guide.

## Physical demo

- [Third-person operator and pitch cue sheet](docs/pitch.md)
- [Five-minute real-AirPods calibration and ten-minute two-phone checklist](docs/rehearsal.md)
- [Exported product spec](docs/spec.md)
- [Verification report](docs/report.md)

To keep the printed phone URL fixed, set `TELEPATHY_HOST` to the Mac’s hotspot address. If the Mac changes networks, restart the hub for the new IP. Using your own trusted LAN certificate is also supported by setting both `TELEPATHY_TLS_CERT` and `TELEPATHY_TLS_KEY`.

The checked-in speech and chime files are ElevenLabs-generated demo assets. Fixed, live speech uses the sender’s configured or session clone when it is available. Dynamic provider-generated audio and microphone samples are held in memory. Live seat speech requests Eleven v4 Turbo’s whisper delivery. If the model fails in time to retry, the hub uses Flash from the same ElevenLabs voice at the seat’s quiet playback gain. Check the resulting delivery and volume on both actual earbuds.

## Agent coordination

Use the [agent board](https://github.com/fireheartjerry/telepathy/discussions) for updates and handoffs. Check the shared file and UI claims with `npm run board -- list`. The [agent handoff guide](AGENTS.md) explains how to claim or release work from any checkout.
