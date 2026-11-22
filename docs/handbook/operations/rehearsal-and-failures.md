# Rehearsal and failure handling

## Practical rehearsal order

Start the hub on the Mac. The printed local Stage URL runs on the Mac, and the HTTPS link is the one the phones use. The phones and Mac must share the hotspot. Each phone connects its own earbuds. Have one person join A and another join B. Choose the premade voice when you want to skip a recording. Test the headset, complete calibration, and press Ready. Start the Mac microphone on Stage. Begin session becomes available when both seats complete setup and acknowledge their audio cache. The microphone can already be listening while the stage is in the lobby.

Use a third teammate as the judge. Confirm the room transcript shows turns as people speak. Assign known speaker clusters to seats if useful. Arm Question Mode and have the judge ask about how you built the app, why it uses one Mac mic, or what OpenAI receives. The printed private cue appears on the requesting phone. After the cue, the presenter says the answer aloud in their own words. Leave the phone screen available for longer supporting notes, which are useful if you miss part of the whispered prompt.

## Symptoms and first recovery

- **Begin is grey.** Check each seat’s network status, voice, earbud test, calibration and Ready state, and whether its cache has loaded. Reset or hub restart can require both seats to reconnect.
- **No transcript.** Select the MacBook microphone, approve Safari microphone access and confirm the input level moves. If Safari denied permission, check browser and macOS microphone settings. Input activity alone does not prove the transcription provider has connected.
- **Gestures disappear.** Confirm each pair is connected to its own phone, the phone is playing the Telepathy anchor, and Safari is in front for initial testing. Start with the touch controls to separate transport problems from media-session problems.
- **Cue overlaps the presenter.** The private voice has softer playback gain. The hub holds or cuts its own cue when it detects overlapping room speech and tries to review the resulting answer. An unrelated speaker can also interrupt it. Correct speaker assignment helps.
- **Model output is generic or unavailable.** Verify the latest question in the transcript. Check the cited evidence and whether it describes a concrete mechanism. Fixed cues stay available during model failures, and a cached canned take can demonstrate the complete pitch flow.

## Verification in the repo

Use the repository suite and a loopback rehearsal. The suite covers inputs, scope tags, runtime privacy, source quote validation, and the audio dispatch state machine. A fast rehearsal runs the two emulated phone seats and canned fallback. Fault rehearsals inject lost messages and reconnects. Neither emulation nor a cloud request from the Mac proves the physical microphone, AirPods, hotspot, mic timing and Bluetooth audio path end to end. A physical rehearsal provides that evidence.
