import { hubPrefix } from "./paths.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useHub } from "./transport.jsx";
import { createCapture } from "./upstream/capture.mjs";
import { roomConsoleStatus } from "./upstream/stage.mjs";

export function RoomConsole() {
  const { state, link, send, socket, current, subscribe } = useHub();
  const [devices, setDevices] = useState([]),
    [device, setDevice] = useState("");
  const [message, setMessage] = useState(""),
    [mode, setMode] = useState("off"),
    [level, setLevel] = useState(0);
  const capture = useRef(null),
    context = useRef(null),
    attempt = useRef(0),
    wanted = useRef(false),
    accepted = useRef(false);
  const refresh = useCallback(async () => {
    try {
      setDevices(
        ((await navigator.mediaDevices?.enumerateDevices()) || []).filter(
          (x) => x.kind === "audioinput" && x.deviceId,
        ),
      );
    } catch {}
  }, []);
  const stop = useCallback(
    (notify = true) => {
      ++attempt.current;
      const was = wanted.current;
      wanted.current = false;
      accepted.current = false;
      capture.current?.stop();
      capture.current = null;
      setMode("off");
      setLevel(0);
      if (was && notify)
        send({ type: "operator", action: "room_listen", enabled: false });
    },
    [send],
  );
  useEffect(() => {
    const roomScope = current.current;
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    const cleanup = subscribe((frame) => {
      if (
        frame.type === "disconnect" ||
        (frame.type === "state" &&
          (current.current.phase === "reveal" ||
            current.current.canned ||
            (accepted.current && !current.current.room.listeningRequested)))
      )
        stop(false);
      if (
        frame.type === "operator_ack" &&
        frame.action === "room_listen" &&
        !frame.accepted
      ) {
        stop(false);
        setMessage(
          frame.reason === "microphone_owned"
            ? "Another stage has the microphone."
            : "The session changed.",
        );
      }
      if (frame.type === "room_ack" && wanted.current) {
        accepted.current = frame.listening === true;
        if (!accepted.current) {
          stop(false);
          setMessage(
            "Transcription unavailable. Check the configured speech provider.",
          );
        }
      }
    });
    return () => {
      cleanup();
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      stop(
        roomScope.hubId === current.current.hubId &&
          roomScope.sessionId === current.current.sessionId,
      );
      void context.current?.close();
      context.current = null;
    };
  }, [refresh, subscribe, stop, current]);
  async function start() {
    if (wanted.current || link !== "online") return;
    const token = ++attempt.current;
    const scope = current.current;
    wanted.current = true;
    setMode("starting");
    setMessage("");
    try {
      context.current ||= new (
        window.AudioContext || window.webkitAudioContext
      )();
      capture.current = createCapture({
        get_context: () => context.current,
        frame_ms: () => 250,
        get_constraints: () => ({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(device ? { deviceId: { exact: device } } : {}),
          },
        }),
        on_level: setLevel,
        on_frame: (frame) => {
          if (
            wanted.current &&
            current.current.room.listening &&
            socket.current?.bufferedAmount < 256000
          )
            send({ type: "room_mic", ...frame });
        },
        on_state: (stage, detail) => {
          if (token !== attempt.current) return;
          if (["blocked", "unsupported", "error", "lost"].includes(stage)) {
            setMessage(detail || "Microphone unavailable.");
            stop();
          } else if (stage === "interrupted") {
            setMode("interrupted");
            setLevel(0);
          } else if (stage === "streaming") setMode("active");
        },
      });
      const ok = await capture.current.start();
      if (token !== attempt.current) return;
      if (
        !ok ||
        current.current.hubId !== scope.hubId ||
        current.current.sessionId !== scope.sessionId ||
        !send({ type: "operator", action: "room_listen", enabled: true })
      ) {
        stop(false);
        return;
      }
      setMode("active");
      void refresh();
    } catch {
      if (token === attempt.current) {
        setMessage("Could not open the selected microphone.");
        stop();
      }
    }
  }
  const room = state.room,
    turns = room.transcript || [];
  const other = room.listeningRequested && !wanted.current;
  const canEdit =
    link === "online" && state.phase !== "reveal" && !state.canned;
  const status = roomConsoleStatus({
    link: link === "online" ? "live" : link,
    phase: state.phase,
    canned: state.canned,
    ownedElsewhere: other,
    starting: mode === "starting",
    interrupted: mode === "interrupted",
    wanted: wanted.current,
    transcription: room.transcription,
    message,
    device: capture.current?.deviceLabel,
  });
  const speakers = new Map(
    turns
      .filter((x) => x.streamId === room.speakerStream)
      .flatMap((x) => x.speakers || [])
      .filter((x) => x.speaker)
      .map((x) => [x.speaker, x]),
  );
  return (
    <section className="panel">
      <h2>Room microphone</h2>
      <div className="row">
        <label>
          Input device
          <select
            value={device}
            disabled={wanted.current}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">System default</option>
            {devices.map((x, i) => (
              <option key={x.deviceId} value={x.deviceId}>
                {x.label || "Microphone " + (i + 1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Input level
          <meter value={level} min="0" max="1" />
        </label>
      </div>
      {wanted.current ? (
        <button
          onClick={() => {
            setMessage("");
            stop();
          }}
        >
          Stop listening
        </button>
      ) : (
        <button disabled={!canEdit || other} onClick={start}>
          Start listening
        </button>
      )}
      <p role="status">
        {status.label} · {status.detail}
      </p>
      <details>
        <summary>
          Room transcript <span>{turns.length}</span>
        </summary>
        <ul>
          {(state.phase === "reveal" ? turns : turns.slice(-12)).flatMap(
            (turn, i) =>
              (turn.speakers?.length
                ? turn.speakers
                : [{ label: "Room", text: turn.text }]
              ).map((run, j) => (
                <li key={i + "-" + j}>
                  <strong>{run.label}</strong> {run.text}
                </li>
              )),
          )}
        </ul>
        {!turns.length && <p>Waiting for speech.</p>}
        {canEdit && turns.length > 0 && (
          <button
            onClick={() =>
              send({ type: "operator", action: "room_transcript_clear" })
            }
          >
            Clear transcript
          </button>
        )}
        {canEdit &&
          [...speakers].map(([id, run]) => (
            <label key={id}>
              {run.label}
              <select
                value={run.seat || ""}
                onChange={(e) =>
                  send({
                    type: "operator",
                    action: "room_speaker_assign",
                    stream: room.speakerStream,
                    speaker: id,
                    seat: e.target.value || null,
                  })
                }
              >
                <option value="">Unassigned</option>
                <option value="A">Seat A</option>
                <option value="B">Seat B</option>
              </select>
            </label>
          ))}
      </details>
    </section>
  );
}

export function References() {
  const { state, link } = useHub();
  const file = useRef(null),
    request = useRef(null);
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => () => request.current?.abort(), []);
  async function upload(clear) {
    const files = clear ? [] : Array.from(file.current.files);
    if (!clear && !files.length) {
      setNote("Choose a document first.");
      return;
    }
    if (
      files.length > 8 ||
      files.some((x) => x.size > 5242880) ||
      files.reduce((n, x) => n + x.size, 0) > 8388608
    ) {
      setNote("Choose up to eight documents, 5 MB each and 8 MB total.");
      return;
    }
    const control = new AbortController();
    request.current = control;
    setBusy(true);
    setNote("");
    const timer = setTimeout(() => control.abort(), 30000);
    try {
      const encoded = await Promise.all(
        files.map(
          (f) =>
            new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onerror = () => reject(Error("Could not read " + f.name));
              r.onload = () =>
                resolve({ name: f.name, data: String(r.result).split(",")[1] });
              r.readAsDataURL(f);
            }),
        ),
      );
      const response = await fetch(hubPrefix + "/references", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telepathy-hub": state.hubId,
          "x-telepathy-session": state.sessionId,
        },
        body: JSON.stringify({ files: encoded }),
        signal: control.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "Could not load documents.");
      setNote(clear ? "Documents cleared." : "Documents ready.");
      if (file.current) file.current.value = "";
    } catch (err) {
      setNote(err.message);
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }
  const disabled =
    link !== "online" ||
    state.phase !== "lobby" ||
    busy ||
    state.referencesLoading;
  return (
    <section className="panel" id="reference-setup">
      <h2>Team brief &amp; references</h2>
      <p>
        Load TXT, Markdown, text-based PDF or DOCX. When document answering is
        enabled, relevant passages go to the configured model.
      </p>
      <label>
        Reference documents
        <input
          ref={file}
          type="file"
          accept=".md,.txt,.pdf,.docx"
          multiple
          disabled={disabled}
        />
      </label>
      <div className="buttons">
        <button disabled={disabled} onClick={() => upload(false)}>
          Load documents
        </button>
        <button
          disabled={disabled || !state.references.length}
          onClick={() => upload(true)}
        >
          Clear documents
        </button>
      </div>
      <p role="status">
        {busy
          ? "Reading documents…"
          : note ||
            (state.questionAnswering
              ? "Document answering available."
              : "Document answering is unavailable in this session.")}
      </p>
      <ul>
        {state.references.map((r, i) => (
          <li key={i}>
            {r.name} · {r.characters?.toLocaleString()} characters
          </li>
        ))}
      </ul>
    </section>
  );
}
