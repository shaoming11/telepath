import { useEffect, useState } from "react";
import {
  KIND_LABELS, SEATS, SIGNAL_LABELS, formatOffset, isSeat, offsetFrom, revealLanes, timelineBase, timelineRows,
  type Hub, type HubState, type LogEntry, type SeatKey, type SeatState,
} from "../hub/useHub";

const LEGEND = [
  ["speech", "Speaking"], ["tap", "Tap sent"], ["heard", "Whisper heard"], ["receipt", "Receipt"], ["draft", "Agent draft"],
] as const;
const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");

function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    const started = performance.now();
    const duration = Math.min(1400, 500 + value * 60);
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      setShown(Math.round(value * (1 - (1 - progress) ** 3) * 100) / 100);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    setShown(0);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{Number.isInteger(value) ? Math.round(shown) : shown}</>;
}

const LANE_ORDER: SeatKey[] = ["B", "A"];
const laneY = (seat: SeatKey) => (LANE_ORDER.indexOf(seat) + 0.5) * (100 / LANE_ORDER.length);
const drawDelay = (left: number) => Math.round(500 + left * 14) + "ms";

function Lanes({ state }: { state: HubState }) {
  const view = revealLanes(state);
  if (!view) return null;
  return (
    <section className="st-lanes" aria-labelledby="st-lanes-title">
      <h2 className="st-kicker" id="st-lanes-title">Timeline <span>speech, taps and whispers</span></h2>
      <div className="st-lanes__axis" aria-hidden="true">
        {view.ticks.map(tick => <span key={tick.label} style={{ left: tick.left.toFixed(2) + "%" }}>{tick.label}</span>)}
      </div>
      <div className="st-lanes__body">
        {LANE_ORDER.map(key => (
          <div className="st-lane" key={key} data-seat={key}>
            <p className="st-lane__who"><b>{key}</b>{state.seats[key].name}</p>
            <div className="st-lane__track" aria-hidden="true">
              {view.marks.filter(mark => mark.lane === key).map((mark, index) => (
                <i key={index} className="st-mark" data-type={mark.type} data-from={mark.seat} data-urgent={mark.urgent || undefined}
                  style={{
                    left: mark.left.toFixed(2) + "%", animationDelay: drawDelay(mark.left),
                    width: mark.width === undefined ? undefined : mark.width.toFixed(2) + "%",
                  }}>
                  {mark.type === "tap" && mark.label ? <span>{SIGNAL_LABELS[mark.label] ?? mark.label}</span> : null}
                </i>
              ))}
            </div>
          </div>
        ))}
        <svg className="st-lanes__links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {view.links.map(link => (
            <line key={link.key} data-from={link.from} x1={link.sent} y1={laneY(link.from)} x2={link.heard} y2={laneY(link.to)}
              vectorEffect="non-scaling-stroke" style={{ animationDelay: drawDelay(link.sent) }} />
          ))}
        </svg>
      </div>
      <p className="st-lanes__legend">
        {LEGEND.map(([type, label]) => <span key={type}><i className="st-mark" data-type={type} data-legend />{label}</span>)}
      </p>
    </section>
  );
}

function Transcript({ seat, heard, base }: { seat: SeatState; heard: LogEntry[]; base: number | null }) {
  const entries = [
    ...seat.transcript.map((line, index) => ({ key: "line:" + index, at: line.at, text: line.text, from: null as string | null })),
    ...heard.map(message => ({
      key: "heard:" + message.key, at: message.playedAt ?? message.at,
      text: message.text ?? message.signal ?? "a message", from: message.seat ?? "hub",
    })),
  ].sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  const lines = plural(seat.transcript.length, "line");
  return (
    <section className="st-transcripts__column" data-seat={seat.key}>
      <h2 className="st-section-title">
        {seat.name} <span>{heard.length ? lines + " · " + heard.length + " heard" : lines}</span>
      </h2>
      <div className="st-transcript st-transcript--full" role="log" aria-label={seat.name + " transcript"}>
        {entries.length ? entries.map(entry => (
          <p key={entry.key} data-heard-from={entry.from ?? undefined}>
            <time>{formatOffset(offsetFrom(base, entry.at))}</time>
            {entry.from ? <span>Heard <b>“{entry.text}”</b></span> : <span>{entry.text}</span>}
          </p>
        )) : <p className="st-dim">No transcript</p>}
      </div>
    </section>
  );
}

export function Reveal({ hub }: { hub: Hub }) {
  const { state, summary } = hub;
  const rows = timelineRows(state);
  const base = timelineBase(state);
  const heard = state.canned ? summary.messages : summary.playbackStarts;
  const kicker = ["Reveal", state.preset, summary.durationMs ? formatOffset(summary.durationMs) : null, state.canned ? "Canned take" : null]
    .filter(Boolean).join(" · ");

  return (
    <div className="st-reveal">
      <header className="st-reveal__head">
        <p className="st-kicker">{kicker}</p>
        <h1 className="st-headline"><span>Everything that</span> went across.</h1>
      </header>

      <dl className="st-score">
        <div>
          <dd><CountUp value={summary.messages} /></dd>
          <dt>{summary.messages === 1 ? "message" : "messages"}</dt>
        </div>
        <div>
          <dd><CountUp value={summary.words} /></dd>
          <dt>{summary.words === 1 ? "word heard" : "words heard"}</dt>
        </div>
        <div>
          <dd>{summary.bits === null ? "—" : <CountUp value={summary.bits} />}</dd>
          <dt>{summary.bits === 1 ? "bit tapped" : "bits tapped"}</dt>
        </div>
      </dl>
      <p className="st-score__note">
        {summary.messages
          ? plural(summary.messages, "message") + " sent · " + heard + " heard"
            + (!state.canned && summary.playbackStarts < summary.messages ? " · " + summary.playbackStarts + " playback confirmed" : "")
          : plural(rows.length, "event") + " in this session"}
      </p>

      <Lanes state={state} />

      <section className="st-messages" aria-labelledby="st-messages-title">
        <h2 className="st-section-title" id="st-messages-title">Messages</h2>
        {rows.length ? (
          <ol>
            {rows.map(row => {
              const label = (row.signal && (SIGNAL_LABELS[row.signal] ?? row.signal)) ?? (row.kind && KIND_LABELS[row.kind]) ?? "event";
              const meta = row.canned ? "canned take" : row.kind === "message" && row.playedAt === null ? "playback unconfirmed" : null;
              return (
                <li key={row.key} data-seat={isSeat(row.seat) ? row.seat : undefined} data-urgent={row.urgent || undefined}>
                  <time>{row.offsetLabel}</time>
                  <span className="st-messages__route">{row.seat ? <><b>{row.seat}</b>{row.to ? " → " + row.to : ""}</> : "Hub"}</span>
                  <span className="st-messages__signal">{label}</span>
                  <span className="st-messages__text">{row.text ?? label}{meta && <small>{meta}</small>}</span>
                  <span className="st-messages__bits" aria-label={row.bits === null ? undefined : row.bits + " bits"}>
                    {row.bits === null ? "" : Math.round(row.bits * 100) / 100 + (row.bits === 1 ? " bit" : " bits")}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : <p className="st-dim">No messages in this session.</p>}
      </section>

      <div className="st-transcripts">
        {SEATS.map(key => (
          <Transcript key={key} seat={state.seats[key]} base={base}
            heard={state.log.filter(entry => entry.kind === "message" && entry.to === key)} />
        ))}
      </div>
    </div>
  );
}
