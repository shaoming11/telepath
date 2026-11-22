# Telepath on Maritime

The MacBook remains the hub. It runs the session and holds the uploaded references and shared room transcript in memory. ElevenLabs transcribes the Mac microphone and labels speaker clusters. The hub sends recent speaker-labelled turns and relevant excerpts to the Maritime planner when hosted mode is enabled. The planner chooses whether to answer a question, add a missed point, or suggest the next pitch beat. OpenAI on the hub uses that plan and the supporting passages to write a brief speaking cue. ElevenLabs speaks it only to the seat that asked.

Maritime can prepare a plan for the presenter after a completed room turn. The hub coalesces transcript and speaker updates, limits hosted requests to one start every three seconds, and reuses a plan only for matching turns and excerpts. The squeeze waits up to 120 ms for a still-running plan, then uses the local policy. A previous question's plan is never used for a changed question. Clearing the transcript, stopping the room microphone, changing the pitch, resetting, or revealing clears the planner.

A short cached chime announces the private whisper. Stage records which planner ran, OpenAI and ElevenLabs turnaround in the hub, and elapsed time from receipt of the gesture to the phone’s reported speech start. The last measurement includes phone audio decoding and scheduling. Bluetooth latency and the AirPods 1 recognition window are outside it.

## Parallel private cues

Set `TELEPATHY_MARITIME_CUE_RACE=on` alongside `TELEPATHY_MARITIME=on` to start an independent Maritime draft when the seat requests a cue. OpenAI can prepare its draft while the question is still being spoken. The hub plays the first usable cue to the requesting seat. The other provider reviews the cue with the same conversation and source excerpts after its own draft finishes. Verification appears next to the private cue. A material correction must cite a supplied passage. It can play a follow-up whisper while the conversation and request are still current.

The hub allows up to six seconds for the initial race and up to fifteen seconds for background review. ElevenLabs renders the whisper on the Mac hub. Browser playback has an eight-second start window to allow for decoding, waking audio, and earlier queued messages. If speech is unavailable, the phone keeps the cue readable and shows the audio status.

## Platform choices

The direct agent chat endpoint returns a completed reply. Its documented 30-second completion budget leaves room for agent work, while the earbud needs a much shorter deadline. The hub prepares plans ahead of the gesture and applies its own deadline. Webhooks acknowledge that they accepted work before the agent finishes, which makes them a poor fit for returning a private cue. [Direct chat and webhooks](https://maritime.sh/docs/api) · [Runtime limits](https://maritime.sh/docs/limits)

One private agent serves the demo. Both seats connect to the same Mac session over the hotspot. The hub owns agent access, and the phones receive only their seat's playback events. [Agent and end-user model](https://maritime.sh/docs/sdk/end-users)

## Verify without hosted services

```sh
node --test tests/maritime.test.mjs tests/maritime-agent.test.mjs tests/session.test.mjs
mkdir -p .runtime
node scripts/maritime-deploy.mjs --package .runtime/telepathy-maritime.zip
```

The tests use local HTTP and provider stubs. The packaging command writes only the agent's Dockerfile and two JavaScript modules. It does not need credentials or open a network connection. Use a fresh ZIP filename on subsequent runs.

To exercise the agent directly, run `PORT=18789 node maritime/server.mjs` without provider credentials in its environment. It binds the port supplied by the host. `GET /health` is a side-effect-free check. `POST /chat` accepts the Maritime message envelope and returns the plan as JSON in its response string. The server uses the deterministic policy when model credentials are absent. The production container includes CA certificates for HTTPS and does not persist transcripts or documents to its volume. [Custom agent contract](https://maritime.sh/docs/frameworks/custom)

## Enable hosted planning after approval

1. Upload the ZIP as a **private custom agent**, or update the existing Telepath agent. Keep public web access disabled. The API deployment script creates a custom ZIP agent with `useMaritimeLlm: true`. For an existing agent created without Maritime LLM, enable it in the agent's environment settings and restart it. The agent uses the injected OpenAI-compatible base URL and its metered agent token. If you supply a direct OpenAI key to the agent, set a direct OpenAI base URL or remove the Maritime proxy base URL. [Maritime LLM setup](https://maritime.sh/docs/llm)
2. Wait for the source deployment to finish and the agent to become healthy. Put the agent ID and a server-side Maritime bearer key in the Mac hub's ignored `.env.maritime.local`. A key with the `deploy` scope can chat with an existing agent. Keep provisioning credentials separate. [Deployment API](https://maritime.sh/docs/api) · [Key scopes](https://maritime.sh/docs/sdk/authentication)
3. Start the hub with `TELEPATHY_MARITIME=on TELEPATHY_MARITIME_PITCH_HELP=on ./start`. The first switch allows hosted operator coaching. The second also enables preparation and hosted planning for live Pitch help. Leave either unset for the corresponding local behavior. The phone receives no keys.
4. Rehearse a synthetic question before sharing a real room transcript with the hosted agent. Confirm that the Stage answer evidence names the actual planner and cites the brief. Test both an awake and a sleeping agent. Maritime wakes a sleeping agent on chat, so the first plan may take longer. [Sleep and wake](https://maritime.sh/docs/how-it-works)

The cloud request sends short speech excerpts and retrieved passages as turn input. Raw mic audio goes to ElevenLabs and the full reference collection stays on the Mac. The hub does not request hosted conversation memory. Each planner request carries fresh context. Remote errors use the local policy without retrying the same turn. A capacity response pauses new Maritime requests for its advertised retry window. [Maritime limits and errors](https://maritime.sh/docs/limits)
