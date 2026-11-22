# Autonomous research and quiet coaching

Telepath researches people, companies and relevant topics from completed speech without a manual lookup screen. It decides what to investigate, reviews findings for usefulness, and retains bounded evidence in session memory for future answers and missing-point cues. A completed lookup never triggers a whisper by itself.

## Configuration

Put `OPENAI_API_KEY` and `FIBER_API_KEY` in the ignored `.env.local` read by `./start`. `TELEPATHY_RESEARCH=off` disables research. `TELEPATHY_RESEARCH_MODEL` optionally overrides the research model (otherwise the configured OpenAI text model, then `gpt-4.1-mini`). Keys stay on the hub. Without Fiber, topic research remains available through OpenAI; person/company tools are omitted.

## Tools and memory

- `research_person`: Fiber `/v1/kitchen-sink/person`, using an explicitly introduced full name and current employer. Exact matching, forced employer matching, two candidates, no contact reveal or live fetch.
- `research_company`: Fiber `/v1/kitchen-sink/company`, using a company named in speech. Matches the supplied name against provider names/aliases, retaining only a single exact match among up to two candidates. Multiple exact matches stay unresolved.
- `research_topic`: OpenAI Responses `web_search` for a contiguous topic phrase from speech plus the research goal. Requires a completed search and URL citations. This is web research, not Fiber database data.

Telepath checks the findings against recent speech and retained context before keeping them. It discards irrelevant, duplicated, ambiguous, uncited or unhelpful findings. It retains the original bounded professional fields or cited summary, not a rewritten usefulness assessment. References identify their provider, source URLs and retrieval time. External findings never establish our product capabilities, the wearer's experience, a speaker's identity or personal preferences.

At most 12 research documents are retained. Both the pitch/interview retrieval path and document-answer/missing-point path can use them, including without uploaded documents. Future relevant conversation retrieves the evidence; context need not be relevant at every turn. Research survives within the session only and clears on reset. Profiles and research contents are absent from phone snapshots. Operator state includes research status, counts and Fiber's returned `chargeInfo`.

Research runs outside cue deadlines, one task at a time, with a 60-second deadline, at least 15 seconds between decisions, 24 decisions and eight lookups per session, and target deduplication. Speech arriving during a lookup is coalesced for a later decision. Reset, Reveal and close cancel active work; late results cannot enter a new session. Provider errors fail quietly and leave ordinary coaching available. Budgets are application caps, not provider billing guarantees: live Fiber lookups and OpenAI model/search calls incur their normal costs.

Recent speech and compact reference context go to OpenAI for tool selection and usefulness review. Fiber receives lookup identifiers only. Topic search receives a topic and research goal, not the full transcript. Credentials, raw provider payloads, transcripts and results are not written to disk by this integration.

## When Telepath speaks

Automatic whispers require at least 2.5 seconds of quiet, no partial speech, no pending approval/receipt or announcement, and no estimated spoken-audio playback in either seat. The session allows at most one unsolicited cue every 30 seconds and suppresses repeated normalized cue text. Gates are rechecked after synthesis; speech resuming or a changed question discards obsolete audio.

The OpenAI value review defaults to silence. It must identify a consequential correction, genuinely unresolved important question or one material omission, with an exact evidence quote, an exact conversation quote and substantive overlap with the proposed cue. It rejects trivia and unsupported details. Provider failure or uncertainty suppresses the unsolicited cue. Automatic grounded coaching no longer speaks generic fallback lines when evidence/providers are unavailable. Background verification updates the displayed cue instead of speaking a second unsolicited correction. Explicit help requests and approved teammate messages keep their existing controls.

These checks reduce interruptions; model judgments and transcription latency still require physical rehearsal. Playback overlap uses a conservative duration estimate, not a hardware playback-complete signal.

## Verification

Automated tests cover tool contracts, aliases/ambiguity, uncited and low-value rejection, deduplication, retrieval in pitch/interview context, reset isolation, evidence validation and playback/pause/cooldown gates. Live validation used synthetic public-company/topic questions; Fiber company lookup and cited OpenAI topic research both produced retained references. The live value review rejected a logo-color aside and accepted an evidence-backed jitter-buffer correction. No live room recording or physical earbud test was performed.

Contracts: [Fiber person lookup](https://api.fiber.ai/ai-docs/KitchenSinkProfile.md), [Fiber company lookup](https://api.fiber.ai/ai-docs/kitchenSinkCompany.md), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).
