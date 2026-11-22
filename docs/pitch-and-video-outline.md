# Pitch and video outline

Draft plan for the 2-minute video and the 3-minute live pitch. The live run uses the beats in the [pitch cue sheet](pitch.md). This file is not part of the hub's reference index.

## Before filming

Fiber AI profile lookup (feature 1) is not built in this repository yet. Build it before filming, or show it in the video labelled as coming next. Do not demo it live as if it works.

## The approach

- **One story, three moments.** A pitch has three moments: you meet the judge, you pitch, then you answer questions.
  - Meet: Fiber lookup
  - Pitch: teammate cues
  - Q&A: the agent's answers and the points you missed

  The AirPods gestures are the controls for all three, so show a tap in every scene.
- **The stranger test is the proof.** Hand the AirPods to someone who knows nothing about the topic, ask them a hard question, and the agent gets them through it. If it works for a stranger, it works for you. Keep the scene short.
- **Split the work.** The video shows what is hard to do live: the networking scene, close-ups of the taps, and what the presenter hears. The live pitch is the proof. Use Telepathy while pitching Telepathy, then reveal it at the end.
- **Positioning line:** "Cluely for the room, with your teammate in the loop." Use it once at most.

## The stranger test

Used in both the video and the pitch.

1. Pick the hard question and its topic in advance, for example "How would you reduce tail latency in a distributed cache?" Upload a one-page explainer on that topic under **Team brief & references** before **Begin session**. The coach only answers from the bundled brief and uploaded references and stays silent on anything else, so without the upload the stranger hears nothing.
2. Arm **Question mode** on Seat A's phone before handing over the AirPods, so the stranger never needs to tap.
3. Hand over the AirPods, ask the question, and let them hesitate. A pause, "I don't know" or a request for help triggers the cue.
4. They hear a short cue. It names terms to mention ("Mention replication and request hedging") or a clarifying question to ask ("Ask: what's the read-write ratio?"). They answer, and it sounds like they know the topic.

Rehearse this with a real person at least twice. Check that the cue's wording suits someone who doesn't know the topic, and that playback resumes after the AirPods come out of one ear and go into another.

## 2-minute video

| Time | Scene | On screen |
| --- | --- | --- |
| 0:00–0:08 | **Cold open.** The presenter is rambling. The teammate in the audience winces and can't say anything. | Text: "What if they could tell you?" |
| 0:08–0:20 | **Problem.** Pitches fall apart quietly: you run long, miss the key point, or freeze on a question. Interrupting makes it worse. | Quick cuts of each failure |
| 0:20–0:40 | **Meet.** A judge says "I'm a partner at X, I focus on devtools." The presenter taps once and hears a whisper: their background, a question to ask, and what to emphasize for that role. | The Fiber profile, with the whisper as a caption |
| 0:40–1:00 | **Pitch.** The teammate double-taps and the presenter hears "One minute left." Later, a tap sends "Slow down." | Split screen: close-up of the tap, and the presenter adjusting |
| 1:00–1:20 | **Q&A.** A judge asks a hard question. The presenter taps, hears a prompt, and answers in their own words. Right after, they hear "You forgot the six-week pilot" and add it. | Caption for each whisper, plus the stage evidence view |
| 1:20–1:42 | **Stranger test.** Street-interview style. Hand a stranger the AirPods and ask the hard question. They freeze, hear the cue, then answer with the right terms or ask a sharp clarifying question. End on their surprised reaction. | Caption: "They've never heard of this topic." Caption each whisper. |
| 1:42–1:56 | **How it works.** Earbud gesture → MacBook hub (room transcript and your documents) → private whisper. | Logos: ElevenLabs, OpenAI, Fiber |
| 1:56–2:00 | Logo and tagline | "Your team, in your ear." |

Production notes:

- Play each whisper with a slightly muffled, in-ear EQ and always caption it. Viewers can't tell it's private otherwise.
- Every scene needs a close-up of the tap.
- Get each stranger's consent to appear on camera, and don't upload their raw recordings or transcripts to GitHub.

## 3-minute live pitch

Presenter A is on stage, Coach B is in the audience, and a third person runs the Mac. The stranger test replaces the planted question as the live Q&A demo. A volunteer judge wears Seat A's AirPods.

| Time | Beat | Telepathy action |
| --- | --- | --- |
| 0:00–0:20 | **Hook.** "What if your teammate could steer your pitch without interrupting it? …They just did." | B sends **Slow down** near 0:15. A visibly slows down. |
| 0:20–0:45 | **Problem.** A teammate who sees a lost judge or a missed point has no way to tell the presenter. | — |
| 0:45–1:05 | **Product.** Two private channels through the earbuds you already wear: your teammate and your agent, both controlled by taps. | A arms Question mode. |
| 1:05–1:45 | **Stranger test, live.** "Can one of you try it?" A hands the volunteer the AirPods and asks the prepared hard question. The volunteer hesitates, hears the cue, and answers or asks the clarifying question. | Question mode cue goes to Seat A's AirPods, now worn by the volunteer. |
| 1:45–2:15 | **How it works.** A takes the AirPods back. ElevenLabs transcribes the room and tells the speakers apart. OpenAI drafts the answer from your documents, and the hub checks its quotes against them. Nothing is saved, and the phones never get the API keys. | B double-taps for **One minute left** once A has the AirPods back. |
| 2:15–2:40 | **Meet / Fiber.** "Before the pitch, it told us who you are." Name a real judge's role only if the feature works. Otherwise, mention the video. | — |
| 2:40–3:00 | **Reveal.** B sends **Wrap it up now**. A: "My teammate sent me three messages during this pitch, and our volunteer got one from the agent." Put the stage on the projector to show every cue and its bit count. | Out signal, then Reveal |

## Safety nets

- If no judge volunteers or the cue doesn't arrive, play the video's 20-second stranger clip and move on.
- Bring alcohol wipes or spare ear tips for the volunteer.
- Keep **Canned take** ready in Operator. It replays the whole flow in about 18 seconds if Bluetooth or the network fails.
- Run `npm run rehearse -- --fast --runs=1` before presenting, then a physical AirPods check from the [rehearsal guide](rehearsal.md).
