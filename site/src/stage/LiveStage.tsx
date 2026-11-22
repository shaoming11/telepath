import { useCallback, useEffect, useRef, useState } from "react";
import { PHASES, formatOffset, useHub, type Hub, type Phase } from "../hub/useHub";
import { Lobby } from "./Lobby";
import { LiveBoard } from "./LiveBoard";
import { Reveal } from "./Reveal";
import { Operator } from "./Operator";
import { Answers, RoomMicrophone } from "./Panels";
import "./stage.css";

const PHASE_LABELS: Record<Phase, string> = { lobby: "Lobby", live: "Live board", reveal: "Reveal" };
const LINK_LABELS = { online: "Hub online", offline: "Hub offline", connecting: "Connecting" } as const;

function Clock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="st-bar__clock">{formatOffset(now - startedAt)}</span>;
}

function Bar({ hub, operatorOpen, onOperator }: { hub: Hub; operatorOpen: boolean; onOperator: () => void }) {
  const { state, status } = hub;
  const pending = state.presetPending && state.presetPending !== state.preset ? " → " + state.presetPending : "";
  const current = PHASES.indexOf(state.phase);
  return (
    <header className="st-bar">
      <span className="st-bar__brand">Telepathy</span>
      <nav aria-label="Stage phase">
        <ol className="st-phases">
          {PHASES.map((phase, index) => (
            <li key={phase} data-active={index === current || undefined} data-done={index < current || undefined}
              aria-current={index === current ? "step" : undefined}>
              {PHASE_LABELS[phase]}
            </li>
          ))}
        </ol>
      </nav>
      <div className="st-bar__meta">
        <span className="st-link" data-link={status}>{LINK_LABELS[status]}</span>
        {state.sessionId && <span>Session {state.sessionId}</span>}
        <span>{(state.preset ?? "No preset") + pending}</span>
        {state.phase === "live" && state.startedAt !== null && state.startedAt > 1e12 && <Clock startedAt={state.startedAt} />}
        <button className="st-optoggle" type="button" data-operator-toggle aria-expanded={operatorOpen} aria-controls="st-operator"
          title="Operator controls (keyboard O)" onClick={onOperator}>
          Operator <kbd>O</kbd>
        </button>
      </div>
    </header>
  );
}

export function LiveStage({ embedded = false }: { embedded?: boolean }) {
  const hub = useHub();
  const { state, status } = hub;
  const [operatorOpen, setOperatorOpen] = useState(false);
  const lastFocus = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLElement>(null);

  const setOperator = useCallback((open: boolean) => {
    setOperatorOpen(previous => {
      if (open && !previous) lastFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return open;
    });
  }, []);

  const closeOperator = useCallback(() => {
    setOperator(false);
    const target = lastFocus.current;
    const restorable = target && target !== document.body && document.contains(target) && !target.closest("#st-operator");
    (restorable ? target : root.current?.querySelector<HTMLElement>("[data-operator-toggle]"))?.focus({ preventScroll: true });
  }, [setOperator]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    if (box.top < 0 && box.bottom > 0) element.scrollIntoView({ block: "start" });
  }, [state.phase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && operatorOpen) { closeOperator(); return; }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.isContentEditable || (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "o" || event.key === "O") {
        event.preventDefault();
        if (operatorOpen) closeOperator();
        else setOperator(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [operatorOpen, closeOperator, setOperator]);

  return (
    <section className="stage" ref={root} data-stage data-embedded={embedded} data-phase={state.phase} data-link={status}
      aria-label="Telepathy live stage">
      <Bar hub={hub} operatorOpen={operatorOpen} onOperator={() => (operatorOpen ? closeOperator() : setOperator(true))} />

      {status !== "online" && (
        <p className="st-offline" role="status">
          <strong>{status === "offline" ? "Hub offline." : "Connecting to the hub."}</strong>{" "}
          {state.sessionId
            ? "Showing the last state received. Controls resume when the hub is back."
            : "Start it on this Mac with node hub/server.mjs. This page reconnects on its own."}
        </p>
      )}
      {state.canned && (
        <p className="st-canned" role="status">
          <span>Canned take</span>
          {state.canned.label ? "Recorded take: " + state.canned.label : "Recorded pitch replay, not a live run."}
        </p>
      )}

      <main className="st-main" key={state.phase}>
        {state.phase === "lobby" && <Lobby hub={hub} />}
        {state.phase === "live" && <LiveBoard hub={hub} />}
        {state.phase === "reveal" && <Reveal hub={hub} />}
        {state.phase !== "lobby" && (
          <div className="st-below">
            <RoomMicrophone hub={hub} />
            <Answers hub={hub} />
          </div>
        )}
      </main>

      <p className="st-sr" role="status" aria-live="polite">Stage phase: {PHASE_LABELS[state.phase]}</p>
      <Operator hub={hub} open={operatorOpen} onClose={closeOperator} />
    </section>
  );
}
