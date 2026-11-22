import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ANNOUNCEMENT_MAX_LENGTH, FIXED_SIGNALS, OPERATOR_ANNOUNCEMENTS, PITCH_BEATS, PITCH_BEAT_LABELS, PRESETS, SEATS,
  SIGNAL_LABELS, SIGNAL_ROLES, announcementNote, announcementText, pitchCoachView, setNotice, type Hub, type PitchBeat,
} from "../hub/useHub";

export function Operator({ hub, open, onClose }: { hub: Hub; open: boolean; onClose: () => void }) {
  const { state, status, notice, operate } = hub;
  const panel = useRef<HTMLElement>(null);
  const [beat, setBeat] = useState<PitchBeat>("opening");
  const [announceId, setAnnounceId] = useState("");
  const [announce, setAnnounce] = useState("");
  const [preset, setPreset] = useState<string>("Pitch");
  const [context, setContext] = useState("");
  const [seat, setSeat] = useState("A");
  const [signal, setSignal] = useState<string>("R1");
  const [armed, setArmed] = useState(false);

  useEffect(() => { setBeat(state.coach?.beat ?? "opening"); }, [state.hubId, state.sessionId]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    if (!open) { setArmed(false); return; }
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")
      ?? panel.current?.querySelector<HTMLElement>("button:not(:disabled)");
    first?.focus({ preventScroll: true });
  }, [open]);

  const connected = SEATS.filter(key => state.seats[key].online);
  const rehearsal = connected.length > 0 && connected.every(key => state.seats[key].sim);
  const text = announcementText(announce);
  const known = OPERATOR_ANNOUNCEMENTS.some(line => line.text === text);
  const progress = state.announcement;
  const busy = progress?.status === "building" || progress?.status === "queued";
  const presentation = Boolean(state.canned) || state.phase === "reveal";
  const canAnnounce = Boolean(text) && connected.length > 0 && !busy && !presentation && !(rehearsal && !known);
  let announceNote = presentation ? "Available before the reveal." : connected.length
    ? (rehearsal ? "Rehearsal uses the preset lines. " : "") + (connected.length === 2 ? "Both seats online." : "Only Seat " + connected[0] + " is online.")
    : "Waiting for a seat to connect.";
  if (!presentation && progress && (busy || progress.text === text)) announceNote = announcementNote(progress) ?? announceNote;

  const coach = pitchCoachView(state, status === "online", beat);
  const blocked = state.canBegin === false;

  function submitAnnounce(event: FormEvent) {
    event.preventDefault();
    if (canAnnounce) operate("announce", { text: announce });
  }
  function submitCoach(event: FormEvent) {
    event.preventDefault();
    if (coach?.canAsk) operate("coach_ask", { beat });
  }
  function reset() {
    if (!armed) {
      setArmed(true);
      setNotice("Reset armed, press confirm", "blocked");
      return;
    }
    setArmed(false);
    operate("reset");
  }

  return (
    <aside className="st-operator" id="st-operator" ref={panel} aria-labelledby="st-operator-title" data-open={open}
      inert={!open} aria-hidden={!open}>
      <header className="st-operator__head">
        <h2 id="st-operator-title">Operator</h2>
        <button className="st-ghost" type="button" onClick={onClose}>Close <kbd>Esc</kbd></button>
      </header>

      <div className="st-operator__body">
        <section className="st-tile" aria-label="Session">
          <h3>Session</h3>
          <div className="st-toggles">
            <button type="button" data-autofocus title={blocked ? "Seats are not all ready. The hub may refuse." : undefined}
              onClick={() => operate("begin")}>Begin</button>
            <button type="button" onClick={() => operate("reveal")}>Reveal</button>
            <button type="button" onClick={() => operate("replay")}>Replay last</button>
            <button type="button" onClick={() => operate("canned")}>Canned take</button>
          </div>
          <p className="st-tile__note">Canned take plays the full pitch through this Mac in about 18 seconds.</p>
        </section>

        {coach && (
          <section className="st-tile" aria-labelledby="st-coach-title">
            <h3 id="st-coach-title">Pitch coach</h3>
            <form className="st-row" onSubmit={submitCoach}>
              <label className="st-sr" htmlFor="st-coach-beat">Current pitch beat</label>
              <select className="st-control" id="st-coach-beat" value={beat} disabled={!coach.canAsk}
                onChange={event => setBeat(event.target.value as PitchBeat)}>
                {PITCH_BEATS.map(item => <option key={item} value={item}>{PITCH_BEAT_LABELS[item]}</option>)}
              </select>
              <button className="st-button" type="submit" disabled={!coach.canAsk}>Ask coach</button>
            </form>
            <p className="st-tile__note" role="status">{coach.note}</p>
            {coach.draft && state.coach && (
              <div className="st-coach">
                <p className="st-coach__line">{state.coach.text}</p>
                {state.coach.reason && <p className="st-tile__note">{state.coach.reason}</p>}
                <button className="st-button st-button--solid" type="button" disabled={!coach.canSend}
                  onClick={() => operate("coach_send", { coachId: state.coach?.id })}>Send to both seats</button>
              </div>
            )}
          </section>
        )}

        <form className="st-tile" onSubmit={submitAnnounce} aria-labelledby="st-announce-title">
          <h3 id="st-announce-title">Announce to both seats</h3>
          <label className="st-label" htmlFor="st-announce-preset">Preset line</label>
          <select className="st-control" id="st-announce-preset" value={announceId}
            onChange={event => {
              setAnnounceId(event.target.value);
              setAnnounce(OPERATOR_ANNOUNCEMENTS.find(line => line.id === event.target.value)?.text ?? "");
            }}>
            <option value="">Choose a preset line</option>
            {OPERATOR_ANNOUNCEMENTS.map(line => <option key={line.id} value={line.id}>{line.label}</option>)}
          </select>
          <label className="st-label" htmlFor="st-announce-text">Message</label>
          <textarea className="st-control" id="st-announce-text" rows={2} maxLength={ANNOUNCEMENT_MAX_LENGTH} value={announce}
            readOnly={rehearsal} onChange={event => setAnnounce(event.target.value)} />
          <button className="st-button st-button--solid" type="submit" disabled={!canAnnounce}>Send announcement</button>
          <p className="st-tile__note" role="status">{announceNote}</p>
        </form>

        <section className="st-tile" aria-label="Preset">
          <h3>Preset</h3>
          <div className="st-row">
            <label className="st-sr" htmlFor="st-preset">Preset</label>
            <select className="st-control" id="st-preset" value={preset} onChange={event => setPreset(event.target.value)}>
              {PRESETS.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <button className="st-button" type="button" onClick={() => operate("preset", { preset, context })}>Set</button>
          </div>
          <label className="st-label" htmlFor="st-context">Context (optional, sent with the preset)</label>
          <textarea className="st-control" id="st-context" rows={2} spellCheck={false} value={context}
            placeholder="Pitch outline, slide order, judge seating" onChange={event => setContext(event.target.value)} />
        </section>

        <section className="st-tile" aria-label="Inject a signal">
          <h3>Inject a signal</h3>
          <div className="st-row">
            <label className="st-sr" htmlFor="st-inject-seat">Sending seat</label>
            <select className="st-control st-control--fit" id="st-inject-seat" value={seat} onChange={event => setSeat(event.target.value)}>
              <option value="A">Seat A</option>
              <option value="B">Seat B</option>
            </select>
            <label className="st-sr" htmlFor="st-inject-signal">Signal</label>
            <select className="st-control" id="st-inject-signal" value={signal} onChange={event => setSignal(event.target.value)}>
              {FIXED_SIGNALS.map(item => (
                <option key={item} value={item}>
                  {SIGNAL_LABELS[item] + " · " + (state.codebook[item] ?? SIGNAL_ROLES[item] ?? "signal")}
                </option>
              ))}
            </select>
            <button className="st-button" type="button" onClick={() => operate("inject", { seat, signal })}>Inject</button>
          </div>
        </section>

        <section className="st-tile" aria-label="Reset session">
          <h3>Reset session</h3>
          <p className="st-tile__note">Clears the log, seats and bits. Reveal data is not saved.</p>
          <button className="st-button st-button--danger" type="button" data-armed={armed || undefined} onClick={reset}>
            {armed ? "Confirm reset" : "Reset"}
          </button>
          {armed && <p className="st-tile__note">Press again within 5 s.</p>}
        </section>
      </div>

      <p className="st-operator__status" role="status" aria-live="polite" data-tone={notice.tone}>{notice.text}</p>
    </aside>
  );
}
