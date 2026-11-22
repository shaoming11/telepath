import React, { useEffect, useRef, useState } from "react";
import { useHub } from "./transport.jsx";
import {
  pitchCoachView,
  announcementNote,
  PRESETS,
} from "./upstream/stage.mjs";
import {
  announcementText,
  OPERATOR_ANNOUNCEMENTS,
} from "./upstream/announcements.mjs";
import { SIGNAL_LABELS } from "./upstream/phone-data.mjs";

export function Operator({ open, close }) {
  const { state, link, action, status } = useHub();
  const dialog = useRef(null);
  const [preset, setPreset] = useState("Pitch"),
    [context, setContext] = useState("");
  const [seat, setSeat] = useState("B"),
    [signal, setSignal] = useState("R1");
  const [beat, setBeat] = useState("opening"),
    [line, setLine] = useState(""),
    [chosen, setChosen] = useState("");
  const [armed, setArmed] = useState(false);
  const online = link === "online";
  useEffect(() => {
    const node = dialog.current;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
    if (!open) setArmed(false);
  }, [open]);
  useEffect(() => {
    setArmed(false);
    setChosen("");
    setLine("");
    setBeat("opening");
    setPreset(state.preset || "Pitch");
    setContext(state.context || "");
  }, [state.hubId, state.sessionId]);
  useEffect(() => {
    if (armed) {
      const timer = setTimeout(() => setArmed(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [armed]);
  const coach = pitchCoachView(state, online, beat);
  const progress = state.announcement;
  const busy = ["building", "queued"].includes(progress?.status);
  const seatOnline = state.seats.A.online || state.seats.B.online;
  return (
    <dialog
      id="operator-controls"
      ref={dialog}
      className="operator"
      aria-labelledby="operator-title"
      onCancel={close}
      onClose={() => {
        if (open) close();
      }}
    >
      <div className="drawer-head">
        <h2 id="operator-title">Operator</h2>
        <button onClick={close}>
          Close <kbd>Esc</kbd>
        </button>
      </div>
      <fieldset disabled={!online}>
        <legend>Session</legend>
        <div className="buttons">
          <button
            onClick={() => action("begin")}
            disabled={state.phase !== "lobby" || !state.canBegin}
          >
            Begin
          </button>
          <button
            onClick={() => action("reveal")}
            disabled={state.phase !== "live"}
          >
            Reveal
          </button>
          <button onClick={() => action("canned")}>Canned take</button>
          <button onClick={() => action("replay")}>Replay last</button>
        </div>
      </fieldset>
      {coach && (
        <fieldset>
          <legend>Pitch coach</legend>
          <label>
            Pitch beat
            <select
              value={beat}
              disabled={!coach.canAsk}
              onChange={(e) => setBeat(e.target.value)}
            >
              {["opening", "problem", "demo", "closing"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!coach.canAsk}
            onClick={() => action("coach_ask", { beat })}
          >
            Ask coach
          </button>
          <p>{coach.note}</p>
          {coach.draft && (
            <>
              <blockquote>{state.coach.text}</blockquote>
              <p>{state.coach.reason}</p>
              <button
                disabled={!coach.canSend}
                onClick={() =>
                  action("coach_send", { coachId: state.coach.id })
                }
              >
                Send to both seats
              </button>
            </>
          )}
        </fieldset>
      )}
      <fieldset disabled={!online}>
        <legend>Announce to both seats</legend>
        <label>
          Preset line
          <select
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              setLine(
                OPERATOR_ANNOUNCEMENTS.find((x) => x.id === e.target.value)
                  ?.text || "",
              );
            }}
          >
            <option value="">Choose a line</option>
            {OPERATOR_ANNOUNCEMENTS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Message
          <textarea
            maxLength={140}
            value={line}
            onChange={(e) => {
              setLine(e.target.value);
              setChosen("");
            }}
          />
        </label>
        <button
          disabled={busy || !seatOnline || !announcementText(line)}
          onClick={() => action("announce", { text: line })}
        >
          Send announcement
        </button>
        {progress && <p role="status">{announcementNote(progress)}</p>}
      </fieldset>
      <fieldset disabled={!online}>
        <legend>Preset</legend>
        <label>
          Codebook
          <select
            aria-label="Codebook"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            {PRESETS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Optional context
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </label>
        <button onClick={() => action("preset", { preset, context })}>
          Set preset
        </button>
      </fieldset>
      <fieldset disabled={!online}>
        <legend>Inject a signal</legend>
        <div className="row">
          <label>
            Sending seat
            <select value={seat} onChange={(e) => setSeat(e.target.value)}>
              <option value="A">Seat A</option>
              <option value="B">Seat B</option>
            </select>
          </label>
          <label>
            Signal
            <select
              aria-label="Signal"
              value={signal}
              onChange={(e) => setSignal(e.target.value)}
            >
              {["R1", "R2", "L1", "OUT"].map((s) => (
                <option key={s} value={s}>
                  {SIGNAL_LABELS[s]} · {state.codebook[s] || s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button onClick={() => action("inject", { seat, signal })}>
          Inject
        </button>
      </fieldset>
      <fieldset disabled={!online}>
        <legend>Reset session</legend>
        <p>Clears both seats and the session history.</p>
        <button
          className="danger"
          onClick={() => {
            if (armed) {
              action("reset");
              setArmed(false);
            } else setArmed(true);
          }}
        >
          {armed ? "Confirm reset" : "Reset"}
        </button>
      </fieldset>
      <p role="status">
        {online ? status : "Connect the hub to use operator controls."}
      </p>
    </dialog>
  );
}

