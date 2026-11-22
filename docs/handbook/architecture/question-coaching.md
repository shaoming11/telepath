# Question coaching

The Mac streams room audio to ElevenLabs. After a judge asks something, the presenter squeezes AirPods Pro once, double-taps AirPods 1 once, or taps **Cue now**. The hub sends OpenAI the complete room transcript so far, adding any fresh partial text. It uses assigned diarization labels when available. OpenAI chooses the latest genuine question from that conversation and writes an answer backed by the supplied evidence, or suggests what to say next when it cannot verify an answer. The hub issues one request per accepted gesture.

## Retrieval and citations

The hub combines its lexical and exact-code index with cosine search in an in-memory SQLite vector store. The store holds hashed token vectors for current project passages, uploads and retained research. The vector scorer can surface passages beyond those in the lexical shortlist. A recent question-shaped turn helps focus retrieval. OpenAI still chooses the question from the complete transcript. The hub sends the project overview and selected excerpts, and checks the model citation against the passage ID and exact wording.

The room transcript lives in session memory and is cleared on reset. The vector store contains reference passages, not room speech. Neither raw microphone audio nor phone-only conversations are included in this request.

## Playback

After the answer is validated, ElevenLabs synthesizes a whisper. The phone plays the cached chime before the cue, using the same Voice volume as teammate messages. Only the requesting seat receives the answer. If playback fails, the written answer stays visible. Cues require another gesture, so the presenter chooses when to hear one.
