# Telepathy — system architecture

Nov 21, 2026 · Jerry Li

## Overview

Telepathy lets two people in the same room message each other silently. Earbud taps go out; a chime and a whisper in the partner's own cloned voice come back. An AI listens to both rooms, keeps the meaning of each tap pattern matched to the moment, and drafts messages that the sender confirms with one tap.

The target is one flawless live demo: a pitch where a teammate in the audience steers the presenter silently, followed by a reveal of everything that was sent. Every choice below favours that demo. Hardcode whatever makes it more reliable.

This doc fixes the product architecture: concepts, flows, signals, sounds, screens and what to hardcode. Stack, protocols, models and code structure are the builder's call.

## Principles

1. **Eyes up, hands still.** Sending and receiving work without looking at a screen. The phone screen is for setup and an occasional glance.
2. **Nothing leaves without the sender.** Fixed messages go out on the sender's own tap. AI drafts are whispered to the sender first and need a confirm tap.
3. **Fixed is instant.** Fixed messages are generated at setup and cached on the partner's phone, so they play without waiting on any service.
4. **You hear your partner.** Every message arrives in the sender's cloned voice. Drafts and system lines use one neutral assistant voice, so you always know who is talking.
5. **Sound alone tells you what happened.** Message, draft, sent, receipt, error and system events each have their own sound.
6. **The AI speaks rarely.** At most one draft per seat every 30 seconds, and only when it's confident.
7. **Fail quiet, fail safe.** If the AI or a voice call fails, drafts drop silently and fixed messages keep working. The demo never waits on a service.

## System map

Phones capture and play; the MacBook hub coordinates the existing system. The planned Maritime extension below moves contextual coaching and answer retrieval to a hosted team agent while keeping delivery and approval on the hub.

```
Seat A                                Hub · MacBook                         Seat B
earbuds · taps, whispers   <-Wi-Fi->  Session and log                <-Wi-Fi->  earbuds · taps, whispers
phone · mic, signals                  (seats, presets, every event)            phone · mic, signals
cached fixed messages                 Codebook                                  cached fixed messages
                                      (signal -> meaning by preset)
                                      Room sense
                                      (transcripts -> situation)
                                      AI codec
                                      (drafts and smart messages)    -------->  Stage screen
                                          ^                ^                    (lobby, live board,
                                          |                |                     reveal, operator)
                                          v                v
                                      ElevenLabs           LLM
                                      voice clone,         situations, drafts,
                                      whispers,            smart messages
                                      transcription,
                                      chimes
```

Each phone is a thin seat: it recognises tap patterns, streams its mic, and plays chimes and whispers, with fixed messages cached locally. The hub on the MacBook holds the session, the codebooks, each room's situation and the AI codec. In the existing system it calls ElevenLabs and the LLM directly; with Maritime enabled, it calls the hosted agent for contextual suggestions. The stage screen is a view of the hub.

## Planned extension: Maritime conversation coach

**Specification only; implement later.** Add one Maritime-hosted agent per team. It follows the live conversation through ElevenLabs transcripts, detects unanswered questions, retrieves supporting information, and proposes a concise answer or solution when the participants need help. Keep all existing fixed whispers, private previews, approval gestures, expiry and receipts.

### Listening and answering

1. With listening enabled and participants informed, the phones stream audio through the existing transcription path. The hub sends recent transcript excerpts to the agent; Maritime does not transcribe the audio itself.
2. The agent tracks questions and whether the conversation has answered them. It can begin retrieval when a question appears, but offers help only after an explicit admission of uncertainty, a coach request through L-R, or a configurable unanswered interval with no answer underway. Silence alone does not prove that nobody knows.
3. Search the team's approved brief and reference documents first. Return a supported answer or actionable next step with source references. External search is a later, explicitly enabled extension; if the available material does not support an answer, stay quiet rather than invent one. Treat speech and retrieved documents as content, not instructions to the agent.
4. In Pitch, preview the suggestion privately to coach B in the neutral assistant voice: "Send: ...?" Keep the spoken answer to one short sentence; show supporting detail and sources on the stage. An explicit request from either seat uses that seat as the approving sender.
5. After preview playback, R1 approves delivery to the partner in the sender's cloned voice. Existing discard controls and the six-second approval window still apply. The agent never speaks directly to the partner or the room without approval.
6. Cancel an unsent suggestion if the question is answered, the conversation moves on, or the session resets. Preserve the existing draft cooldown and suppress repeated suggestions for the same question.

Example: someone asks who the buyer is, and the presenter says they are unsure. The agent retrieves the buyer from the approved brief and privately proposes "The buyer is the sales team lead" to B. B approves; A hears the answer in B's voice and can respond aloud.

### Implementation boundary

```text
Phones -> hub -> ElevenLabs transcription -> recent transcript
                                              |
                                              v
                                    Maritime team agent
                                    question tracking + brief lookup
                                              |
                                              v
Hub validates candidate -> assistant preview -> sender approves
                                              |
                                              v
                              ElevenLabs sender-voice whisper -> partner
```

- **Maritime service:** deploy a small Node container with `GET /health` and `POST /chat`, bound to the injected `PORT`. The service runs the coaching model and a brief-retrieval tool. Maritime provides the persistent agent machine; it is not the transcription or speech provider.
- **Hub adapter:** add a Maritime provider behind the existing `codec.evaluate(...)` interface. Send session ID, transcript sequence, recent speech, requested sender, and recent suggestions. Keep credentials on the hub or hosted service, never on phones.
- **Response:** return `suggest` or `no_action`. A suggestion includes session ID, transcript sequence, question ID, sender, short text, source references, and a brief reason. The hub validates and maps it into the existing candidate/preview flow; approval stays local.
- **State:** persist the approved brief, reference documents and explicitly saved preferences under `/data`. Keep raw audio, transcript excerpts, open questions and pending suggestions transient; clear session state on reset. Do not persist conversation content through application logs.
- **Timing and failure:** prepare the agent before the session, debounce transcript updates, and allow one evaluation in flight. Retrieval runs in the background and never blocks fixed cues. Discard stale or late results; retain the existing preview/audio timeout and approval expiry. Measure the full question-to-preview delay on physical devices before setting the retrieval deadline.
- **Reveal:** show the triggering question, retrieved source, proposed answer, and whether the human approved it. This makes the agent's contribution visible without reading evidence aloud.

### Minimum scope and acceptance

Build one team agent, one approved brief, question tracking, grounded retrieval, the hub adapter, and the evidence reveal. Defer multiple collaborating agents, web research, accounts and automatic long-term conversation memory.

Verify with a live question that was not scripted into the demo: the agent finds a supported answer and delivers it only after preview and approval. Also verify no answer when evidence is missing, cancellation when a human answers first, discard/expiry without delivery, reset rejecting old results, and fixed whispers continuing when Maritime is unavailable.

## Core concepts

Every screen, flow and log entry is built from these ten things.

| Concept | What it is | Demo hardcode |
| --- | --- | --- |
| Session | One live pairing of two seats on the hub | One session at a time, started from the stage screen |
| Seat | A person with their phone, earbuds and cloned voice | Exactly two seats, A and B, with preset names |
| Preset | A situation: context text, codebook and AI tone | Pitch, Party, Meeting; Pitch is the demo default |
| Signal | A recognised tap pattern from one seat | The fixed set in Signals, codebooks and sounds |
| Codebook | What each signal means, per preset and earbud mode | Fully hardcoded tables |
| Message | What the partner hears: a chime, then a whisper | Fixed (made at setup) or smart (made live) |
| Draft | An AI-written message waiting for the sender's confirm | Expires after 6 s with no answer |
| Situation | The AI's running read of one seat's room | Refreshed every 10–20 s from transcript and sound |
| Receipt | The partner acknowledging a message | The partner's R1 within 4 s of hearing it |
| Log | Every signal, draft, message and receipt, with time and bits | Kept in memory for the session, shown at the reveal |

Bits measure how much the tap itself carried: picking one of N meanings is log₂ N bits. The reveal compares those bits with the sentence that arrived.

## Message lifecycle

Nothing reaches your partner without your tap.

```
FIXED SIGNAL
Sender taps            ->  Codebook lookup   --cached audio, instant-->  Partner hears it
(R1, R2, L1 or Out)        (preset + signal)                             (chime, then whisper)
                                                                                 ^
AI DRAFT                                                                         | to partner
AI spots a moment      ->  Draft to sender   ->  Send it?  --R1-->  Sender's voice
(or sender asks: L-R)      (assistant voice)        |               (generated live)
                                                    | L1 or 6 s silence
                                                    v
                                                Discarded
```

A fixed signal goes straight to the partner from cached audio. An AI draft always stops at the sender first: R1 sends it in the sender's cloned voice, while L1 or 6 s of silence throws it away. After either path, the partner can R1 within 4 s to send a receipt.

## Key flows

### Setup, per seat, about 90 s

1. **Join:** open the app on the phone and pick seat A or B. No accounts.
2. **Voice:** read the on-screen script for 30 s. The clone builds in the background.
3. **Earbuds:** choose two-earbud or one-earbud mode, then play a left and a right test whisper.
4. **Calibrate:** perform each pattern three times when prompted. Each one is confirmed by sound.
5. **Preset:** pick one, or the operator sets it from the stage. The seat's fixed messages are generated in its voice and cached on the partner's phone.
6. **Ready:** both seats show Ready on the stage screen.

### Send a fixed message

1. The sender taps a pattern. It closes after about 1.2 s with no taps.
2. The sender hears the sent tick, or the error buzz if the pattern wasn't recognised.
3. The partner hears the message chime, then the cached whisper.
4. If the partner does R1 within 4 s, the sender hears the receipt sound.

### The AI drafts a message

1. Reading both situations, the AI decides a message would help now.
2. The sender hears the draft chime, then the draft in the assistant voice: "Send: *the judge on the left looks lost*?"
3. R1 sends it, L1 discards it, and 6 s of silence discards it.
4. A sent draft is spoken to the partner in the sender's cloned voice, like any other message.

### Ask for a smart message

1. The sender does L-R (one-earbud mode: Three).
2. The AI writes its best message for right now, and the flow continues from step 2 of the draft flow.

### Hear the codebook

1. The sender does L2 (one-earbud mode: Slow two).
2. The assistant voice reads the current meanings in under 5 s.

### Earbud out, earbud in

1. Removing an earbud sends that seat's Out message to the partner, with the urgent chime.
2. Putting it back plays a short "back" sound to the partner.

### Situation changes

1. The AI notices that a seat's room no longer fits the preset, for example music starts.
2. That seat hears the system chime and "Sounds like a party. R1 to switch."
3. R1 switches both seats. The old preset stays live until the new fixed messages are cached.

### Something fails

1. An AI or voice call fails or takes over 3 s: the draft drops silently and fixed messages keep working.
2. A phone loses the hub: its next tap plays the error buzz, and the stage shows that seat offline.
3. The operator can play the canned demo take from the stage at any time.

## Signals, codebooks and sounds

Both earbuds' double-tap is set to Next Track (right) and Previous Track (left), never Play/Pause, so a tap can't be mistaken for an earbud coming out.

### Signals

| Signal | Two-earbud pattern (demo) | One-earbud pattern | Role |
| --- | --- | --- | --- |
| R1 | Right double-tap | One double-tap | Fixed message 1; sends a pending draft |
| R2 | Two fast right double-taps | Two fast double-taps | Fixed message 2; in one-earbud mode also discards a pending draft |
| L1 | Left double-tap | Not available | Fixed message 3; discards a pending draft |
| L2 | Two fast left double-taps | Double-tap, pause, double-tap | Hear the codebook |
| L-R | Left, then right | Three fast double-taps | Ask the AI for a smart message |
| Out | Any earbud removed | Earbud removed | Urgent fixed message |

### Codebooks

Fixed messages, spoken in the sender's cloned voice:

| Signal | Pitch (demo) | Party | Meeting |
| --- | --- | --- | --- |
| R1 | Slow down | Come find me | Are you following? |
| R2 | One minute left | Save me from this conversation | Let's talk after |
| L1 | Show the demo now | I'm good, stay | I agree, back it up |
| Out | Wrap it up now | Let's leave | I'm stepping out |

AI tone per preset: Pitch is terse coaching, Party is casual, Meeting is discreet. Each preset also carries a short context paragraph the AI reads, for Pitch the real pitch outline.

### Sounds and voices

| Sound | Meaning | Heard by |
| --- | --- | --- |
| Message chime, soft | Your partner sent something | Receiver |
| Message chime, urgent | Your partner sent an Out message | Receiver |
| Draft chime | The AI wants you to approve a message | Sender |
| Sent tick | Your pattern registered and went out | Sender |
| Receipt | Your partner acknowledged | Sender |
| Error buzz | Pattern not recognised, or hub unreachable | Sender |
| System chime | Preset suggestion or status line | Either |

Messages use the sender's cloned voice. Drafts, the codebook readout and system lines use one neutral assistant voice. All chimes are generated once with ElevenLabs' sound-effects tool and shipped with the app.

## Screen map

Each phone sets up once, then lives on one glanceable screen.

```
PHONE APP · EACH SEAT
Join  ->  Setup, once  ->  Live (glanceable status)  ->  Codebook
          Voice                                      ->  Log
          Earbuds                                    ->  Settings
          Calibrate                                      (each returns to Live)
          Preset

STAGE SCREEN · MACBOOK
Lobby  ->  Live board  ->  Reveal
[ Operator controls, hidden, on every stage screen ]
Slides stay on the projector until the reveal.
```

The phone walks through setup once, then stays on Live for the whole session; Codebook, Log and Settings open from it and return to it. The stage screen moves from Lobby to Live board to Reveal, with operator controls available on all three.

## Screen specs

Visual direction: dark, minimal, Swiss editorial. Near-black background, off-white text, one accent colour, large type, hairline rules, no rounded cards. Phone screens must read at a glance in a dark room.

### Phone app, each seat

| Screen | Purpose | Key elements |
| --- | --- | --- |
| Join | Pick a seat | Seat A and seat B, hub connection status |
| Voice | Build the clone | Reading script, 30 s progress, consent line |
| Earbuds | Choose mode and test | Two-earbud or one-earbud, left and right test whispers |
| Calibrate | Teach your taps | Each pattern prompted three times, a tick per pattern |
| Preset | Choose the situation | Pitch, Party, Meeting, Custom (one line of context) |
| Live | Glance at status | Partner connected, current preset, last message in and out, draft pending, listening dot, touch buttons for every signal as a fallback |
| Codebook | See current meanings | Each signal and its meaning for this preset and mode |
| Log | Review this session | Messages in and out, with times |
| Settings | Adjust | Earbud mode, AI drafts on or off, volumes, re-record voice, re-calibrate |

### Stage screen, MacBook

| Screen | Purpose | Key elements |
| --- | --- | --- |
| Lobby | Get both phones in | Join address or QR code, per-seat voice and calibration status |
| Live board | Watch the system work | Two seat columns: situation, latest transcript lines, signals, drafts, messages; running bits counter |
| Reveal | The payoff | Timeline of every message against time, bits per message and in total, both transcripts side by side |
| Operator | Hidden controls | Set preset, inject a message, replay the last one, play the canned take, reset the session |

During the pitch the projector shows slides. The live board and reveal go up only after the pitch.

## Hardcoding plan

Hardcode everything that doesn't need to be live for the demo to be real.

| Area | Hardcoded for the demo |
| --- | --- |
| Pairing | Two seats with fixed names, a fixed hub address on the MacBook, no accounts |
| Network | Both phones on the MacBook's hotspot or Jerry's iPhone hotspot, never venue Wi-Fi |
| Presets and codebooks | The tables in this doc, written into the app |
| Pitch context | The real pitch outline, slide order and judge seating typed into the Pitch preset |
| Voice clones | Pre-made clones of both presenters as a fallback if live cloning is slow |
| Audio | Chimes shipped with the app; fixed messages generated at setup and cached on the partner's phone |
| Draft rules | One per seat per 30 s, 6 s expiry, a fixed confidence bar |
| Failure | A canned demo take on the operator screen; fixed messages never depend on the AI |
| Reveal | Bits computed from codebook size; the log kept in memory for the session |

## Out of scope, and what to verify first

Out of scope: accounts, saving conversation content after the session, more than two seats, head gestures, working with the phone locked (keep screens awake), and production security or privacy controls beyond a visible listening indicator. The planned Maritime extension may persist approved reference material and explicitly saved preferences, as described above.

Verify before building on them:

1. Earbud double-taps reach the browser as next and previous track on iPhone Safari, Android Chrome, and the MacBook with AirPods 1.
2. On iPhone, opening the mic with earbuds connected keeps taps and whispers working.
3. A 30 s reading gives a clone good enough for short whispers.
4. The draft path, from the AI's decision to the whisper, stays under about 2 s.

## Handoff to the builder

Keep the concepts, flows, signals, sounds, screens and hardcoding exactly as written here. Everything technical is yours: stack, protocols, models, file layout, how each service is called.

Build in this order:

1. The four checks in the section above.
2. The fixed loop on two devices: tap, signal, codebook, partner hears the cached whisper, receipt.
3. Voice cloning and per-seat cached audio.
4. Room sensing, situations and AI drafts with confirm and discard.
5. The stage screen: lobby, live board, reveal and operator controls.
6. Polish: sounds, timing, every screen in the visual direction.

Ship a simulated seat (keyboard or on-screen signals) so the whole loop can be tested without earbuds.

Done means two phones and two pairs of earbuds run a full steered pitch and the reveal five times in a row without a failure.
