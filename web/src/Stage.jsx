import { storyUrl } from "./paths.js";
import React, { useEffect, useRef, useState } from "react";
import { useHub } from "./transport.jsx";
import { Brand } from "./Studio.jsx";
import { Operator } from "./Operator.jsx";
import { RoomConsole, References } from "./Room.jsx";
import {
  SEATS,
  seatSummary,
  seatReadout,
  joinGuidance,
  revealSummary,
  timelineBase,
  formatOffset,
  offsetFrom,
  roomStatus,
  speechSpanMs,
} from "./upstream/stage.mjs";
import { SIGNAL_LABELS } from "./upstream/phone-data.mjs";
import { mountChannelMonitor } from "./upstream/channel-monitor.mjs";
import "./upstream/channel-monitor.css";

function Clock({ started }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <time>{formatOffset(now - started)}</time>;
}
function Stats({ state }) {
  const { messages, words, playbackStarts } = revealSummary(state);
  return (
    <dl className="stats">
      {[
        [state.bits, "Bits tapped"],
        [messages, "Messages"],
        [words, "Message words"],
        [playbackStarts, "Playback starts"],
      ].map(([v, k]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
function Seat({ seat, live }) {
  const s = seat.key;
  return (
    <section className={"seat-card " + (s === "A" ? "amber" : "blue")}>
      <div className="seat-header">
        <span className="seat-code">{s}</span>
        <div>
          <h3>{seat.name}</h3>
          <small>
            {seatSummary(seat).text}
            {seat.sim ? " · Simulated" : ""}
          </small>
        </div>
      </div>
      {live ? (
        <>
          <p>{seat.situation || roomStatus(seat)}</p>
          {seat.pending && (
            <blockquote>
              {seat.pending.heardAt == null
                ? "Preview queued"
                : "Awaiting approval"}{" "}
              · {seat.pending.text}
            </blockquote>
          )}
          <dl className="facts">
            <div>
              <dt>Last in</dt>
              <dd>{seat.lastIn?.text || "—"}</dd>
            </div>
            <div>
              <dt>Last out</dt>
              <dd>{seat.lastOut?.text || "—"}</dd>
            </div>
          </dl>
          <details>
            <summary>Seat transcript</summary>
            {seat.transcript.length ? (
              seat.transcript.slice(-12).map((x, i) => <p key={i}>{x.text}</p>)
            ) : (
              <p>No transcript.</p>
            )}
          </details>
        </>
      ) : (
        <dl className="facts">
          {seatReadout(seat).map((x) => (
            <div key={x.label}>
              <dt>{x.label}</dt>
              <dd>{x.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
function Monitor() {
  const { monitor } = useHub();
  const host = useRef(null),
    view = useRef(null);
  useEffect(() => {
    view.current = mountChannelMonitor(host.current, SEATS);
    return () => {
      view.current = null;
    };
  }, []);
  useEffect(() => view.current?.update(monitor), [monitor]);
  return (
    <details className="panel monitor">
      <summary>Live audio and context</summary>
      <div ref={host} className="channel-monitor" />
    </details>
  );
}
const answerStatus = {
  idle: "Listening for questions",
  researching: "Checking the conversation and references",
  waiting: "Waiting for the room to answer",
  answer: "Answer found",
  advice: "Private advice ready",
  preview: "Private preview · awaiting approval",
  confirmed: "Approved for delivery",
  discarded: "Answer discarded",
  expired: "Approval expired",
  resolved: "Question resolved",
  unsupported: "No supported answer in the references",
  none: "No open question",
  cancelled: "Conversation changed",
  already_offered: "Answer already offered",
  unavailable: "Answer unavailable",
};
function Answers({ state }) {
  const q = state.questionState;
  if (
    !state.references.length &&
    !state.answerHistory.length &&
    (!q.status || q.status === "idle")
  )
    return null;
  return (
    <section className="panel">
      <h2>Conversation answers</h2>
      <p role="status">
        {state.questionAnswering
          ? answerStatus[q.status] || "Listening"
          : "Document answering is unavailable with the current provider."}
      </p>
      {q.question && <h3>{q.question}</h3>}
      {q.answer && <blockquote>{q.answer}</blockquote>}
      {q.sources?.map((s, i) => (
        <p key={i}>
          {s.name} · “{s.quote}”
        </p>
      ))}
      <details>
        <summary>Answer evidence</summary>
        {state.answerHistory.map((e, i) => (
          <article key={i}>
            <p>
              {e.text} {e.source && <small>· {e.source}</small>}
              {Number.isFinite(e.requestToPlaybackMs) &&
                e.requestToPlaybackMs >= 0 && (
                  <small>
                    {" "}
                    · {(e.requestToPlaybackMs / 1000).toFixed(1)} s to playback
                  </small>
                )}
            </p>
            {e.sources?.map((s, j) => (
              <p key={j}>
                {s.name} · {s.quote}
              </p>
            ))}
          </article>
        ))}
      </details>
    </section>
  );
}
function Lobby({ state, info, action }) {
  const home = info?.stageUrl ? new URL("/", info.stageUrl).href : null;
  return (
    <>
      <div className="stage-hero">
        <div>
          <p className="overline">Lobby</p>
          <h1>Ready to begin?</h1>
          <p>Connect the presenter and coach to the same hub.</p>
        </div>
        <button
          className="primary"
          disabled={!state.canBegin}
          onClick={() => action("begin")}
        >
          Begin session <b>→</b>
        </button>
      </div>
      <a className="reference-shortcut" href="#reference-setup">
        Team brief &amp; references ↓
      </a>
      <div className="pair">
        {SEATS.map((s) => (
          <Seat key={s} seat={state.seats[s]} />
        ))}
      </div>
      <section className="panel join">
        <div>
          <h2>Join the room</h2>
          <p>
            {info?.lanAvailable
              ? "Open this address on each phone."
              : "Local rehearsal"}
          </p>
          {info?.joinUrl && <strong>{info.joinUrl}</strong>}
        </div>
        <div className="buttons">
          {home && (
            <>
              <a href={home + "?sim=1&seat=A"} target="_blank" rel="noreferrer">
                Simulate A ↗
              </a>
              <a href={home + "?sim=1&seat=B"} target="_blank" rel="noreferrer">
                Simulate B ↗
              </a>
              <a href={home + "?calibrate=1"} target="_blank" rel="noreferrer">
                Calibrate ↗
              </a>
            </>
          )}
        </div>
      </section>
      <div className="pair">
        <section className="panel">
          <h2>{state.preset || "Pitch"} codebook</h2>
          <dl className="facts">
            {Object.entries(state.codebook).map(([s, t]) => (
              <div key={s}>
                <dt>{SIGNAL_LABELS[s] || s}</dt>
                <dd>{t}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel">
          <h2>Connection</h2>
          <p>{info?.stageUrl}</p>
          <p>
            {info?.secure
              ? "Local TLS"
              : info?.lanAvailable
                ? "HTTP on the hotspot"
                : "Loopback rehearsal"}
          </p>
          {info?.certificateUrl && (
            <a href={info.certificateUrl}>Local certificate</a>
          )}
          {joinGuidance(info) && <p>{joinGuidance(info)}</p>}
        </section>
      </div>
      <References key={state.hubId + state.sessionId} />
      <Monitor />
    </>
  );
}
function Feed({ state, all = false }) {
  const events = all ? state.log : state.log.slice(-18).reverse();
  const base = timelineBase(state);
  return (
    <ol className="event-list">
      {events.map((e, i) => (
        <li key={(e.key || "e") + i}>
          <time>{formatOffset(offsetFrom(base, e.at))}</time>
          <span className={"event-seat " + (e.seat === "B" ? "blue" : "amber")}>
            {e.seat || "Hub"}
            {e.to ? " → " + e.to : ""}
          </span>
          <div>
            <strong>
              {e.text ||
                SIGNAL_LABELS[e.signal] ||
                e.kind?.replaceAll("_", " ")}
            </strong>
            <small>
              {e.kind?.replaceAll("_", " ")}
              {e.kind === "message"
                ? e.playedAt != null
                  ? " · playback confirmed"
                  : " · awaiting playback"
                : ""}
            </small>
          </div>
          {e.bits != null && <small>{e.bits} bits</small>}
        </li>
      ))}
    </ol>
  );
}
function Live({ state, action }) {
  const whisper = state.log.findLast((event) => event.kind === "message");
  const route =
    whisper &&
    [state.seats[whisper.seat]?.name, state.seats[whisper.to]?.name]
      .filter(Boolean)
      .join(" → ");
  return (
    <>
      <div className="stage-hero live-focus">
        <div>
          <p className="overline">Live board · {state.preset || "Session"}</p>
          <h1>
            {whisper?.text
              ? "“" + whisper.text + "”"
              : "Listening for the first cue."}
          </h1>
          {whisper && (
            <p>
              {route}{" "}
              <span className="play-status">
                {whisper.playedAt != null
                  ? "Playback confirmed"
                  : "Awaiting playback"}
              </span>
            </p>
          )}
        </div>
        <button className="primary" onClick={() => action("reveal")}>
          Reveal <b>→</b>
        </button>
      </div>
      <Stats state={state} />
      <div className="pair">
        {SEATS.map((s) => (
          <Seat live key={s} seat={state.seats[s]} />
        ))}
      </div>
      <section className="panel">
        <h2>Channel</h2>
        {state.log.length ? (
          <Feed state={state} />
        ) : (
          <p>Waiting for the first tap.</p>
        )}
      </section>
      {state.context && (
        <details className="panel">
          <summary>Pitch context</summary>
          <p>{state.context}</p>
        </details>
      )}
      <Monitor />
      <Answers state={state} />
    </>
  );
}
function Timeline({ state }) {
  const marks = [];
  for (const id of SEATS) {
    for (const t of state.seats[id].transcript)
      if (Number.isFinite(t.at))
        marks.push({
          seat: id,
          at: t.at,
          end: t.at + speechSpanMs(t.text),
          kind: "speech",
        });
  }
  for (const e of state.log) {
    if (!Number.isFinite(e.at) || !SEATS.includes(e.seat)) continue;
    if (e.kind === "message") {
      marks.push({ ...e, kind: "send" });
      if (Number.isFinite(e.playedAt) && SEATS.includes(e.to))
        marks.push({ seat: e.to, at: e.playedAt, kind: "heard" });
    }
    if (["receipt", "draft", "confirm"].includes(e.kind)) marks.push(e);
  }
  const base = timelineBase(state) ?? 0,
    last = Math.max(base + 1, ...marks.map((x) => x.end || x.at));
  return (
    <section className="panel">
      <h2>Timeline</h2>
      {marks.length ? (
        <>
          <div className="axis">
            <span>00:00</span>
            <span>{formatOffset(last - base)}</span>
          </div>
          {SEATS.map((s) => (
            <div className="lane" key={s}>
              <strong>{s}</strong>
              <div>
                {marks
                  .filter((x) => x.seat === s)
                  .map((x, i) => (
                    <i
                      key={i}
                      className={"tick " + x.kind}
                      title={x.kind + " · " + formatOffset(x.at - base)}
                      style={{
                        left:
                          Math.min(
                            99,
                            Math.max(0, (100 * (x.at - base)) / (last - base)),
                          ) + "%",
                        width: x.end
                          ? Math.max(
                              0.5,
                              (100 * (x.end - x.at)) / (last - base),
                            ) + "%"
                          : undefined,
                      }}
                    />
                  ))}
              </div>
            </div>
          ))}
          <p className="legend">
            Bars show speech. Colored marks show sends, playback, receipts and
            drafts.
          </p>
        </>
      ) : (
        <p>No timed events in this take.</p>
      )}
    </section>
  );
}
function Reveal({ state }) {
  const summary = revealSummary(state);
  return (
    <>
      <div className="stage-hero reveal-head">
        <div>
          <p className="overline">Reveal</p>
          <h1>Here’s what passed between us.</h1>
        </div>
        <Stats state={state} />
      </div>
      <section className="panel">
        <h2>Messages</h2>
        {summary.messages ? (
          <Feed
            all
            state={{
              ...state,
              log: state.log.filter((x) => x.kind === "message"),
            }}
          />
        ) : (
          <p>No messages in this take.</p>
        )}
      </section>
      <Timeline state={state} />
      <details className="panel">
        <summary>Full session record</summary>
        <Feed all state={state} />
      </details>
      <div className="pair">
        {SEATS.map((s) => {
          const rows = [
            ...state.seats[s].transcript.map((x) => ({ ...x, kind: "Speech" })),
            ...state.log
              .filter(
                (x) => x.kind === "message" && x.to === s && x.playedAt != null,
              )
              .map((x) => ({ ...x, at: x.playedAt, kind: "Heard" })),
          ].sort((a, b) => a.at - b.at);
          return (
            <section key={s} className="panel">
              <h2>{state.seats[s].name} transcript</h2>
              {rows.length ? (
                rows.map((x, i) => (
                  <p key={i}>
                    <small>
                      {formatOffset(offsetFrom(timelineBase(state), x.at))} ·{" "}
                      {x.kind}
                    </small>
                    <br />
                    {x.text}
                  </p>
                ))
              ) : (
                <p>No transcript.</p>
              )}
            </section>
          );
        })}
      </div>
      <Answers state={state} />
    </>
  );
}
export function Stage({ back }) {
  const { state, link, info, action } = useHub();
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    const key = (e) => {
      if (
        e.defaultPrevented ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.target.closest("input,select,textarea,[contenteditable]")
      )
        return;
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOperator((v) => !v);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    <main className="stage">
      <a className="skip-stage" href="#stage-content">
        Skip to stage content
      </a>
      <header className="stage-top">
        <Brand />
        <div className="stage-nav">
          <span className={"link " + link}>
            {link === "online"
              ? "Hub online"
              : link === "connecting"
                ? "Connecting"
                : "Hub offline"}
          </span>
          {state.phase === "live" && state.startedAt && (
            <Clock started={state.startedAt} />
          )}
          <button
            aria-haspopup="dialog"
            aria-expanded={operator}
            aria-controls="operator-controls"
            onClick={() => setOperator(true)}
          >
            Operator <kbd>O</kbd>
          </button>
        </div>
      </header>
      <div className="stage-body" id="stage-content" tabIndex={-1}>
        <div className="stage-crumb">
          <a href={typeof back === "string" ? back : back ? "#wrap" : storyUrl}>
            ← Story
          </a>
          <span>
            {state.sessionId
              ? "Session " + String(state.sessionId).slice(0, 8)
              : "Stage"}
          </span>
        </div>
        {link !== "online" ? (
          <section className="stage-hero">
            <div>
              <p className="overline">Live stage</p>
              <h1>
                {link === "offline" ? "Hub offline." : "Connecting to the hub."}
              </h1>
              <p>
                Start the Telepathy hub on the operator computer. This stage
                reconnects automatically.
              </p>
            </div>
          </section>
        ) : (
          <>
            {state.canned && (
              <p className="canned" role="status">
                Canned take · Bundled rehearsal playback
              </p>
            )}
            {state.phase === "lobby" ? (
              <Lobby state={state} info={info} action={action} />
            ) : state.phase === "live" ? (
              <Live state={state} action={action} />
            ) : (
              <Reveal state={state} />
            )}
            <RoomConsole key={state.hubId + state.sessionId} />
          </>
        )}
      </div>
      <Operator open={operator} close={() => setOperator(false)} />
    </main>
  );
}

