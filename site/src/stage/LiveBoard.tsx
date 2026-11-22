import { useEffect, useRef, useState } from "react";
import {
  KIND_LABELS, SIGNAL_LABELS, describeEvent, formatOffset, isSeat, offsetFrom, roomStatus, timelineBase,
  type Hub, type LogEntry, type SeatState,
} from "../hub/useHub";
import { SeatMeters, useSeatMonitor } from "./Panels";

const TRANSCRIPT_LINES = 12;
const PULSE_KINDS = new Set(["message", "draft", "receipt", "replay", "announcement"]);

interface Pulse { key: string; kind: string; from: string | null; urgent: boolean }

function usePulse(log: LogEntry[]): Pulse | null {
  const seen = useRef<string | null | undefined>(undefined);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  useEffect(() => {
    let latest: LogEntry | null = null;
    for (let index = log.length - 1; index >= 0 && !latest; index -= 1) {
      if (log[index].kind && PULSE_KINDS.has(log[index].kind as string)) latest = log[index];
    }
    const key = latest?.key ?? null;
    const first = seen.current === undefined;
    if (seen.current === key) return;
    seen.current = key;
    if (!first && latest) setPulse({ key: latest.key, kind: latest.kind ?? "message", from: latest.seat, urgent: latest.urgent });
  }, [log]);
  return pulse;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="st-stat">
      <dt>{label}</dt>
      <dd key={value}>{value}</dd>
    </div>
  );
}

function BoardSeat({ seat, base, flash, canned, children }: {
  seat: SeatState; base: number | null; flash: string | null; canned: boolean; children: React.ReactNode;
}) {
  const lines = seat.transcript.slice(-TRANSCRIPT_LINES);
  const badges = canned ? ["Recorded take"] : [
    seat.online ? "Online" : "Offline",
    seat.online ? roomStatus(seat) : null,
    seat.mode ? (seat.mode === 1 ? "1 earbud" : "2 earbuds") : null,
    seat.drafts === false ? "Drafts off" : null,
  ].filter(Boolean);
  return (
    <section className="st-seat" data-seat={seat.key} data-online={seat.online || canned} data-pending={Boolean(seat.pending)} aria-label={seat.name}>
      <header className="st-seat__head">
        <span className="st-seat__key" key={flash ?? "idle"} data-flash={flash ? true : undefined}>{seat.key}</span>
        <h2>{seat.name}</h2>
      </header>
      <p className="st-seat__badges">{badges.join(" · ")}</p>
      <p className="st-seat__situation" data-empty={!seat.situation || undefined}>{seat.situation ?? "No reading of this room yet"}</p>
      {seat.pending && (
        <p className="st-seat__pending" key={seat.pending.id ?? "pending"}>
          <span>{seat.pending.heardAt == null ? "Preview queued" : "Awaiting reply"}</span>
          {describeEvent(seat.pending, "Draft pending")}
        </p>
      )}
      <dl className="st-kv">
        <div><dt>Last in</dt><dd className={seat.lastIn ? undefined : "st-dim"}>{describeEvent(seat.lastIn, "Nothing yet")}</dd></div>
        <div><dt>Last out</dt><dd className={seat.lastOut ? undefined : "st-dim"}>{describeEvent(seat.lastOut, "Nothing yet")}</dd></div>
      </dl>
      {children}
      <h3 className="st-kicker">Transcript</h3>
      <div className="st-transcript" role="log" aria-label={seat.name + " transcript"}>
        {lines.length ? [...lines].reverse().map((line, index) => (
          <p key={lines.length - index + ":" + line.at}>
            <time>{formatOffset(offsetFrom(base, line.at))}</time>
            <span>{line.text}</span>
          </p>
        )) : <p className="st-dim">{seat.transcription === "live" ? "Waiting for speech" : "No transcript"}</p>}
      </div>
    </section>
  );
}

function streamText(entry: LogEntry) {
  const text = [
    entry.signal ? SIGNAL_LABELS[entry.signal] ?? entry.signal : null,
    entry.text,
    entry.latencyMs === null ? null : entry.latencyMs + " ms after decision",
  ].filter(Boolean).join(" · ");
  return text || (entry.to ? "→ " + entry.to : "");
}

export function LiveBoard({ hub }: { hub: Hub }) {
  const { state, status, summary, operate } = hub;
  const base = timelineBase(state);
  const pulse = usePulse(state.log);
  const view = useSeatMonitor();
  const latest = [...state.log].reverse().find(entry => entry.kind === "message") ?? null;
  const entries = state.log.slice(-160).reverse();
  const pending = state.presetPending && state.presetPending !== state.preset;
  const heardBy = (key: string) => (pulse && (pulse.kind === "message" || pulse.kind === "replay") && pulse.from && pulse.from !== key ? pulse.key : null);
  const draftSeat = state.seats.A.pending ? "A" : state.seats.B.pending ? "B" : null;

  return (
    <div className="st-live">
      <div className="st-live__head">
        <div>
          <h1 className="st-kicker">Live board</h1>
          <p className="st-live__preset">
            {state.preset ?? "No preset"}{pending && <span> → {state.presetPending} caching</span>}
          </p>
          {state.context && <p className="st-live__context">{state.context}</p>}
        </div>
        <dl className="st-stats">
          <Stat label="Messages" value={String(summary.messages)} />
          <Stat label="Words heard" value={String(summary.words)} />
          <Stat label="Bits tapped" value={summary.bits === null ? "—" : String(summary.bits)} />
        </dl>
      </div>

      <div className="st-board">
        <BoardSeat seat={state.seats.A} base={base} flash={heardBy("A")} canned={Boolean(state.canned)}>
          <SeatMeters seat="A" value={view.monitor?.seats?.A} showRoom={view.showRoom("A")} />
        </BoardSeat>

        <section className="st-channel" aria-label="Channel" data-agent={view.agentPhase}>
          <div className="st-wire" data-draft={draftSeat ?? undefined} aria-hidden="true">
            <i className="st-wire__node" data-seat="A" />
            <span className="st-wire__line" />
            <i className="st-wire__agent" />
            {pulse && (
              <i className="st-wire__pulse" key={pulse.key} data-kind={pulse.kind} data-from={pulse.from ?? "hub"}
                data-urgent={pulse.urgent || undefined} />
            )}
            <i className="st-wire__node" data-seat="B" />
          </div>

          <div className="st-latest" aria-live="polite">
            {latest ? (
              <div key={latest.key} data-seat={isSeat(latest.seat) ? latest.seat : undefined} data-urgent={latest.urgent || undefined}>
                <p className="st-latest__route">
                  <b>{latest.seat ?? "Hub"}</b>{latest.to ? " → " + latest.to : ""}
                  {latest.signal ? " · " + (SIGNAL_LABELS[latest.signal] ?? latest.signal) : ""}
                  {" · " + formatOffset(offsetFrom(base, latest.at))}
                  {latest.canned ? " · canned" : latest.playedAt === null ? " · playback unconfirmed" : " · heard"}
                </p>
                <p className="st-latest__text">{latest.text ?? latest.signal ?? "Message"}</p>
              </div>
            ) : (
              <p className="st-latest__empty">Waiting for the first tap.</p>
            )}
          </div>

          <p className="st-agent"><b>{view.agentLabel}</b> {view.agentDetail}</p>

          <h2 className="st-kicker">Channel</h2>
          <ol className="st-stream" aria-label="Session stream">
            {entries.map(entry => (
              <li key={entry.key} data-kind={entry.kind ?? undefined} data-seat={entry.seat ?? undefined}
                data-urgent={entry.urgent || undefined} data-canned={entry.canned || undefined}>
                <time>{formatOffset(offsetFrom(base, entry.at))}</time>
                <b>{entry.seat ?? "·"}</b>
                <span className="st-stream__kind">{(entry.kind && KIND_LABELS[entry.kind]) ?? entry.kind ?? "event"}</span>
                <span className="st-stream__text">{streamText(entry)}</span>
                <span className="st-stream__bits">{entry.bits === null ? "" : entry.bits + " b"}</span>
              </li>
            ))}
            {!entries.length && <li className="st-dim st-stream__empty">Nothing on the channel yet.</li>}
          </ol>
        </section>

        <BoardSeat seat={state.seats.B} base={base} flash={heardBy("B")} canned={Boolean(state.canned)}>
          <SeatMeters seat="B" value={view.monitor?.seats?.B} showRoom={view.showRoom("B")} />
        </BoardSeat>
      </div>

      <div className="st-actionbar">
        <p className="st-hint">Keep the story on the projector until the pitch ends.</p>
        <button className="st-primary" type="button" disabled={status !== "online"} onClick={() => operate("reveal")}>Reveal</button>
      </div>
    </div>
  );
}
