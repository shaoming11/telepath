// Generated from public/index.html. Run python3 scripts/generate-wasp-surfaces.py after edits.
import { PhonePitchControls } from '../PhonePitchControls';
import { CalibrationTrial } from '../CalibrationTrial';

export function PhoneMarkup() {
  return (
    <>
      <audio id="keepalive" src="/assets/keepalive.wav" loop playsInline preload="auto"></audio>

      <div className="app" id="app">
        <header className="masthead">
          <button className="back" id="nav-back" type="button" aria-label="Back" hidden>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M11 4L6 9l5 5" /></svg>
          </button>
          <span className="wordmark">
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l7.5 4.3v6.4L10 17.5l-7.5-4.3V6.8z" /><path d="M2.5 6.8L10 11l7.5-4.2M10 11v6.5" opacity=".55" /></svg>{"\n        Telepathy\n      "}</span>
          <span className="masthead-seat" id="masthead-seat"></span>
          <span className="connection" id="connection" role="status" data-state="off">
            <i className="dot" aria-hidden="true"></i><span id="connection-text">Hub</span>
          </span>
        </header>

        <div className="banner" id="banner" role="alert" hidden>
          <p id="banner-text"></p>
          <button id="banner-action" type="button" hidden></button>
        </div>

        <main className="screens">
          <section className="screen screen-join" id="screen-join" data-screen="join" hidden>
            <div className="join-head">
              <h1 className="display"><span className="display-dim">Two seats.</span>{" Pick yours."}</h1>
              <p className="lede">Setup takes about 90 seconds. Keep this screen awake.</p>
            </div>
            <div className="seat-grid">
              <button className="seat" type="button" data-seat="A"><span className="seat-letter">A</span><span className="seat-role">Presenter</span></button>
              <button className="seat" type="button" data-seat="B"><span className="seat-letter">B</span><span className="seat-role">Coach</span></button>
            </div>
            <fieldset className="segmented">
              <legend>Input</legend>
              <label><input type="radio" name="input_mode" defaultValue="real" /><span>Earbuds</span></label>
              <label><input type="radio" name="input_mode" defaultValue="sim" /><span>Simulated</span></label>
            </fieldset>
            <p className="meta" id="join-status" role="status"></p>
            <p className="meta" id="join-secure" hidden></p>
          </section>

          <section className="screen" id="screen-voice" data-screen="voice" hidden>
            <header className="step-head" data-step="1">
              <div className="step-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
              <h2>Voice</h2><span className="step-index" id="voice-step">1 / 4</span>
            </header>
            <label className="check" id="voice-consent-row">
              <input type="checkbox" id="voice-consent" />
              <span id="voice-consent-text"></span>
            </label>
            <p className="setup-copy">Talk naturally. Pause whenever you need to.</p>
            <details className="setup-details">
              <summary>Script to read</summary>
              <p className="script" id="voice-script"></p>
            </details>
            <div className="voice-meter" id="voice-meter" hidden>
              <p className="meta" id="voice-meter-label"></p>
              <div className="progress" aria-hidden="true"><i id="voice-bar"></i></div>
            </div>
            <div className="voice-transcript" id="voice-transcript" hidden>
              <p className="label">Live transcript</p>
              <p id="voice-transcript-text"></p>
            </div>
            <p className="meta" id="voice-status" role="status"></p>
            <div className="actions">
              <button className="primary" id="voice-record" type="button">Start recording</button>
              <button className="primary" id="voice-finish" type="button" hidden>Use this sample</button>
              <button id="voice-room" type="button">Room sample only</button>
              <button id="voice-cancel" type="button" hidden>Cancel</button>
              <button className="quiet" id="voice-skip" type="button">Use the premade voice</button>
            </div>
          </section>

          <section className="screen" id="screen-earbuds" data-screen="earbuds" hidden>
            <header className="step-head" data-step="2">
              <div className="step-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
              <h2>Earbuds</h2><span className="step-index">2 / 4</span>
            </header>
            <fieldset className="choice">
              <legend>AirPods model</legend>
              <label><input type="radio" name="earbud_mode" defaultValue="next-only" /><span><strong>AirPods 1</strong><small>One, two, or three Next Track events</small></span></label>
              <label><input type="radio" name="earbud_mode" defaultValue="pro" /><span><strong>AirPods Pro</strong><small>Single, double, or triple squeeze</small></span></label>
            </fieldset>
            <div className="stack">
              <button id="test-audio" type="button">Test audio</button>
            </div>
            <p className="meta" id="earbuds-status" role="status"></p>
            <div className="actions">
              <button className="primary" id="earbuds-next" type="button">Continue</button>
            </div>
          </section>

          <section className="screen" id="screen-calibrate" data-screen="calibrate" hidden>
            <header className="step-head" data-step="3">
              <div className="step-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
              <h2>Calibrate</h2><span className="step-index" id="cal-step">3 / 4</span>
            </header>

            <div className="cal-section" id="cal-intro">
              <div className="split" id="cal-seat" hidden>
                <button type="button" data-cal-seat="A">Seat A</button>
                <button type="button" data-cal-seat="B">Seat B</button>
              </div>
              <div className="cal-check" id="cal-quick">
                <div className="cal-check__heading">
                  <h3>Check the controls</h3>
                  <p>Keep both earbuds in and pause other audio.</p>
                </div>
                <label className="field" htmlFor="cal-earbud-model"><span>AirPods model</span>
                  <select id="cal-earbud-model">
                    <option value="next-only">AirPods 1</option>
                    <option value="pro">AirPods Pro</option>
                  </select>
                </label>
                <ol className="cal-check__events" id="cal-quick-controls" aria-label="Detected media commands" hidden>
                  <li id="cal-quick-pause"></li>
                  <li id="cal-quick-nexttrack"></li>
                  <li id="cal-quick-previoustrack"></li>
                </ol>
                <p className="cal-check__status" id="cal-quick-status" role="status"></p>
                <div className="cal-check__actions">
                  <button className="primary" id="cal-quick-continue" type="button" hidden>Continue with defaults</button>
                  <button className="primary" id="cal-quick-start" type="button">Start test sound</button>
                </div>
              </div>
              <details className="setup-details" id="cal-full">
                <summary>Full timing calibration</summary>
                <fieldset className="choice">
                  <legend>Length</legend>
                  <label><input type="radio" name="cal_scope" defaultValue="mode" defaultChecked /><span><strong>This earbud mode</strong><small>About 2 minutes</small></span></label>
                  <label><input type="radio" name="cal_scope" defaultValue="both" /><span><strong>Both modes</strong><small>About 5 minutes</small></span></label>
                </fieldset>
                <label className="check" id="cal-emulate-row">
                  <input type="checkbox" id="cal-emulate" />
                  <span>Let the emulator tap</span>
                </label>
                <p className="meta" id="cal-start-hint" role="status"></p>
                <p className="fineprint" id="cal-measure"></p>
                <div className="actions">
                  <button className="primary" id="cal-start" type="button">Start</button>
                </div>
              </details>
              <button className="quiet" id="cal-skip" type="button">Skip and use defaults</button>
            </div>

            <div className="cal-section cal-run" id="cal-run" hidden>
              <CalibrationTrial />
              <ol className="ticks" id="cal-ticks" aria-label="Trial progress"></ol>
              <div className="cal-footer">
                <button id="cal-stop" type="button">Stop calibration</button>
                <button id="cal-run-skip" type="button" hidden>Skip and use defaults</button>
              </div>
            </div>

            <div className="cal-section" id="cal-result" hidden>
              <div className="cal-result__summary" id="cal-summary">
                <h3 className="cal-verdict" id="cal-verdict"></h3>
                <p className="meta" id="cal-applied" role="status"></p>
              </div>
              <details className="cal-result__details">
                <summary>Timing details</summary>
                <dl className="metrics" id="cal-metrics"></dl>
              </details>
              <div className="cal-footer cal-footer--result">
                <button className="primary" id="cal-done" type="button">Done</button>
                <button id="cal-apply" type="button" hidden>Apply anyway</button>
                <button id="cal-download" type="button">Download JSON</button>
                <button className="quiet" id="cal-again" type="button">Run again</button>
              </div>
            </div>
          </section>

          <section className="screen" id="screen-preset" data-screen="preset" hidden>
            <header className="step-head" data-step="4">
              <div className="step-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
              <h2>Preset</h2><span className="step-index">4 / 4</span>
            </header>
            <div className="preset-list" id="preset-list"></div>
            <label className="field" id="preset-custom-row" hidden>
              <span>Context, one line</span>
              <input id="preset-custom" type="text" maxLength={240} autoComplete="off" enterKeyHint="done" />
            </label>
            <p className="meta" id="preset-status" role="status"></p>
            <div className="actions">
              <button className="primary" id="preset-next" type="button">Ready</button>
            </div>
          </section>

          <section className="screen screen-live" id="screen-live" data-screen="live" hidden>
            <div className="live-head">
              <strong className="live-preset" id="live-preset">Pitch</strong>
              <span className="live-phase" id="live-phase"></span>
            </div>
            <dl className="facts">
              <div><dt>Partner</dt><dd id="live-partner"></dd></div>
              <div><dt>Room</dt><dd className="listen" id="live-listen" data-state="off"><i className="dot" aria-hidden="true"></i><span id="live-listen-text"></span></dd></div>
              <div><dt>Messages</dt><dd id="live-cache"></dd></div>
            </dl>

            <PhonePitchControls />
            <section className="channel-monitor channel-monitor--phone" id="phone-monitor" aria-label="Live audio and context"></section>

            <div className="lock-controls" id="lock-controls" hidden>
              <button id="lock-controls-toggle" type="button" aria-pressed="false">Enable lock-screen controls</button>
              <p className="meta" id="lock-controls-status" role="status"></p>
            </div>

            <div className="draft" id="live-draft" hidden>
              <div className="draft-top">
                <span className="label" id="live-draft-label">Send this?</span>
              </div>
              <div className="draft-clock" aria-hidden="true"><i id="live-draft-clock"></i></div>
              <p id="live-draft-text"></p>
              <div className="split">
                <button className="primary" id="draft-send" type="button">Send</button>
                <button id="draft-discard" type="button">Discard</button>
              </div>
            </div>

            <div className="messages">
              <article className="message" id="live-in">
                <header><span className="label">In</span><time id="live-in-time"></time></header>
                <p id="live-in-text"></p>
              </article>
              <article className="message" id="live-out">
                <header><span className="label">Out</span><time id="live-out-time"></time></header>
                <p id="live-out-text"></p>
              </article>
            </div>

            <p className="live-note" id="live-note" role="status"></p>

            <div className="signals" id="signals" role="group" aria-label="Send a signal"></div>

            <form className="room-input" id="sim-room" hidden>
              <label htmlFor="sim-text">Room</label>
              <input id="sim-text" type="text" maxLength={240} autoComplete="off" enterKeyHint="send" placeholder="Type what the room hears" />
              <button type="submit">Say</button>
            </form>

            <nav className="live-nav" aria-label="Seat screens">
              <button type="button" data-go="codebook"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 4.5h12M3 9h12M3 13.5h8" /></svg>Codebook</button>
              <button type="button" data-go="log"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.5" /><path d="M9 5.5V9l2.5 1.5" /></svg>Log</button>
              <button type="button" data-go="settings"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7" /><circle cx="11.5" cy="5" r="1.5" /><circle cx="6.5" cy="13" r="1.5" /></svg>Settings</button>
            </nav>
          </section>

          <section className="screen" id="screen-codebook" data-screen="codebook" hidden>
            <header className="step-head"><h2>Codebook</h2><span className="step-index" id="codebook-context"></span></header>
            <ol className="codebook" id="codebook-list"></ol>
          </section>

          <section className="screen" id="screen-log" data-screen="log" hidden>
            <header className="step-head"><h2>Log</h2><span className="step-index" id="log-count"></span></header>
            <ol className="log" id="log-list"></ol>
            <p className="meta" id="log-empty">Nothing sent yet.</p>
          </section>

          <section className="screen" id="screen-settings" data-screen="settings" hidden>
            <header className="step-head"><h2>Settings</h2><span className="step-index" id="settings-context"></span></header>

            <fieldset className="segmented">
              <legend>Earbuds</legend>
              <label><input type="radio" name="settings_mode" defaultValue="next-only" /><span>AirPods 1</span></label>
              <label><input type="radio" name="settings_mode" defaultValue="pro" /><span>AirPods Pro</span></label>
            </fieldset>

            <div className="toggles">
              <label className="row-toggle"><span>AI drafts</span><input type="checkbox" id="settings-drafts" /></label>
              <label className="row-toggle" id="settings-listen-row"><span>Listen with the phone mic</span><input type="checkbox" id="settings-listen" /></label>
            </div>

            <div className="ranges">
              <label className="range"><span>Sounds</span><input type="range" id="settings-volume-cue" min="0" max="1" step="0.05" /><output id="settings-volume-cue-value"></output></label>
              <label className="range"><span>Voices</span><input type="range" id="settings-volume-voice" min="0" max="1" step="0.05" /><output id="settings-volume-voice-value"></output></label>
            </div>

            <div className="split">
              <button id="settings-voice" type="button">Re-record voice</button>
              <button id="settings-voice-preview" type="button">Hear my clone</button>
            </div>
            <div className="split">
              <button id="settings-calibrate" type="button">Re-calibrate</button>
              <button id="settings-room-invite" type="button" hidden>Share room mic link</button>
            </div>
            <label className="field"><input id="settings-room-link" aria-label="Room mic invite link" readOnly hidden /></label>
            <p className="meta" id="settings-room-status" role="status"></p>

            <p className="meta" id="settings-profile" role="status"></p>
            <div id="settings-groups"></div>
            <dl className="metrics" id="settings-network"></dl>
          </section>
        </main>
      </div>

      <noscript><p className="meta">Telepathy needs JavaScript.</p></noscript>
    </>
  );
}
