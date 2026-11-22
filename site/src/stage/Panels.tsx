import { useEffect, useRef, useState } from "react";
import { HUB_BASE, SEATS, sendFrame, useHubMonitor, type Hub, type MonitorSeat, type SeatKey, type SeatState } from "../hub/useHub";
import { onRoomLevel, selectMicrophone, startRoomMic, stopRoomMic, useRoomMic } from "../hub/roomMic";

const BAR_COUNT = 12;
const AUDIO_PHASE: Record<string, string> = { idle: "Quiet", queued: "Queued", playing: "Playing", paused: "Paused" };
const AGENT_PHASE: Record<string, string> = {
  idle: "Waiting for context", evaluating: "Reading context", drafting: "Preparing a cue", ready: "Context updated", error: "Review unavailable",
};
const TRANSCRIPTION_LABELS: Record<string, string> = {
  waiting: "Waiting for audio", connecting: "Connecting to transcription", live: "Transcribing the room",
  recovering: "Reconnecting transcription", unavailable: "Transcription unavailable. Check the ElevenLabs key and quota.",
  off: "Microphone is off",
};
const ANSWER_LABELS: Record<string, string> = {
  idle: "Listening for questions", researching: "Checking the conversation and references…",
  waiting: "Giving the conversation time to answer", answer: "Answer found", preview: "Private preview · awaiting approval",
  confirmed: "Approved for delivery", discarded: "Answer discarded", expired: "Approval expired",
  resolved: "Question answered or no longer relevant", unsupported: "No supported answer in these references",
  none: "No unanswered question", cancelled: "Previous answer cancelled as the conversation changed",
  already_offered: "Already offered this answer", unavailable: "Answer unavailable. Fixed whispers still work.",
};

function Bars({ values, label, state, active }: { values?: number[]; label: string; state: string; active: boolean }) {
  const samples = values?.slice(-BAR_COUNT) ?? [];
  return (
    <div className="st-meter" data-active={active}>
      <p><b>{label}</b><span>{state}</span></p>
      <div className="st-meter__wave" aria-hidden="true">
        {Array.from({ length: BAR_COUNT }, (_, index) => {
          const value = samples[index - BAR_COUNT + samples.length] ?? 0;
          const height = Math.min(1, Math.sqrt(Math.max(0, value)) * 1.7);
          return <i key={index} style={{ height: "max(2px, " + Math.round(height * 100) + "%)" }} />;
        })}
      </div>
    </div>
  );
}

export function SeatMeters({ seat, value, showRoom }: { seat: SeatKey; value?: MonitorSeat; showRoom: boolean }) {
  const micStatus = value?.listening
    ? value.transcription === "live" ? "Transcribing" : value.transcription === "unavailable" ? "Unavailable" : "Mic listening"
    : value?.online ? "Mic off" : "Waiting for seat";
  const context = [
    value?.context?.count ? value.context.count + (value.context.count === 1 ? " line read" : " lines read") : "",
    value?.situation,
  ].filter(Boolean).join(" · ");
  return (
    <div className="st-meters" data-seat={seat}>
      {showRoom && (
        <Bars label="Room input" values={value?.input} active={Boolean(value?.listening)}
          state={value?.source === "companion" && value.listening ? "Room mic · " + micStatus : micStatus} />
      )}
      <Bars label="Audio output" values={value?.output?.bars} active={value?.output?.phase === "playing"}
        state={AUDIO_PHASE[value?.output?.phase ?? "idle"] ?? "Quiet"} />
      {value?.output?.title && <p className="st-meters__line">{value.output.title}</p>}
      {showRoom && value?.partial && <p className="st-meters__line">Live · {value.partial}</p>}
      {showRoom && <p className="st-meters__line st-dim">{context || "No context update yet"}</p>}
      {showRoom && value?.context?.excerpt && <p className="st-meters__line st-dim">Context read · {value.context.excerpt}</p>}
    </div>
  );
}

export function useSeatMonitor() {
  const monitor = useHubMonitor();
  const agent = monitor?.agent;
  return {
    monitor,
    agentPhase: agent?.phase ?? "idle",
    agentLabel: AGENT_PHASE[agent?.phase ?? "idle"] ?? AGENT_PHASE.idle,
    agentDetail: [agent?.summary, agent?.preset, agent?.mode].filter(Boolean).join(" · ") || "Context agent standing by",
    showRoom: (seat: SeatKey) => monitor?.sharedRoom == null || monitor.sharedRoom === seat,
  };
}

export function Monitor({ seats }: { seats: Record<SeatKey, SeatState> }) {
  const view = useSeatMonitor();
  return (
    <section className="st-monitor" aria-label="Live audio and context" data-agent={view.agentPhase}>
      <header>
        <h2 className="st-kicker">Live monitor</h2>
        <p><b>{view.agentLabel}</b> {view.agentDetail}</p>
      </header>
      <div className="st-monitor__lanes">
        {SEATS.map(key => (
          <article key={key} data-seat={key}>
            <h3>Seat {key}{seats[key].name !== "Seat " + key ? " · " + seats[key].name : ""}</h3>
            <SeatMeters seat={key} value={view.monitor?.seats?.[key]} showRoom={view.showRoom(key)} />
          </article>
        ))}
      </div>
    </section>
  );
}

function LevelMeter() {
  const fill = useRef<HTMLElement>(null);
  useEffect(() => onRoomLevel(level => {
    if (fill.current) fill.current.style.transform = "scaleX(" + level.toFixed(3) + ")";
  }), []);
  return <div className="st-level" role="img" aria-label="Input level"><i ref={fill} /></div>;
}

export function RoomMicrophone({ hub }: { hub: Hub }) {
  const { state, status } = hub;
  const mic = useRoomMic();
  const online = status === "online";
  const presentation = state.phase === "reveal" || Boolean(state.canned);
  const otherTab = state.room.listeningRequested && !mic.wanted;
  const turns = state.room.transcript;
  const visible = state.phase === "reveal" ? turns : turns.slice(-12);
  const speakers = new Map<string, { label: string; seat?: string | null }>();
  for (const turn of turns) {
    if (turn.streamId !== state.room.speakerStream) continue;
    for (const run of turn.speakers ?? []) if (run.speaker) speakers.set(run.speaker, run);
  }
  const message = mic.message || (mic.starting ? "Allow microphone access in your browser…"
    : otherTab ? "Microphone controlled by another stage tab."
    : mic.wanted ? (TRANSCRIPTION_LABELS[state.room.transcription] ?? "Listening") + " · " + (mic.deviceLabel || "selected microphone")
    : "Microphone is off. Start it and allow browser access.");

  return (
    <section className="st-panel" id="room-microphone-panel" aria-labelledby="st-mic-title">
      <h2 className="st-kicker" id="st-mic-title">Room microphone</h2>
      <p className="st-panel__lede">
        Use this Mac’s microphone for the conversation. Phones handle whispers and approval; their room microphones stay off.
      </p>
      <label className="st-label" htmlFor="st-mic-device">Microphone input</label>
      <select className="st-control" id="st-mic-device" value={mic.deviceId} disabled={mic.wanted}
        onChange={event => selectMicrophone(event.target.value)}>
        <option value="">System default (choose MacBook Microphone in macOS Sound settings)</option>
        {mic.devices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
      </select>
      <div className="st-actions">
        <button className="st-button" type="button" disabled={mic.wanted || otherTab || !online || presentation}
          onClick={() => void startRoomMic()}>Start Mac microphone</button>
        <button className="st-button" type="button" disabled={!mic.wanted} onClick={() => stopRoomMic()}>Stop microphone</button>
      </div>
      <LevelMeter />
      <p className="st-status" role="status" aria-live="polite">{message}</p>
      <details className="st-details">
        <summary>Shared room transcript{turns.length ? " · " + turns.length : ""}</summary>
        {speakers.size > 0 && (
          <div className="st-speakers">
            {[...speakers].map(([speaker, run]) => (
              <label key={speaker}>
                {run.label}
                <select className="st-control" value={run.seat ?? ""} disabled={presentation}
                  onChange={event => sendFrame({
                    type: "operator", action: "room_speaker_assign", stream: state.room.speakerStream, speaker,
                    seat: event.target.value || null,
                  })}>
                  <option value="">Unassigned</option>
                  <option value="A">Seat A</option>
                  <option value="B">Seat B</option>
                </select>
              </label>
            ))}
          </div>
        )}
        <ul className="st-lines">
          {visible.flatMap((turn, index) => turn.speakers?.length
            ? turn.speakers.map((run, part) => <li key={index + ":" + part}><b>{run.label}</b> {run.text}</li>)
            : [<li key={index}>{turn.text}</li>])}
          {!visible.length && <li className="st-dim">Nothing transcribed yet.</li>}
        </ul>
        <button className="st-button" type="button" disabled={!turns.length || presentation || !online}
          onClick={() => sendFrame({ type: "operator", action: "room_transcript_clear" })}>Clear transcript</button>
      </details>
    </section>
  );
}

function readFile(file: File): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",")[1] ?? "" });
    reader.onerror = () => reject(new Error("Could not read " + file.name));
    reader.readAsDataURL(file);
  });
}

export function References({ hub }: { hub: Hub }) {
  const { state, status } = hub;
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const session = useRef(state);
  session.current = state;

  useEffect(() => {
    setMessage("");
    if (input.current) input.current.value = "";
  }, [state.hubId, state.sessionId]);

  const busy = uploading || state.referencesLoading;
  const editable = state.phase === "lobby" && status === "online" && !busy;

  async function upload(clear: boolean) {
    if (uploading || state.phase !== "lobby") return;
    const files = clear ? [] : Array.from(input.current?.files ?? []);
    if (!clear && !files.length) { setMessage("Choose at least one document first."); return; }
    if (files.length > 8 || files.some(file => file.size > 5 * 1024 * 1024)
      || files.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024) {
      setMessage("Limit: 8 documents, 5 MB per file and 8 MB total.");
      return;
    }
    const { sessionId, hubId } = state;
    const current = () => session.current.sessionId === sessionId && session.current.hubId === hubId;
    setUploading(true);
    setMessage("");
    try {
      const encoded = await Promise.all(files.map(readFile));
      const response = await fetch(HUB_BASE + "/references", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telepathy-hub": hubId ?? "", "x-telepathy-session": sessionId ?? "" },
        body: JSON.stringify({ files: encoded }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await response.json()) as { error?: string; documents?: unknown[] };
      if (!response.ok) throw new Error(result.error || "Upload failed.");
      if (current()) {
        setMessage(clear ? "Documents cleared." : (result.documents?.length ?? 0) + " document(s) loaded.");
        if (input.current) input.current.value = "";
      }
    } catch (error) {
      if (current()) setMessage(error instanceof Error && error.message ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const note = busy ? "Reading documents…" : [
    message,
    !state.questionAnswering
      ? "Document answering requires OPENAI_API_KEY and the OpenAI text provider. Fixed whispers and ordinary coaching remain available."
      : !message ? (state.references.length ? "References ready. Question answering starts with the session." : "No references loaded. Ordinary coaching remains available.") : "",
  ].filter(Boolean).join(" ");

  return (
    <section className="st-panel" id="reference-setup" aria-labelledby="st-ref-title">
      <h2 className="st-kicker" id="st-ref-title">Team brief and references</h2>
      <p className="st-panel__lede">
        Add documents so the coach can find supported answers to live questions. Answers are previewed privately and require a tap to send.
      </p>
      <label className="st-label" htmlFor="st-ref-files">Choose a brief and reference documents</label>
      <input className="st-file" id="st-ref-files" ref={input} type="file" multiple accept=".txt,.md,.pdf,.docx" disabled={!editable} />
      <div className="st-actions">
        <button className="st-button" type="button" disabled={!editable} onClick={() => void upload(false)}>Load selected documents</button>
        <button className="st-button" type="button" disabled={!editable || !state.references.length} onClick={() => void upload(true)}>Clear documents</button>
      </div>
      <p className="st-status" role="status" aria-live="polite">{note}</p>
      {state.references.length > 0 && (
        <ul className="st-lines">
          {state.references.map((item, index) => (
            <li key={item.id ?? index}><b>{item.name}</b> {item.characters.toLocaleString()} characters</li>
          ))}
        </ul>
      )}
      <p className="st-fine">
        TXT, Markdown, text-based PDF or DOCX. Up to 8 files, 5 MB each, 8 MB total. Uploading replaces the current set.
        Documents stay in hub memory until reset; relevant passages are sent to the configured OpenAI model when answering.
      </p>
    </section>
  );
}

export function Answers({ hub }: { hub: Hub }) {
  const { state } = hub;
  if (state.phase === "lobby" || !state.references.length) return null;
  const answer = state.questionState;
  return (
    <section className="st-panel" id="answer-panel" aria-labelledby="st-answer-title">
      <h2 className="st-kicker" id="st-answer-title">Conversation answers</h2>
      <p className="st-status" role="status" aria-live="polite">
        {!state.questionAnswering ? "Document answering is unavailable with the current text provider." : ANSWER_LABELS[answer.status] ?? "Listening"}
      </p>
      {answer.question && <p className="st-answer__question">Question: {answer.question}</p>}
      {answer.answer && <p className="st-answer__text">{answer.answer}</p>}
      {answer.sources.length > 0 && (
        <ul className="st-lines">
          {answer.sources.map((source, index) => <li key={index}><b>{source.name}</b> “{source.quote}”</li>)}
        </ul>
      )}
      <details className="st-details">
        <summary>Answer evidence from this session{state.answerHistory.length ? " · " + state.answerHistory.length : ""}</summary>
        <ul className="st-lines">
          {state.answerHistory.map(entry => (
            <li key={entry.key}>{entry.text} · {entry.sources.map(source => source.name + ": “" + source.quote + "”").join("; ")}</li>
          ))}
          {!state.answerHistory.length && <li className="st-dim">No answers yet.</li>}
        </ul>
      </details>
    </section>
  );
}
