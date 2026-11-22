# Telepath hackathon pitch brief

## The problem and the hook

A teammate in the audience sees a judge looking lost, hears a question the presenter missed, or knows which fact would make an answer land. Interrupting makes the pitch harder. Telepath gives two people in the same room a private audio channel through the earbuds they already wear. The same app can coach the presenter during the pitch that introduces it.

## The live demo

Seat A presents Telepath. Seat B listens and can send a silent signal. A third person runs the MacBook. Start by demonstrating a fixed signal and its playback receipt. Then ask a real question about the product. The presenter arms Question Mode with one AirPods 1 next-track event or one AirPods Pro stem squeeze. OpenAI starts drafting while the judge speaks and a short cue plays privately in the presenter’s earbuds after the question commits. “What should I say?” is the on-screen manual request. The presenter answers aloud. At the reveal, show the two-seat exchange and the context view on the Mac.

A fixed cue uses cached ElevenLabs audio, which is available immediately after setup. The live answer uses fresh room context and takes time for model inference and speech synthesis. A private coaching cue goes to the requester. A drafted seat-to-seat message goes to the partner only after a separate confirmation. The stage also lets an operator send a neutral announcement to both seats.

## The devices and the signal path

The phones run Telepath in Safari or Chrome. Each phone connects to the Node.js hub over a WebSocket, decodes cached or generated speech with Web Audio, and exposes a touch fallback. There are two fixed seats, no accounts, and no need for a native app in the demo. The devices join the same hotspot and the phones use a trusted HTTPS link to the MacBook.

AirPods 1 sends a next-track event from a configured double-tap. The app counts next-track events inside a calibrated timing window. AirPods Pro stem squeezes arrive as play/pause, next-track, and previous-track media actions. The browser maps the actions to the selected earbud profile. The app cannot tell which physical earbud sent a media command. The demo uses earbud stem and track controls.

## Why the MacBook microphone

Using an iPhone microphone can change the audio session and interfere with Bluetooth media controls. The MacBook microphone hears the room over one shared input while both phones stay free to receive earbud gestures and play cues. The local operator selects the MacBook input on Stage. Only one Stage tab owns the capture. The hub sends the microphone's 16 kHz PCM audio to one ElevenLabs Scribe live stream. The stream returns a live transcript and anonymous speaker clusters. The operator can optionally label clusters Seat A and Seat B. An unknown cluster remains an anonymous speaker, so the app cannot claim to know who someone is from their voice.

## How the context coach works

Before the session, the operator can load the team brief, a pitch script, a spec, and other references as text, Markdown, text-based PDF, or DOCX. The hub extracts text and retrieves relevant passages. For “What should I say?”, Maritime plans whether to answer a question, add an important missed point, or cue the next pitch beat. OpenAI uses the plan, the speaker-labeled conversation, and the source passages to write a few cue words that the presenter can turn into their own answer. The hub checks that supporting quotes occur in the supplied sources, then ElevenLabs voices the cue. When remote Maritime is disabled, the same planning policy runs on the Mac and OpenAI still generates the final line.

The baseline material describes this build and its intended behavior. Treat results from a real two-phone rehearsal, exact latencies, security claims, and claims about model accuracy as facts only if the team supplies verified evidence. Speaker grouping can change as the transcription service refines a segment.

## ElevenLabs and fallback paths

ElevenLabs provides live diarized transcription, speech for the assistant and both seats, and the generated chime assets. Optional instant voice cloning is for playback, not for assigning speaker identity. Premade voices can be used for the whole demo. Fixed messages stay available from cached assets. The operator can play a bundled canned pitch and reveal if live hardware or network conditions stop the demo.

Documents, room audio, and the live session are ephemeral on the hub. Reset clears uploaded documents and session data. The hub holds the API credentials. Each cloud service sees only the inputs it needs for its part of the flow.

## Two features: Telepath and the coaching agent

Telepath is the teammate channel. A teammate in the audience sends a cue such as "Slow down" or "One minute left" with an AirPods gesture, and it plays privately in the presenter's earbuds. Today the gestures are tap and double tap on AirPods 1, or stem squeezes on AirPods Pro.

The coaching agent is "your agent in your ear". It listens to the room through the MacBook microphone. When someone asks a question, it whispers what to talk about. After the wearer answers, it can remind them of an important point they missed.

## Coaching scenarios

The operator picks one scenario on the stage before the session begins.

- **Pitch Q&A.** Judges question the team about the project. Cues come from the built-in project documents and any uploaded pitch notes, and each cue must quote a source.
- **Interview.** Someone being interviewed uploads their own background, such as a bio and prepared stories. Cues come only from those uploaded documents and must quote them. Without uploads, the coach stays quiet.
- **Date or small talk.** For a shy or awkward person getting to know someone. The coach suggests a topic or a question to ask, such as "Ask where they grew up", based on what the other person just said. It needs no documents, and the stage marks these cues as not coming from any document.

The stranger test shows the coaching agent at its clearest: hand the AirPods to someone who knows nothing about a topic, ask them a hard question, and the coach suggests the terms to mention or a clarifying question to ask.

## Fiber AI professional research

When a judge or interviewer is explicitly introduced with their full name and current employer, Telepath can look up a matching professional profile with Fiber AI. It uses the result as optional context for relevant future cues. A slow or unavailable lookup does not delay coaching.

## Roles of each service

- ElevenLabs transcribes the room, separates speakers, and speaks every whisper.
- Maritime hosts the planning agent. It decides whether a cue should answer a question, add a missed point, or suggest what to say next, and picks the supporting passages.
- OpenAI writes the short cue from that plan, the recent conversation, and the passages.
