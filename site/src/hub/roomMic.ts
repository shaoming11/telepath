import { useEffect, useSyncExternalStore } from "react";
import { HUB_BASE, hubBufferedAmount, hubSnapshot, onHubFrame, sendFrame } from "./useHub";

interface Capture {
  start: () => Promise<boolean>;
  stop: () => void;
  deviceLabel?: string;
}
interface CaptureModule {
  createCapture: (options: {
    get_context: () => AudioContext;
    frame_ms: () => number;
    get_constraints: () => MediaStreamConstraints;
    on_frame: (frame: object) => void;
    on_level: (level: number) => void;
    on_state: (state: string, detail?: string) => void;
  }) => Capture;
}

export interface RoomMicSnapshot {
  wanted: boolean;
  starting: boolean;
  accepted: boolean;
  message: string;
  deviceId: string;
  deviceLabel: string;
  devices: { id: string; label: string }[];
}

let snapshot: RoomMicSnapshot = {
  wanted: false, starting: false, accepted: false, message: "", deviceId: "", deviceLabel: "", devices: [],
};
let capture: Capture | null = null;
let context: AudioContext | null = null;
let wired = false;
const listeners = new Set<() => void>();
const levelListeners = new Set<(level: number) => void>();

function update(patch: Partial<RoomMicSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
}

const emitLevel = (level: number) => levelListeners.forEach(listener => listener(level));

async function loadCapture(): Promise<Capture> {
  if (capture) return capture;
  const module = (await import(/* @vite-ignore */ HUB_BASE + "/capture.mjs")) as CaptureModule;
  capture = module.createCapture({
    get_context: () => (context ??= new AudioContext()),
    frame_ms: () => 250,
    get_constraints: () => ({
      audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(snapshot.deviceId ? { deviceId: { exact: snapshot.deviceId } } : {}),
      },
    }),
    on_frame: frame => {
      if (snapshot.wanted && hubSnapshot().state.room.listening && hubBufferedAmount() < 256_000) sendFrame({ type: "room_mic", ...frame });
    },
    on_level: level => emitLevel(Math.min(1, Math.max(0, level * 5))),
    on_state: (next, detail) => {
      if (["blocked", "unsupported", "error", "lost"].includes(next)) {
        update({ message: detail || "Microphone unavailable." });
        stopRoomMic();
      }
    },
  });
  return capture;
}

export function stopRoomMic(notify = true) {
  const wasWanted = snapshot.wanted;
  update({ wanted: false, starting: false, accepted: false });
  capture?.stop();
  emitLevel(0);
  if (notify && wasWanted) sendFrame({ type: "operator", action: "room_listen", enabled: false });
}

export async function refreshMicrophones() {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices();
    update({
      devices: (devices ?? []).filter(device => device.kind === "audioinput" && device.deviceId)
        .map((device, index) => ({ id: device.deviceId, label: device.label || "Microphone " + (index + 1) })),
    });
  } catch { /* the system default stays selectable */ }
}

export function selectMicrophone(deviceId: string) {
  if (!snapshot.wanted) update({ deviceId });
}

export async function startRoomMic() {
  const hub = hubSnapshot();
  if (snapshot.wanted || hub.status !== "online" || hub.state.phase === "reveal" || hub.state.canned) return;
  const { sessionId, hubId } = hub.state;
  update({ wanted: true, starting: true, message: "" });
  try {
    const recorder = await loadCapture();
    const opened = await recorder.start();
    const now = hubSnapshot().state;
    if (!opened || !snapshot.wanted || now.sessionId !== sessionId || now.hubId !== hubId) {
      stopRoomMic(false);
      return;
    }
    update({ deviceLabel: recorder.deviceLabel ?? "" });
    if (!sendFrame({ type: "operator", action: "room_listen", enabled: true })) {
      update({ message: "Hub disconnected. Reconnect and start the microphone again." });
      stopRoomMic(false);
    }
    await refreshMicrophones();
  } catch {
    update({ message: "Could not open the microphone. Check browser and macOS microphone permissions." });
    stopRoomMic();
  } finally {
    update({ starting: false });
  }
}

function wire() {
  if (wired) return;
  wired = true;
  let last = hubSnapshot().state;
  onHubFrame(frame => {
    if (frame.type === "link_closed") { stopRoomMic(false); return; }
    if (frame.type === "state") {
      const next = hubSnapshot().state;
      if (next.hubId !== last.hubId || next.sessionId !== last.sessionId || next.phase === "reveal" || next.canned
        || (snapshot.accepted && !next.room.listeningRequested)) stopRoomMic(false);
      last = next;
      return;
    }
    if (frame.type === "operator_ack" && !frame.accepted && frame.action === "room_listen") {
      update({ message: frame.reason === "microphone_owned" ? "Another stage tab is using the room microphone." : "The session changed. Start the microphone again." });
      stopRoomMic(false);
      return;
    }
    if (frame.type === "room_ack" && frame.sessionId === last.sessionId && frame.hubId === last.hubId) {
      if (frame.listening === true) update({ accepted: snapshot.wanted });
      else if (snapshot.wanted) {
        update({ message: "Transcription unavailable. Check the ElevenLabs key and quota, then try again." });
        stopRoomMic(false);
      }
    }
  });
  window.addEventListener("beforeunload", () => { stopRoomMic(); void context?.close(); });
  void refreshMicrophones();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const read = () => snapshot;

export function useRoomMic(): RoomMicSnapshot {
  useEffect(wire, []);
  return useSyncExternalStore(subscribe, read, read);
}

export function onRoomLevel(listener: (level: number) => void) {
  levelListeners.add(listener);
  return () => { levelListeners.delete(listener); };
}
