# Signal and audio path

## What the demo proves

Telepath lets two people coordinate a live presentation without interrupting it. Seat A presents and seat B coaches. Fixed messages cover routine needs such as “Slow down” and “One minute left.” Question Mode covers a different situation: the presenter needs a concise reminder in their ear while answering a judge. A third person operates the Mac and can send a system announcement to both seats. The project pitches itself, so the judge hears the presenter use the same system the presenter is describing.

A convincing demo shows a real gesture, the resulting private cue, and a human response in the presenter’s own words. The operator’s Reveal view shows recorded message events and reported playback starts. The board’s bit count counts the protocol’s message selections. It is not a measurement of total network traffic or information conveyed by a human voice.

## Hardware inputs and browser media events

The phone uses Safari or Chrome audio playback and the Media Session API. Its headset stays paired to the phone, while the Mac uses its own room microphone. The relevant distinction is the browser action that arrives, not the physical side of the headset. AirPods 1 uses the configured double-tap to emit next-track. A run of one, two or three next-track events maps to a one-, two- or three-event pattern. Calibration accepts two successful doubles and two successful triples. A failed pattern retries in place. The learned inter-event distribution is saved on the phone. AirPods Pro uses its native single, double and triple stem actions, corresponding to play or pause, next-track and previous-track. Its setup verifies the browser sees the commands.

The app uses a playback anchor to hold the media session when the phone isn’t actively playing a cue. Tests model dropped and duplicated media events, gap jitter, and reconnection. Those tests do not establish lock-screen behavior or Bluetooth responsiveness on every phone. The touch controls give the operator and presenter a direct fallback if Safari misses a gesture.

## Private routing and playback acknowledgements

The hub scopes frames by its own instance ID and the current session ID. A seat also has its own connection lifecycle. The hub rejects stale commands and protects the replacement socket when a seat reconnects. It assigns message IDs, deduplicates attempted sends, and scopes audio to the intended receiver. A cached fixed message waits for the active cache manifest to be acknowledged. The phone decodes the clip locally, so the hub can send a small message identifier for a fixed cue. Going from fixed cue to delivery acknowledgement does not require a fresh model or speech request.

Web Audio schedules cues and whispers on the device. A receipt means the browser’s audio engine reached the scheduled playback start. The hub cannot infer that a person physically heard it over Bluetooth. A late acknowledgement, reload, or disconnect should not register playback for a different session or seat. Assistant-directed Question Mode cues are private; an operator announcement is intentionally sent to both seats.

## Why the Mac listens

Safari microphone capture on the phone may place the audio session in a recording configuration that competes with earbud controls. Telepath normally leaves both phones in playback mode. The Mac Stage selects the MacBook microphone and sends 16 kHz mono PCM over the hub connection. Its audio worklet resamples and batches PCM before network delivery. The Stage owns only the current room input. A second Stage tab cannot start another default room stream while a valid owner is active.

ElevenLabs Scribe v3 Live consumes this audio stream and returns evolving partial text, completed text segments and diarization events. Speaker labels are clusters from the stream. They can be assigned manually to the presenter or coach on Stage. Labels are not verified identities and the app does not compare them against voice clones.
