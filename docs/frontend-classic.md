# Telepath classic browser client

## Active frontend stack

The frontend uses HTML, CSS, and JavaScript modules on the phone and Mac Stage. The Node hub serves both.

The phone uses Media Session for earbud actions and Web Audio for playback. The Stage uses Web Audio and a PCM worklet for microphone capture. Each surface keeps a WebSocket open to the hub. The standard `./start` launcher serves this frontend.
