import {
  SEATS, SIGNAL_LABELS, joinGuidance, roomStatus, seatSteps, seatSummary, type Hub, type SeatState,
} from "../hub/useHub";
import { Monitor, References, RoomMicrophone } from "./Panels";

function AirPod({ mirrored }: { mirrored: boolean }) {
  return (
    <svg className="st-pod" viewBox="0 0 72 120" aria-hidden="true" style={mirrored ? { transform: "scaleX(-1)" } : undefined}>
      <defs>
        <linearGradient id="st-pod-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.55" stopColor="#d9d9de" />
          <stop offset="1" stopColor="#8e8e93" />
        </linearGradient>
      </defs>
      <path
        fill="url(#st-pod-fill)"
        d="M27 4c17 0 33 11 33 30 0 12-6 20-15 25v47a9 9 0 0 1-18 0V60C14 57 6 47 6 33 6 15 14 4 27 4z"
      />
      <ellipse cx="22" cy="30" rx="6" ry="10" fill="rgb(0 0 0 / 0.28)" transform="rotate(-18 22 30)" />
    </svg>
  );
}

function SeatCard({ seat }: { seat: SeatState }) {
  const summary = seatSummary(seat);
  return (
    <article className="st-card" data-seat={seat.key} data-state={summary.state} aria-label={seat.name}>
      <div className="st-card__top">
        <div>
          <p className="st-card__seat">Seat {seat.key}</p>
          <h2 className="st-card__name">{seat.name}</h2>
          <p className="st-card__status" data-tone={summary.tone} key={summary.text}>{summary.text}</p>
        </div>
        <AirPod mirrored={seat.key === "B"} />
      </div>
      <ol className="st-steps">
        {seatSteps(seat).map(step => (
          <li key={step.label} data-done={step.done || undefined} data-flag={step.flag || undefined}>
            <i aria-hidden="true" />
            <b>{step.label}</b>
            <span>{step.value}</span>
          </li>
        ))}
      </ol>
      <p className="st-card__foot">
        {seat.online ? "Online" : "Offline"}{seat.sim ? " · rehearsal" : ""} · Room {roomStatus(seat).toLowerCase()}
      </p>
    </article>
  );
}

export function Lobby({ hub }: { hub: Hub }) {
  const { state, status, info, operate } = hub;
  const blocked = state.canBegin === false;
  const online = status === "online";
  const localOnly = info?.lanAvailable === false;
  const joinUrl = info?.joinUrl ?? null;
  let hubOrigin = "http://localhost:5780";
  try { if (info?.stageUrl) hubOrigin = new URL(info.stageUrl).origin; } catch { /* keep the default */ }
  const loopback = joinUrl ? /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(joinUrl) : false;
  const transport = !info ? "—" : localOnly ? "Local rehearsal" : info.secure === true ? "Secure origin"
    : loopback ? "Local rehearsal" : info.secure === false ? "Insecure origin" : "—";
  const certificate = localOnly ? null : info?.certificateUrl ?? null;
  const guidance = !info ? null : localOnly ? "Connect the MacBook and phones to the same hotspot, then restart the hub."
    : certificate ? "First use: install and trust the hub’s CA on each phone before opening the HTTPS address."
    : joinGuidance(info);
  const codebook = Object.entries(state.codebook);
  const ready = SEATS.every(key => state.seats[key].ready === true);
  const cache = state.presetPending && state.presetPending !== state.preset ? "Caching" : ready ? "Cached" : "After setup";

  return (
    <div className="st-lobby">
      <div className="st-lobby__head">
        <h1 className="st-headline"><span>Two seats.</span> One silent channel.</h1>
        <p className="st-lede">
          Your partner hears you in your own voice. A coach listens through the Mac’s microphone, checks your references,
          and waits for your tap before sending a whisper.
        </p>
      </div>

      <div className="st-cards">
        {SEATS.map(key => <SeatCard key={key} seat={state.seats[key]} />)}
      </div>

      <div className="st-begin">
        <button className="st-primary" type="button" disabled={blocked || !online} onClick={() => operate("begin")}>
          Begin session
        </button>
        <p className="st-hint">
          {!online ? "Waiting for the hub."
            : blocked ? "Begin unlocks when both seats have a voice, tested earbuds, calibration and Ready."
            : "Starts the live board on both seats."}
        </p>
      </div>

      <div className="st-join">
        <p className="st-kicker">Join from each phone on the hotspot</p>
        <p className="st-join__url">{localOnly ? "No hotspot address" : joinUrl ? joinUrl.replace(/\/$/, "") : "—"}</p>
        <p className="st-join__links">
          <a href={hubOrigin + "/?sim=1&seat=A"} target="_blank" rel="noreferrer">Simulate A</a>
          <a href={hubOrigin + "/?sim=1&seat=B"} target="_blank" rel="noreferrer">Simulate B</a>
          <a href={hubOrigin + "/?calibrate=1"} target="_blank" rel="noreferrer">Calibrate</a>
        </p>
        {guidance && (
          <p className="st-note">
            {guidance}{certificate && <> <a href={certificate}>Download hub certificate</a></>}
          </p>
        )}
      </div>

      <div className="st-setup">
        <RoomMicrophone hub={hub} />
        <References hub={hub} />
        <section className="st-panel" aria-labelledby="st-codebook-title">
          <h2 className="st-kicker" id="st-codebook-title">Codebook{state.preset ? " · " + state.preset : ""}</h2>
          <dl className="st-kv">
            {codebook.length
              ? codebook.map(([signal, meaning]) => (
                <div key={signal}><dt>{SIGNAL_LABELS[signal] ?? signal}</dt><dd>{meaning}</dd></div>
              ))
              : <div><dt>—</dt><dd className="st-dim">The hub has not published a codebook yet.</dd></div>}
          </dl>
          <dl className="st-kv st-kv--split">
            <div><dt>Preset</dt><dd>{state.preset ?? "—"}</dd></div>
            <div><dt>Messages</dt><dd>{cache}</dd></div>
          </dl>
        </section>
        <section className="st-panel" aria-labelledby="st-connection-title">
          <h2 className="st-kicker" id="st-connection-title">Connection</h2>
          <dl className="st-kv">
            <div><dt>Hub stage</dt><dd className="st-mono">{info?.stageUrl ?? "—"}</dd></div>
            <div><dt>Transport</dt><dd>{transport}</dd></div>
            {certificate && <div><dt>Certificate</dt><dd className="st-mono">{certificate}</dd></div>}
          </dl>
        </section>
      </div>

      <Monitor seats={state.seats} />
    </div>
  );
}
