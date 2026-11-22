# Testing the in-ear coach

How to run the three coaching scenarios on your own Mac: Pitch Q&A, Interview, and Date or small talk.

## Setup

1. Install Node.js 22.13 or later.
2. Create these files in the project folder. They are ignored by Git, so get the values from the team privately, never through GitHub or chat:
   - `.env.local` with `ELEVENLABS_API_KEY=...`
   - `.env.openai.local` with `OPENAI_API_KEY=...`
   - `.env.maritime.local` with `MARITIME_API_KEY=...` and `TELEPATHY_MARITIME_AGENT_ID=...`
3. Run `chmod 600 .env*.local`.
4. Start the hub with Maritime planning on:

   ```bash
   TELEPATHY_MARITIME=on TELEPATHY_MARITIME_PITCH_HELP=on ./start
   ```

   Without the two flags, cues still work and are planned locally on the Mac.

## Run a test

Connect AirPods to the Mac, and set the Mac's sound input to **MacBook Microphone**.

1. **Stage:** open http://127.0.0.1:5780/stage. Pick the **Coaching scenario**, upload any files under **Team brief & references**, and click **Start Mac microphone**.
2. **Seat A (the wearer):** open http://127.0.0.1:5780/ in a second tab. Pick **A** with **Earbuds**, then choose **Use the premade voice** → **Continue** → **Skip and use defaults** → **Ready**.
3. **Seat B:** open a third tab. Pick **Simulated**, then **B**, and go through the same steps.
4. Click **Begin session** on the stage, then press **Cue now** on Seat A when you want a private answer.
5. To switch scenarios, click **Reset** on the stage, pick the new one, and upload again.

## The three scenarios

| Scenario | Upload | What the other person does |
| --- | --- | --- |
| Pitch Q&A | Optional: [the pitch outline](../pitch-and-video-outline.md) | Plays a judge using [judge-practice-questions.md](../judge-practice-questions.md) |
| Interview | [persona-bio.md](persona-bio.md) and [persona-interview-stories.md](persona-interview-stories.md) | Plays the interviewer using [interviewer-script.md](interviewer-script.md) |
| Date or small talk | Nothing | Plays someone you just met. They chat or ask "So what do you do for fun?" while the wearer acts shy |

The stage lists each cue in the answer panel with its planner: **Maritime plan** when the Maritime agent planned it, **Local plan** when the Mac did. Date cues are also marked **not from your files**.
