# Autonomous Fiber research

Set FIBER_API_KEY and OPENAI_API_KEY in the ignored .env.local file. TELEPATHY_RESEARCH=off disables research. No manual lookup screen is required.

Telepath uses a separate OpenAI tool-selection request on completed speech to decide whether to research an explicitly introduced interviewer or judge. research_person accepts a full name and current employer copied from the conversation. Fiber receives those identifiers only. The documented /v1/kitchen-sink/person operation uses exact name matching, forceCompanyMatch, two maximum results and no liveFetch. Ambiguous or mismatched identities are discarded.

Professional background becomes in-memory session references for relevant future pitch/interview answers and document-based missing-point cues. It never triggers a whisper by itself. Reset cancels pending research and clears results. Nothing is persisted. Research runs outside the cue deadline, with a 60-second timeout, 15-second decision interval, one task at a time, eight decisions per session, and target deduplication. Provider failures leave coaching running. Live lookups consume Fiber credits. No contact reveal is performed.

This first integration researches explicitly named people, not unnamed panels or arbitrary web topics. Introductions during an active lookup may need to remain in recent speech on a subsequent completed turn. Live provider and physical-earbud checks require configured credentials and hardware.

API: https://api.fiber.ai/ai-docs/KitchenSinkProfile.md
