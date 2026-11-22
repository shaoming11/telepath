# Hardware rehearsal

## Set up earbud controls

- **AirPods 1:** In Bluetooth settings, assign double-tap on one earbud to **Next Track**. Choose **AirPods 1 → Calibrate timing** in Telepathy. When the screen says **Now**, send two Next Track events for each of the first three trials and three for each of the last three. Use your normal cadence. Telepathy measures the gaps and saves the resulting timing window on this phone.
- **AirPods Pro:** Select **AirPods Pro** and optionally use **Test squeezes**. Squeeze either stem once, twice, or three times. Safari reports Play/Pause, Next Track, or Previous Track respectively. The app uses the command immediately, so there is no timing calibration. Keep the earbuds in during the test so automatic ear detection does not send Play or Pause.
- During the demo, use the on-screen controls for the codebook, assistant, Out, and Back. Use those controls for fixed messages too if Safari does not receive earbud commands.

## Ten minutes with two phones and two pairs

Start the hub and trust its certificate before the stopwatch. Keep the MacBook lid open for the whole rehearsal and pitch. The launcher prevents idle sleep while the hub runs. Use the printed HTTPS join link. The printed HTTP trust link downloads the CA file for this Mac’s hub.

Connect one AirPods pair directly to each phone. Use **Test audio** on each phone to confirm which pair it drives. Keep the Mac on the same network to run Stage. If the phones are on the same venue Wi-Fi and cannot load the HTTP trust link, try a private hotspot and use the new HTTPS address printed by `./start`.

- **iPhone.** Install the downloaded certificate profile. Then go to **Settings → General → About → Certificate Trust Settings** and enable trust for **Telepathy Local Demo**. [Apple’s certificate trust guide](https://support.apple.com/en-ca/102390)
- **Android Chrome.** Install the downloaded file as a user CA through your phone’s **Encryption & credentials** settings, then reopen the HTTPS join page. The labels vary by phone. [Chrome local certificate verification](https://blog.chromium.org/2022/09/announcing-launch-of-chrome-root-program.html)
- [Apple’s AirPods controls](https://support.apple.com/en-ie/108764)

| Time | Action | Pass condition |
|---|---|---|
| 0:00–1:30 | Put the Mac and both phones on the same private hotspot. Open Stage on the Mac and the printed HTTPS join address in Safari on each iPhone. Use Chrome if one seat runs Android. Confirm the phones already trust the Mac’s certificate. If the printed address does not reach the hotspot, set `TELEPATHY_HOST` to the Mac’s address on that hotspot and restart. | Both seats show connected. Each phone sees HTTPS and can request its microphone. |
| 1:30–3:30 | Pick Seat A on the presenter’s phone and Seat B on the coach’s. Speak naturally into the recorder until the sample is ready. Select each AirPods model and run its controls check or timing calibration. Keep both browsers open and screens awake. | Both voice statuses show the expected person or a clearly labeled fallback. Both seats report Ready. Each phone hears its test audio in the correct earbuds. |
| 3:30–4:30 | With both microphones active, have each person say a different test sentence. Send one Single, Double, and Triple from each phone. | Stage shows two independent transcripts. Tap capture and audio routing still work with each mic open. If a browser loses callbacks, establish that seat’s touch fallback before rehearsing. |
| 4:30–8:30 | Start Pitch. Run a short steered pitch. B sends **Slow down**, A uses Single for a receipt, B sends **One minute left**, an assistant draft is previewed only to the sender, Single confirms it, then the Out button sends **Wrap it up now**. | Each receipt matches its message. There is no partner playback before confirmation. Use the stage’s **preview playback** latency to verify the under-two-second target. |
| 8:30–10:00 | Ask the Pitch coach for a Closing cue and send it to both seats. Open Reveal after both hear it. Then play **Canned take** with both phones offline and check the MacBook output. | Operator shows both playback acknowledgements. Both transcripts and the bits timeline appear in Reveal. The canned sequence includes a draft approval and reaches Reveal. |

After the ten-minute check, run the full pitch to Reveal five consecutive times. For these five takes, preconfigure both presenter fallback IDs so that a reset does not require two new clone uploads. To preserve a strict five-run result, record any fallback or failure and restart the streak after the issue is resolved. If the setup or pitch is longer, keep the same five-run bar and record the elapsed rehearsal time.

Use the [pitch cue sheet](pitch.md) for the exact presenter, coach and MacBook operator beats.
