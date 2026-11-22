# Hardware rehearsal

## Five minutes with one pair of AirPods

This calibrates browser event timing on your actual hardware. You can use the Mac with its connected AirPods, or the iPhone after enabling local HTTPS. A second phone is optional.

| Time | Action | Evidence |
|---|---|---|
| 0:00–0:45 | In the AirPods Bluetooth settings, set Right Double-Tap to **Next Track** and Left Double-Tap to **Previous Track**. Keep Automatic Ear Detection on. Put both earbuds in. | The two tap settings are different. Play and pause are reserved for removal and reinsertion. |
| 0:45–1:15 | Start Telepathy and open the stage’s calibration link, or open the phone seat’s **Settings → Calibrate real earbuds**. Choose two earbuds and press the audio/Media Session start control. | The page reports the handlers it can register. Test both outputs and choose a low, audible volume. |
| 1:15–3:45 | Follow the timed prompts. Each gesture gets three trials. Do an actual right or left double-tap where prompted, and physically remove and reinsert an earbud for the pause and play prompts. Do the one-earbud fast, slow and triple prompts if offered. | The page records received Media Session actions with their timestamps. A missing callback remains visible as a missed trial. |
| 3:45–4:30 | Apply the profile and optionally download the timing JSON. Open the two rehearsal seats to check the new profile. | The session broadcasts fitted fast, slow and mixed intervals, spread, and missed or doubled ratios to both emulators. |
| 4:30–5:00 | On iPhone, leave the recorder running. Raise a quiet test whisper and try a tap, an earbud removal, and a reinsertion. | Confirm whisper routing and the listening indicator. If headset events disappear, use the Live touch controls. If mic permission or transport fails, the stage can still run fixed cues. |

Prompt-to-callback time includes your reaction. Calibration uses the spacing between callbacks to fit timing and jitter. A browser alone cannot isolate Bluetooth transport delay. A lost tap in a multi-event pattern can resemble a different valid pattern. If that happens during rehearsal, use the single-signal touch button for that moment.

## Ten minutes with two phones and two pairs

Start the hub and trust its certificate before the stopwatch. Keep the MacBook lid open for the whole rehearsal and pitch. The launcher prevents idle sleep while the hub runs. Use the printed HTTPS join link. The printed HTTP trust link downloads the CA file for this Mac’s hub.

- **iPhone.** Install the downloaded certificate profile. Then go to **Settings → General → About → Certificate Trust Settings** and enable trust for **Telepathy Local Demo**. [Apple’s certificate trust guide](https://support.apple.com/en-ca/102390)
- **Android Chrome.** Install the downloaded file as a user CA through your phone’s **Encryption & credentials** settings, then reopen the HTTPS join page. The labels vary by phone. [Chrome local certificate verification](https://blog.chromium.org/2022/09/announcing-launch-of-chrome-root-program.html)
- **AirPods 1 or 2.** Configure left and right while the pair is connected to an Apple device. During the pitch remove **one** earbud for the Out check. Removing both can stop playback without a matching resume event. [Apple’s AirPods controls](https://support.apple.com/en-ie/108764)

| Time | Action | Pass condition |
|---|---|---|
| 0:00–1:30 | Put the Mac and both phones on the same private hotspot. Open the stage on the Mac and the printed HTTPS join address in iPhone Safari and Android Chrome. Confirm the phones already trust the Mac’s certificate. If the printed address does not reach the hotspot, set `TELEPATHY_HOST` to the Mac’s address on that hotspot and restart. | Both seats show connected. Each phone sees HTTPS and can request its microphone. |
| 1:30–3:30 | Pick Seat A on the presenter’s phone and Seat B on the coach’s. Read each 30-second setup script. Set taps to Next/Previous, set Automatic Ear Detection, and run left/right sound checks and quick calibration. Keep both browsers open and screens awake. | Both voice statuses show the expected person or a clearly labeled fallback. Both seats report Ready. Each phone hears its test audio in the correct earbuds. |
| 3:30–4:30 | With both microphones active, have each person say a different test sentence. Tap both buds, then remove and reinsert one. | Stage shows two independent transcripts. Tap capture and audio routing still work with each mic open. If a browser loses callbacks, establish that seat’s touch fallback before rehearsing. |
| 4:30–8:30 | Start Pitch. Run a short steered pitch. B sends **Slow down**, A responds R1 for a receipt, B sends **One minute left**, an assistant draft is previewed only to the sender, R1 confirms it, then an Out sends **Wrap it up now**. Open Reveal. | The short pitch passes. Each receipt matches its message. There is no partner playback before confirmation. Both transcripts and the bits timeline appear. Use stage latency after **preview playback** to verify the under-two-second target. |
| 8:30–10:00 | First send **Sound check** in Operator while both seats are online. Then play **Canned take** with both phones offline and check the MacBook output. | Both individual playback acknowledgements are visible from the sound check. The canned sequence includes a draft approval and reaches Reveal. |

After the ten-minute check, run the full pitch to Reveal five consecutive times. For these five takes, preconfigure both presenter fallback IDs so that a reset does not require two new clone uploads. To preserve a strict five-run result, record any fallback or failure and restart the streak after the issue is resolved. If the setup or pitch is longer, keep the same five-run bar and record the elapsed rehearsal time.

Use the [pitch cue sheet](pitch.md) for the exact presenter, coach and MacBook operator beats.
