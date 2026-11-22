import { useSyncExternalStore } from "react";
import {
  SIGNAL_LABELS, normalizeInfo, normalizeState, operatorFrame, revealSummary,
  type HubInfo, type HubState, type OperatorAction, type OperatorOptions, type RevealSummary,
} from "./model";
import { createCannedAudio } from "./cannedAudio";

export * from "./model";

export type HubStatus = "offline" | "connecting" | "online";
export type NoticeTone = "idle" | "sent" | "blocked";

export const HUB_BASE = "/hub";

export interface MonitorMeter { phase?: string; bars?: number[]; title?: string }
export interface MonitorSeat {
  name?: string;
  online?: boolean;
  source?: string | null;
  listening?: boolean;
  transcription?: string;
  input?: number[];
  output?: MonitorMeter;
  partial?: string;
  recentRuns?: { label: string; text: string }[];
  situation?: string;
  context?: { count?: number; excerpt?: string };
}
export interface MonitorSnapshot {
  agent?: { phase?: string; summary?: string; preset?: string; mode?: string };
  sharedRoom?: string | null;
  seats?: Record<string, MonitorSeat | undefined>;
}

export interface HubSnapshot {
  status: HubStatus;
  state: HubState;
  info: HubInfo | null;
  notice: { text: string; tone: NoticeTone };
}

export interface Hub extends HubSnapshot {
  summary: RevealSummary;
  send: (frame: object) => boolean;
  operate: (action: OperatorAction, options?: OperatorOptions) => boolean;
}

type Frame = Record<string, unknown>;
type FrameListener = (frame: Frame) => void;

let snapshot: HubSnapshot = {
  status: "connecting",
  state: normalizeState(null),
  info: null,
  notice: { text: "Standing by", tone: "idle" },
};
let monitor: MonitorSnapshot | null = null;
let socket: WebSocket | null = null;
let reconnectDelay = 600;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let users = 0;
const listeners = new Set<() => void>();
const monitorListeners = new Set<() => void>();
const frameListeners = new Set<FrameListener>();
const cannedAudio = createCannedAudio(HUB_BASE);

function update(patch: Partial<HubSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
}

function setMonitor(next: MonitorSnapshot | null) {
  monitor = next;
  monitorListeners.forEach(listener => listener());
}

export function setNotice(text: string, tone: NoticeTone = "idle") {
  update({ notice: { text, tone } });
}

const sameSession = (frame: Frame, state: HubState) =>
  (frame.hubId == null || frame.hubId === state.hubId) && (frame.sessionId == null || frame.sessionId === state.sessionId);

function handleFrame(frame: Frame) {
  const { state } = snapshot;
  if (frame.type === "monitor") {
    if ((state.hubId === null || frame.hubId === state.hubId) && (state.sessionId === null || frame.sessionId === state.sessionId)) {
      setMonitor((frame.monitor as MonitorSnapshot | undefined) ?? null);
    }
    return;
  }
  if (frame.type === "audio") {
    if (state.canned && typeof frame.url === "string" && sameSession(frame, state)) {
      cannedAudio.play(frame.url, typeof frame.cue === "string" ? frame.cue : null);
    }
    return;
  }
  if (frame.type === "state") {
    const raw = typeof frame.state === "object" && frame.state !== null ? { ...frame, ...(frame.state as Frame) } : frame;
    const next = normalizeState(raw);
    const changed = next.hubId !== state.hubId || next.sessionId !== state.sessionId;
    if (state.canned && (!next.canned || changed || next.startedAt !== state.startedAt)) cannedAudio.clear();
    if (changed) setMonitor(null);
    update({ state: next });
    frameListeners.forEach(listener => listener(frame));
    return;
  }
  frameListeners.forEach(listener => listener(frame));
  if (frame.type === "operator_ack") {
    if (!frame.accepted && frame.action !== "room_listen") setNotice("The take changed. Check the stage and try again.", "blocked");
    return;
  }
  if (frame.type === "room_ack") return;
  const detail = [frame.error, frame.detail, frame.message].find(value => typeof value === "string" && value.trim());
  if (typeof detail === "string") setNotice((typeof frame.type === "string" ? frame.type : "hub") + ": " + detail, "blocked");
}

async function loadInfo() {
  try {
    const response = await fetch(HUB_BASE + "/info", { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return;
    update({ info: normalizeInfo(await response.json()) });
  } catch { /* the stage still renders without the join address */ }
}

function connect() {
  clearTimeout(reconnectTimer);
  if (typeof window === "undefined") return;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  let next: WebSocket;
  try {
    next = new WebSocket(scheme + "//" + window.location.host + HUB_BASE + "/ws?role=stage");
  } catch {
    update({ status: "offline" });
    reconnectTimer = setTimeout(connect, reconnectDelay);
    return;
  }
  socket = next;
  if (snapshot.status !== "offline") update({ status: "connecting" });
  next.addEventListener("open", () => {
    if (socket !== next) return;
    reconnectDelay = 600;
    update({ status: "online" });
    void loadInfo();
  });
  next.addEventListener("message", event => {
    if (socket !== next) return;
    let frame: unknown;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    if (typeof frame === "object" && frame !== null && !Array.isArray(frame)) handleFrame(frame as Frame);
  });
  next.addEventListener("close", () => {
    if (socket !== next) return;
    socket = null;
    update({ status: "offline" });
    frameListeners.forEach(listener => listener({ type: "link_closed" }));
    reconnectDelay = Math.min(8000, Math.round(reconnectDelay * 1.6));
    reconnectTimer = setTimeout(connect, reconnectDelay);
  });
}

function disconnect() {
  clearTimeout(reconnectTimer);
  const current = socket;
  socket = null;
  current?.close();
  cannedAudio.clear();
}

function retain() {
  users += 1;
  clearTimeout(closeTimer);
  if (!socket && users === 1) connect();
  return () => {
    users -= 1;
    if (users > 0) return;
    closeTimer = setTimeout(() => { if (users === 0) disconnect(); }, 1500);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const release = retain();
  return () => { listeners.delete(listener); release(); };
}

function subscribeMonitor(listener: () => void) {
  monitorListeners.add(listener);
  const release = retain();
  return () => { monitorListeners.delete(listener); release(); };
}

export function onHubFrame(listener: FrameListener) {
  frameListeners.add(listener);
  return () => { frameListeners.delete(listener); };
}

export function hubSnapshot(): HubSnapshot {
  return snapshot;
}

export function sendFrame(frame: object): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const { hubId, sessionId } = snapshot.state;
  try {
    socket.send(JSON.stringify({ ...frame, hubId: hubId ?? undefined, sessionId: sessionId ?? undefined }));
    return true;
  } catch {
    return false;
  }
}

export function hubBufferedAmount(): number {
  return socket?.bufferedAmount ?? Infinity;
}

export function operate(action: OperatorAction, options?: OperatorOptions): boolean {
  const frame = operatorFrame(action, options);
  if (!frame) {
    setNotice("Nothing sent: " + action + " is missing a value", "blocked");
    return false;
  }
  if (action === "canned") cannedAudio.unlock();
  if (!sendFrame(frame)) {
    setNotice("Not sent: the hub is " + (snapshot.status === "connecting" ? "still connecting" : "offline"), "blocked");
    return false;
  }
  const detail = frame.preset ? " " + frame.preset : frame.signal ? " " + frame.seat + " " + (SIGNAL_LABELS[frame.signal] ?? frame.signal) : "";
  setNotice(action === "coach_ask" ? "Asked the pitch coach." : action === "coach_send" ? "Approved the cue." : "Sent " + action + detail, "sent");
  return true;
}

const summaries = new WeakMap<HubState, RevealSummary>();
function summaryOf(state: HubState): RevealSummary {
  let summary = summaries.get(state);
  if (!summary) {
    summary = revealSummary(state);
    summaries.set(state, summary);
  }
  return summary;
}

export function useHub(): Hub {
  const current = useSyncExternalStore(subscribe, hubSnapshot, hubSnapshot);
  return { ...current, summary: summaryOf(current.state), send: sendFrame, operate };
}

const monitorSnapshot = () => monitor;
export function useHubMonitor(): MonitorSnapshot | null {
  return useSyncExternalStore(subscribeMonitor, monitorSnapshot, monitorSnapshot);
}
