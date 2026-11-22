import { hubPrefix } from "./paths.js";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { normalizeState, operatorFrame } from "./upstream/stage.mjs";
import { createAudioEngine } from "./upstream/phone-audio.mjs";
import { APP_TIMING } from "./upstream/phone-data.mjs";

const Hub = createContext(null);
export const useHub = () => useContext(Hub);
const initial = () => normalizeState(null);

export function HubProvider({ children }) {
  const [state, setState] = useState(initial);
  const [link, setLink] = useState("connecting");
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState("");
  const [monitor, setMonitor] = useState(null);
  const current = useRef(state);
  const socket = useRef(null);
  const listeners = useRef(new Set());
  const audio = useMemo(
    () =>
      createAudioEngine({
        volumes: { cue: 0.6, voice: 0.75 },
        timing: APP_TIMING,
        on_status: ({ key, text }) => {
          if (key === "playback" && text) setStatus(text);
        },
      }),
    [],
  );
  const transport = useMemo(() => {
    function send(frame) {
      const { hubId, sessionId } = current.current;
      if (!hubId || !sessionId || socket.current?.readyState !== WebSocket.OPEN)
        return false;
      try {
        socket.current.send(JSON.stringify({ ...frame, hubId, sessionId }));
        return true;
      } catch {
        return false;
      }
    }
    return {
      send,
      current,
      socket,
      subscribe(fn) {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      action(name, options) {
        const frame = operatorFrame(name, options);
        if (!frame) return false;
        if (name === "canned" || name === "replay") {
          audio.clear_session();
          void audio.unlock();
          void audio.preload_cues();
        }
        const sent = send(frame);
        setStatus(
          sent
            ? "Command sent."
            : "Hub offline. Reconnect to use the controls.",
        );
        return sent;
      },
    };
  }, [audio]);
  useEffect(() => {
    let mounted = true;
    let timer;
    let delay = 450;
    let controller;
    function connect() {
      const ws = new WebSocket(
        (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          hubPrefix +
          "/ws?role=stage",
      );
      socket.current = ws;
      ws.onopen = () => {
        if (!mounted || ws !== socket.current) return;
        delay = 450;
        controller = new AbortController();
        fetch(hubPrefix + "/info", {
          cache: "no-store",
          signal: controller.signal,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (mounted && ws === socket.current) setInfo(data);
          })
          .catch(() => {});
      };
      ws.onmessage = ({ data }) => {
        if (!mounted || ws !== socket.current) return;
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        const old = current.current;
        if (frame.type === "state") {
          const next = normalizeState(frame.state ?? frame);
          if (
            old.hubId !== next.hubId ||
            old.sessionId !== next.sessionId ||
            (old.canned && (!next.canned || old.startedAt !== next.startedAt))
          ) {
            audio.clear_session();
            setMonitor(null);
            setStatus("");
          }
          current.current = next;
          setState(next);
          setLink("online");
        } else {
          if (
            (frame.hubId && frame.hubId !== old.hubId) ||
            (frame.sessionId && frame.sessionId !== old.sessionId)
          )
            return;
          if (frame.type === "monitor") setMonitor(frame.monitor);
          if (
            frame.type === "audio" &&
            old.canned &&
            frame.url?.startsWith("/assets/")
          )
            audio.play({
              ...frame,
              key: undefined,
              url: hubPrefix + frame.url,
            });
          if (frame.type === "operator_ack" && !frame.accepted)
            setStatus(
              frame.reason === "microphone_owned"
                ? "Another stage has the microphone."
                : "The hub declined this command.",
            );
          if (frame.error) setStatus(String(frame.error));
        }
        for (const listen of listeners.current) listen(frame);
      };
      ws.onerror = () => {
        if (mounted) setLink("offline");
      };
      ws.onclose = () => {
        if (!mounted || socket.current !== ws) return;
        socket.current = null;
        controller?.abort();
        audio.clear_session();
        const empty = initial();
        current.current = empty;
        setState(empty);
        setLink("offline");
        setMonitor(null);
        setInfo(null);
        for (const listen of listeners.current) listen({ type: "disconnect" });
        timer = setTimeout(connect, delay);
        delay = Math.min(4000, delay * 1.7);
      };
    }
    connect();
    return () => {
      mounted = false;
      clearTimeout(timer);
      controller?.abort();
      socket.current?.close();
      socket.current = null;
      audio.clear_session();
    };
  }, [audio]);
  return (
    <Hub.Provider
      value={{ state, link, info, status, monitor, setStatus, ...transport }}
    >
      {children}
    </Hub.Provider>
  );
}
