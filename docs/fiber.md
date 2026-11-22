# Autonomous research and quiet coaching

Set `FIBER_API_KEY` in the ignored `.env.fiber.local` and `OPENAI_API_KEY` in `.env.openai.local`. Set `TELEPATHY_RESEARCH=off` to disable research. Local text and fixed-message modes also disable it. `TELEPATHY_RESEARCH_MODEL` overrides the OpenAI research model.

## Data flow

Only committed Mac room speech during a live pitch or interview triggers research. OpenAI examines recent room turns and compact reference excerpts to decide whether external facts could help. There are three tools.

- **Person.** Fiber Kitchen Sink receives the spoken full name and employer. Telepath requires a single exact identity with a matching current position, including concurrent jobs. It ignores former employers.
- **Company.** Fiber Kitchen Sink receives a company name spoken in the room. Telepath accepts one exact result by organization name or alias.
- **Topic.** OpenAI web search receives a topic phrase and research goal. Results require a completed search and citations. Topic research can run without a Fiber key.

A separate OpenAI review keeps only findings likely to help future coaching. Up to 12 results are held in session memory and retrieved for relevant cues alongside project and uploaded documents. Stage shows the source labels. Reset clears the findings. Fiber never receives raw transcripts or a contact reveal request.

Research runs off the whisper path, with one task at a time, 15 seconds between decisions, up to 24 decisions and eight lookups per session, and a 60-second task deadline. Results do not trigger whispers on their own. Reset, Reveal and close invalidate pending work.

## When coaching speaks

A double gesture or **Cue now** sends one OpenAI request with the full room transcript and retrieved evidence. Research stays in the background and cannot trigger a private answer. Separately, automatic teammate draft previews retain their quiet-period and approval rules.

API contracts: [Fiber person lookup](https://api.fiber.ai/ai-docs/KitchenSinkProfile.md), [Fiber company lookup](https://api.fiber.ai/ai-docs/kitchenSinkCompany.md), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).
