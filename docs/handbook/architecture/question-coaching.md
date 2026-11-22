# Question coaching

The Mac streams room audio to ElevenLabs. After a judge asks something, the presenter squeezes AirPods Pro once, double-taps AirPods 1 once, or taps **Cue now**. The hub sends OpenAI the complete room transcript so far, adding any fresh partial text and assigned diarization labels. OpenAI finds the latest substantive question and checks the speech that followed it. It tells the presenter how to answer, what missing point to add, or where to go next, using one or two short instructions. The hub issues one request per accepted gesture.

## Retrieval and citations

The hub combines lexical and code retrieval with cosine search in SQLite. OpenAI gets the full transcript, project overview and numbered excerpts. It selects an excerpt number, and the hub attaches the exact text. If the model response is unusable, the hub extracts a talking point from relevant references for that question.

The room transcript lives in session memory and is cleared on reset. The vector store contains reference passages, not room speech. Neither raw microphone audio nor phone-only conversations are included in this request.

## Playback

After the answer is validated, ElevenLabs synthesizes a whisper. Cue now plays as soon as the phone decodes the whisper. It uses the same Voice volume as teammate messages. Only the requesting seat receives the answer. If playback fails, the written answer stays visible. Cues require another gesture, so the presenter chooses when to hear one.

## Stranger Interview

Select **Stranger Interview** on the Mac Stage and use the same Cue now gesture. The hub sends only the room conversation to OpenAI. The model suggests one open follow-up based on what the other person volunteered. This mode skips document retrieval, vector search, and background research.

The Mac Stage shows the live signal timeline and phone playback acknowledgements. Enable **Mac speakers** to play new cues aloud during the demo. The Stage pauses mic forwarding during playback and resumes when it ends. Individual cues can also be replayed from the timeline.
