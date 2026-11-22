// Generated from public/stage.html. Run python3 scripts/generate-wasp-surfaces.py after edits.
import { StageRoomConsole } from '../StageRoomConsole';
import { StageRevealHeader } from '../StageRevealHeader';
import { StageAnnouncement } from '../StageAnnouncement';
import { AppearanceControl } from '../AppearanceControl';
import { StagePair } from '../StagePair';
import { ChannelMonitor } from '../ChannelMonitor';

export function StageMarkup() {
  return (
    <>
      <a className="skip-link" href="#stage-main">Skip to stage content</a>

      <div className="frame">
        <header className="nav">
          <span className="brand">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l7.5 4.3v6.4L10 17.5l-7.5-4.3V6.8z" /><path d="M2.5 6.8L10 11l7.5-4.2M10 11v6.5" opacity=".55" /></svg>{"\n      Telepathy\n    "}</span>

          <nav className="phases" aria-label="Stage phase">
            <ol>
              <li data-phase-step="lobby">Lobby</li>
              <li data-phase-step="live">Live board</li>
              <li data-phase-step="reveal">Reveal</li>
            </ol>
          </nav>

          <div className="nav__meta">
            <span className="nav__link" id="link-readout">Connecting</span>
            <span id="session-readout">Session</span>
            <span id="preset-readout">Preset</span>
            <span className="nav__clock" id="clock-readout" hidden>00:00</span>
            <button className="op-toggle" id="op-toggle" type="button" aria-expanded="false" aria-controls="operator" title="Operator controls (keyboard O)">{"Operator "}<kbd>O</kbd></button>
          </div>
        </header>

        <p className="canned-banner" id="canned-banner" hidden>
          <span className="canned-banner__tag">CANNED TAKE</span>
          <span id="canned-detail">Playing the recorded demo take.</span>
        </p>

        <main id="stage-main">

          <StageRoomConsole />


          <section className="screen screen--lobby" id="screen-lobby" aria-labelledby="lobby-title" hidden>
            <div className="hero">
              <div className="hero__copy">
                <h1 className="display" id="lobby-title"><span className="display__dim">Two seats.</span>{" One silent channel."}</h1>
                <p className="lede">Tap an earbud to cue your teammate. The Mac listens to the room so Question Mode can whisper a private prompt.</p>
                <div className="cta">
                  <button className="begin" id="begin-button" type="button" disabled>
                    <span className="begin__label">Begin session</span>
                    <span className="begin__arrow" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4" /></svg></span>
                  </button>
                </div>
                <p className="begin-hint" id="begin-hint">both seats ready</p>
                <a className="join__link" href="#reference-setup">{"Add team brief & references ↓"}</a>
                <dl className="readout-row" id="lobby-readout">
                  <div><dt id="readout-a-name">PRESENTER</dt><dd id="readout-a">Waiting</dd></div>
                  <div><dt id="readout-b-name">COACH</dt><dd id="readout-b">Waiting</dd></div>
                  <div><dt>PRESET</dt><dd id="readout-preset">—</dd></div>
                  <div><dt>MESSAGES</dt><dd id="readout-cache">—</dd></div>
                </dl>
              </div>

              <p className="sr-only" id="lobby-room-notice" role="status"></p>
              <svg className="diagram" id="lobby-diagram" viewBox="-560 -250 1120 700" role="img" aria-labelledby="diagram-label">
                <title id="diagram-label">Seat A and Seat B linked through the hub</title>
                <defs>
                  <path id="prof" d="M0 0 L3 -34 C-6 -46 -16 -66 -16 -92 C-16 -132 14 -160 56 -160 C90 -160 112 -138 113 -112 C113 -104 111 -100 112 -96 L124 -76 C125 -73 123 -71 119 -71 L114 -71 C116 -66 114 -63 116 -60 C113 -58 114 -55 115 -53 C112 -50 111 -48 110 -44 C112 -38 108 -32 98 -30 C84 -28 72 -24 66 -14 L66 0 Z" />
                  <clipPath id="profclip"><use href="#prof" /></clipPath>
                  <g id="headset">
                    <use href="#prof" className="d-head" />
                    <path className="d-scan" d="M-20 -150H130M-20 -140H130M-20 -130H130M-20 -120H130M-20 -110H130M-20 -100H130M-20 -90H130M-20 -80H130M-20 -70H130M-20 -60H130M-20 -50H130M-20 -40H130M-20 -30H130M-20 -20H130M-20 -10H130" />
                    <circle className="d-budring" cx="35" cy="-86" r="9" />
                    <circle className="d-bud" cx="35" cy="-86" r="4" />
                  </g>
                </defs>

                <polygon className="d-wire d-faint" points="225.2,-290 675.5,-30 -225.2,490 -675.5,230" />
                <polygon className="d-wire" points="207.8,-200 519.6,-20 -207.8,400 -519.6,220" />
                <path className="d-wire d-faint" d="M363.7,-110 L-363.7,310 M51.9,-290 L-519.6,40" />
                <g transform="matrix(0.866 0.5 -0.866 0.5 -467.6 236)"><text className="d-lbl d-sm" id="dia-host">HOTSPOT</text></g>

                <g className="d-seat seat-a" id="dia-seat-a" data-state="waiting">
                  <polygon className="d-plate" points="259.8,-100 346.4,-50 259.8,0 173.2,-50" />
                  <g transform="translate(-10.4 -6) matrix(-0.866 0.5 0 1 259.8 -50)"><use href="#prof" className="d-headback" transform="translate(-48 0) scale(0.9)" /></g>
                  <g transform="matrix(-0.866 0.5 0 1 259.8 -50)"><use href="#headset" transform="translate(-48 0) scale(0.9)" /></g>
                </g>

                <polygon className="d-under" points="0,-20 207.8,100 0,220 -207.8,100" />
                <polygon className="d-sideL" points="0,176 -173.2,76 -173.2,100 0,200" />
                <polygon className="d-sideR" points="173.2,76 0,176 0,200 173.2,100" />
                <polygon className="d-top" points="0,-24 173.2,76 0,176 -173.2,76" />
                <polygon className="d-wire" points="0,1 129.9,76 0,151 -129.9,76" />

                <path className="d-seg seat-a" id="dia-path-a" d="M274.1,-135.7 Q140,-110 0,76" />
                <path className="d-pk seat-a" d="M274.1,-135.7 Q140,-110 0,76" />
                <path className="d-seg seat-b" id="dia-path-b" d="M0,76 Q-130,190 -274.1,180.9" />
                <path className="d-pk seat-b" d="M0,76 Q-130,190 -274.1,180.9" />
                <circle className="d-pt" cx="0" cy="76" r="3.5" />

                <path className="d-dash" d="M0,-130 V-4 M138.6,-50 V76 M-138.6,-50 V76 M0,30 V156" />
                <polygon className="d-wire d-hi" points="0,-130 138.6,-50 0,30 -138.6,-50" />
                <path className="d-squig" d="M-96,-46 C-78,-78 -58,-18 -38,-44 S2,-76 22,-48 S62,-18 92,-52" />
                <g transform="matrix(0.866 0.5 -0.866 0.5 12 -128)"><text className="d-lbl" y="12">ROOM READ</text></g>
                <g transform="matrix(0.866 -0.5 0.866 0.5 -124 -40)"><text className="d-lbl d-sm">LIVE TRANSCRIPT</text></g>

                <g className="d-seat seat-b" id="dia-seat-b" data-state="waiting">
                  <polygon className="d-plate" points="-259.8,200 -173.2,250 -259.8,300 -346.4,250" />
                  <g transform="translate(-10.4 -6) matrix(0.866 -0.5 0 1 -259.8 250)"><use href="#prof" className="d-headback" transform="translate(-48 0) scale(0.9)" /></g>
                  <g transform="matrix(0.866 -0.5 0 1 -259.8 250)"><use href="#headset" transform="translate(-48 0) scale(0.9)" /></g>
                </g>

                <g className="seat-a" transform="matrix(0.866 0.5 -0.866 0.5 324.8 -12.5)">
                  <text className="d-lbl" id="dia-a-name">A · PRESENTER</text>
                  <rect className="d-pill" x="0" y="8" width="96" height="17" rx="3" id="dia-a-pill" />
                  <text className="d-pilltxt" x="7" y="20" id="dia-a-state">WAITING</text>
                </g>
                <g className="seat-b" transform="matrix(0.866 0.5 -0.866 0.5 -194.9 287.5)">
                  <text className="d-lbl" id="dia-b-name">B · COACH</text>
                  <rect className="d-pill" x="0" y="8" width="96" height="17" rx="3" id="dia-b-pill" />
                  <text className="d-pilltxt" x="7" y="20" id="dia-b-state">WAITING</text>
                </g>
                <g transform="matrix(0.866 0.5 -0.866 0.5 -62.4 112)">
                  <rect className="d-pill d-pill--hub" x="-78" y="-9" width="156" height="18" rx="3" />
                  <text className="d-pilltxt" x="-70" y="4" id="dia-agent">AGENT · STANDING BY</text>
                </g>

                <circle className="d-pt" cx="0" cy="-24" r="2.4" /><circle className="d-pt" cx="173.2" cy="76" r="2.4" /><circle className="d-pt" cx="-173.2" cy="76" r="2.4" />
                <circle className="d-pt" cx="0" cy="-130" r="2.4" /><circle className="d-pt" cx="138.6" cy="-50" r="2.4" /><circle className="d-pt" cx="-138.6" cy="-50" r="2.4" />
              </svg>

              <div className="join">
                <p className="kicker">Join from each phone on the hotspot</p>
                <div className="join__row">
                  <span className="join__url" id="join-url">—</span>
                  <a className="join__link" href="/?sim=1&amp;seat=A">{"Simulate A "}<span aria-hidden="true">↗</span></a>
                  <a className="join__link" href="/?sim=1&amp;seat=B">{"Simulate B "}<span aria-hidden="true">↗</span></a>
                  <a className="join__link" href="/?calibrate=1">{"Calibrate "}<span aria-hidden="true">↗</span></a>
                </div>
                <p className="join__note" id="join-guidance" hidden></p>
              </div>
            </div>

            <ChannelMonitor id="lobby-monitor" className="channel-monitor" />
            <section className="reference-panel" id="reference-setup" aria-labelledby="reference-title">
              <h2 className="kicker" id="reference-title">{"TEAM BRIEF & REFERENCES"}</h2>
              <label htmlFor="coach-scenario">Coaching scenario</label>
              <select id="coach-scenario">
                <option value="pitch">{"Pitch Q&A"}</option>
                <option value="interview">Interview</option>
                <option value="social">Date or small talk</option>
              </select>
              <p className="reference-note" id="coach-scenario-note"></p>
              <p>Add documents so the coach can find supported answers to live questions. Answers are previewed privately and require a tap to send.</p>
              <label htmlFor="reference-files">Choose a brief and reference documents</label>
              <input id="reference-files" type="file" multiple accept=".txt,.md,.pdf,.docx" />
              <div className="reference-actions">
                <button id="reference-upload" type="button">Load selected documents</button>
                <button id="reference-clear" type="button">Clear documents</button>
              </div>
              <p className="reference-note">TXT, Markdown, text-based PDF or DOCX. Up to 8 files, 5 MB each / 8 MB total. Uploading replaces the current set. Documents stay in hub memory until reset; relevant passages are sent to the configured OpenAI model when answering.</p>
              <p id="reference-status" role="status" aria-live="polite"></p>
              <ul id="reference-list"></ul>
            </section>

            <div className="detail">
              <div className="detail__seats" id="lobby-seats"></div>

              <div className="detail__col">
                <h2 className="kicker">{"CODEBOOK "}<span id="codebook-preset"></span></h2>
                <dl className="kv kv--codebook" id="lobby-codebook"></dl>
              </div>

              <div className="detail__col">
                <h2 className="kicker">CONNECTION</h2>
                <dl className="kv">
                  <div className="kv__row"><dt>Stage</dt><dd className="mono" id="stage-url">—</dd></div>
                  <div className="kv__row"><dt>Transport</dt><dd id="secure-readout">—</dd></div>
                  <div className="kv__row" id="certificate-row" hidden><dt>Certificate</dt><dd className="mono" id="certificate-readout"></dd></div>
                </dl>
              </div>
            </div>
          </section>


          <section className="screen screen--live" id="screen-live" aria-labelledby="live-title" hidden>
            <div className="live__head">
              <div className="live__title">
                <h1 className="kicker" id="live-title">LIVE BOARD</h1>
                <p className="live__preset" id="live-preset">—</p>
              </div>
              <dl className="stats">
                <div className="stat stat--lead"><dt>Bits tapped</dt><dd className="bits__value" id="bits-value">—</dd></div>
                <div className="stat"><dt>Messages</dt><dd id="live-messages">0</dd></div>
                <div className="stat"><dt>Words sent</dt><dd id="live-words">0</dd></div>
              </dl>
            </div>

            <div className="actionbar">
              <p className="actionbar__note">Keep the deck on the projector until the pitch ends.</p>
              <button className="begin" id="reveal-button" type="button">
                <span className="begin__label">Reveal</span>
                <span className="begin__arrow" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4" /></svg></span>
              </button>
            </div>

            <StagePair />
            <p className="live__context" id="live-context"></p>
            <ChannelMonitor id="stage-monitor" className="channel-monitor" />

            <div className="board">
              <div className="board__seats" id="live-seats"></div>
              <div className="stream">
                <h2 className="kicker stream__title">CHANNEL</h2>
                <ol className="stream__list" id="stream-list" aria-label="Session stream"></ol>
                <p className="empty" id="stream-empty">Waiting for the first tap.</p>
              </div>
            </div>


          </section>


          <section className="screen screen--reveal" id="screen-reveal" aria-labelledby="reveal-title" hidden>
            <StageRevealHeader />

            <section className="lanes-wrap" aria-labelledby="lanes-title">
              <h2 className="section-title" id="lanes-title">{"Timeline "}<span>Speech, taps and whispers</span></h2>
              <div className="lanes" id="reveal-lanes"></div>
            </section>

            <section className="timeline" aria-labelledby="messages-title">
              <h2 className="section-title" id="messages-title">{"Messages "}<span id="reveal-message-note"></span></h2>
              <ol className="timeline__list" id="timeline-list" aria-label="Message timeline"></ol>
              <p className="empty" id="timeline-empty">No messages in this session.</p>
            </section>

            <div className="transcripts" id="reveal-transcripts"></div>
          </section>
          <section className="reference-panel" id="answer-panel" aria-labelledby="answer-title" hidden>
            <h2 className="kicker" id="answer-title">CONVERSATION ANSWERS</h2>
            <p id="answer-status" role="status" aria-live="polite"></p>
            <p id="answer-question"></p>
            <p id="answer-text"></p>
            <ul id="answer-sources"></ul>
            <details><summary>Answer evidence from this session</summary><ul id="answer-history"></ul></details>
          </section>
        </main>
      </div>

      <p className="phase-announce" id="phase-announce" role="status" aria-live="polite"></p>

      <aside className="operator" id="operator" aria-labelledby="operator-title" hidden>
        <div className="operator__head">
          <h2 id="operator-title">Operator</h2>
          <button className="ghost" id="op-close" type="button">{"Close "}<kbd>Esc</kbd></button>
        </div>

        <div className="operator__body">
          <div className="operator__group">
            <h3 className="operator__label">Session</h3>
            <div className="operator__buttons">
              <button className="op-action" id="op-begin" type="button" data-action="begin">Begin</button>
              <button className="op-action" id="op-reveal" type="button" data-action="reveal">Reveal</button>
              <button className="op-action" id="op-replay" type="button" data-action="replay">Replay last</button>
              <button className="op-action" id="op-canned" type="button" data-action="canned">Canned take</button>
            </div>
            <p className="operator__note">Canned take plays the full pitch through this Mac in about 18 seconds.</p>
          </div>

          <section className="operator__group" id="op-coach" aria-labelledby="op-coach-title" hidden>
            <h3 className="operator__label" id="op-coach-title">Pitch coach</h3>
            <form className="field-row" id="op-coach-form">
              <label className="sr-only" htmlFor="op-coach-beat">Current pitch beat</label>
              <select className="control mono" id="op-coach-beat">
                <option value="opening">Opening</option>
                <option value="problem">Problem</option>
                <option value="demo">Working demo</option>
                <option value="closing">Closing</option>
              </select>
              <button className="op-action" id="op-coach-ask" type="submit">Ask coach</button>
            </form>
            <p className="operator__note" id="op-coach-status" role="status"></p>
            <div className="operator__coach-draft" id="op-coach-draft" hidden>
              <p className="operator__coach-line" id="op-coach-text"></p>
              <p className="operator__note" id="op-coach-reason"></p>
              <button className="op-action op-action--solid" id="op-coach-send" type="button">Send to both seats</button>
            </div>
          </section>

          <StageAnnouncement />

          <div className="operator__group">
            <h3 className="operator__label">Preset</h3>
            <div className="field-row">
              <label className="sr-only" htmlFor="op-preset">Preset</label>
              <select id="op-preset" className="control">
                <option value="Pitch">Pitch</option>
                <option value="Party">Party</option>
                <option value="Meeting">Meeting</option>
                <option value="Custom">Custom</option>
              </select>
              <button className="op-action op-action--fit" id="op-set-preset" type="button">Set</button>
            </div>
            <label className="field-label" htmlFor="op-context">Context (optional, sent with the preset)</label>
            <textarea id="op-context" className="control control--text" rows={2} spellCheck={false} placeholder="Pitch outline, slide order, judge seating"></textarea>
          </div>

          <div className="operator__group">
            <h3 className="operator__label">Inject a signal</h3>
            <div className="field-row">
              <label className="sr-only" htmlFor="op-seat">Sending seat</label>
              <select id="op-seat" className="control control--fit">
                <option value="A">Seat A</option>
                <option value="B">Seat B</option>
              </select>
              <label className="sr-only" htmlFor="op-signal">Signal</label>
              <select id="op-signal" className="control"></select>
              <button className="op-action op-action--fit" id="op-inject" type="button">Inject</button>
            </div>
          </div>

          <AppearanceControl className="operator__group" />

          <div className="operator__group">
            <h3 className="operator__label">Reset session</h3>
            <p className="operator__note">Clears the log, seats and bits. Reveal data is not saved.</p>
            <button className="op-action op-action--danger" id="op-reset" type="button" aria-describedby="op-reset-note">Reset</button>
            <span className="operator__note" id="op-reset-note"></span>
          </div>
        </div>

        <p className="operator__status" id="op-status" role="status" aria-live="polite">Standing by</p>
      </aside>
    </>
  );
}
