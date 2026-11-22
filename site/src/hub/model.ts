export type Phase = "lobby" | "live" | "reveal";
export type SeatKey = "A" | "B";
export type Tone = "ok" | "wait" | "flag";

export const SEATS: readonly SeatKey[] = ["A", "B"];
export const PHASES: readonly Phase[] = ["lobby", "live", "reveal"];
export const SIGNALS = ["R1", "R2", "L1", "L2", "LR", "OUT", "BACK"] as const;
export const PRESETS = ["Pitch", "Party", "Meeting", "Custom"] as const;
export const FIXED_SIGNALS = ["R1", "R2", "L1", "OUT"] as const;
export const PITCH_BEATS = ["opening", "problem", "demo", "closing"] as const;
export type PitchBeat = (typeof PITCH_BEATS)[number];
export const PITCH_BEAT_LABELS: Record<PitchBeat, string> = {
  opening: "Opening", problem: "Problem", demo: "Working demo", closing: "Closing",
};
const COACH_STATUSES = ["idle", "asking", "ready", "sent"] as const;
type CoachStatus = (typeof COACH_STATUSES)[number];
const COACH_SOURCES: Record<string, string> = {
  maritime: "Maritime agent",
  "maritime-assisted": "Maritime · OpenAI-assisted",
  "maritime-rules": "Maritime rules fallback",
  local: "Local fallback",
};

export const SIGNAL_LABELS: Record<string, string> = {
  R1: "Single", R2: "Double", L1: "Triple", L2: "Read codebook", LR: "Ask assistant", OUT: "Out", BACK: "Back",
};
export const SIGNAL_ROLES: Record<string, string> = {
  R1: "fixed 1 · confirms a draft",
  R2: "fixed 2",
  L1: "fixed 3 · discards a draft",
  L2: "hear the codebook",
  LR: "ask for a smart message",
  OUT: "earbud out · urgent",
  BACK: "earbud back",
};
export const KIND_LABELS: Record<string, string> = {
  signal: "signal", draft: "draft", message: "message", receipt: "receipt",
  error: "error", system: "system", preset: "preset", canned: "canned",
  discard: "discarded", expire: "expired", situation: "situation", preview_playback: "preview playback",
  confirm: "confirmed", preset_suggestion: "suggestion", replay: "replay",
  back: "earbud back", cache_error: "cache error", announcement: "announcement",
  answer_evidence: "answer evidence",
};

export const ANNOUNCEMENT_MAX_LENGTH = 140;
export const OPERATOR_ANNOUNCEMENTS = [
  { id: "sound-check", label: "Sound check", text: "Sound check. Can you hear me?" },
  { id: "demo-cue", label: "Go to the working demo", text: "Show the working demo now." },
  { id: "time-cue", label: "Thirty seconds left", text: "Thirty seconds left." },
  { id: "reveal-cue", label: "Bring up the reveal", text: "Time to bring up the reveal." },
] as const;

export function announcementText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, ANNOUNCEMENT_MAX_LENGTH) : "";
}

export interface HubEvent {
  id: string | null;
  kind: string | null;
  seat: string | null;
  to: string | null;
  signal: string | null;
  text: string | null;
  at: number | null;
  expiresAt: number | null;
  heardAt: number | null;
  bits: number | null;
  playedAt: number | null;
  latencyMs: number | null;
  canned: boolean;
  urgent: boolean;
}
export interface LogEntry extends HubEvent { key: string }
export interface TranscriptLine { at: number | null; text: string }
export interface SeatState {
  key: SeatKey;
  name: string;
  online: boolean;
  sim: boolean;
  mode: number | null;
  drafts: boolean | null;
  listening: boolean | null;
  transcription: string | null;
  voice: string | null;
  earbuds: { done: boolean | null; label: string | null };
  calibrated: boolean | null;
  ready: boolean | null;
  situation: string | null;
  transcript: TranscriptLine[];
  pending: HubEvent | null;
  lastIn: HubEvent | null;
  lastOut: HubEvent | null;
}
export interface SpeakerRun { speaker?: string; label: string; text: string; seat?: string | null }
export interface RoomTurn { text: string; streamId?: number; speakers?: SpeakerRun[] }
export interface RoomState {
  listening: boolean;
  listeningRequested: boolean;
  transcription: string;
  level: number;
  transcript: RoomTurn[];
  speakerStream: number | null;
}
export interface AnnouncementState {
  id: string | null;
  text: string | null;
  status: string | null;
  targets: string[];
  heard: string[];
  reason: string | null;
}
export interface CoachState {
  available: boolean;
  status: CoachStatus;
  beat: PitchBeat | null;
  id: string | null;
  text: string | null;
  reason: string | null;
  source: string | null;
  announcementId: string | null;
}
export interface ReferenceDoc { id: string | null; name: string; characters: number }
export interface AnswerSource { name: string; quote: string }
export interface QuestionState { status: string; question: string | null; answer: string | null; sources: AnswerSource[] }
export interface AnswerEvidence { key: string; text: string; sources: AnswerSource[] }
export interface CannedState { active: true; label: string | null; at: number | null }

export interface HubState {
  phase: Phase;
  hubId: string | null;
  sessionId: string | null;
  cacheId: string | null;
  preset: string | null;
  presetPending: string | null;
  context: string | null;
  canBegin: boolean | null;
  bits: number | null;
  startedAt: number | null;
  canned: CannedState | null;
  announcement: AnnouncementState | null;
  references: ReferenceDoc[];
  referencesLoading: boolean;
  questionAnswering: boolean;
  questionState: QuestionState;
  roomInput: string;
  room: RoomState;
  answerHistory: AnswerEvidence[];
  coach: CoachState | null;
  codebook: Record<string, string>;
  seats: Record<SeatKey, SeatState>;
  log: LogEntry[];
}

export interface HubInfo {
  joinUrl: string | null;
  stageUrl: string | null;
  certificateUrl: string | null;
  secure: boolean | null;
  lanAvailable: boolean | null;
}

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}
function asNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}
function asBool(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}
function seatKey(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const upper = text.toUpperCase();
  return upper === "A" || upper === "B" ? upper : upper.slice(0, 6);
}
export const isSeat = (value: unknown): value is SeatKey => value === "A" || value === "B";

function normalizeEvent(value: unknown): HubEvent | null {
  const blank: HubEvent = {
    id: null, kind: null, seat: null, to: null, signal: null, text: null, at: null, expiresAt: null,
    heardAt: null, bits: null, playedAt: null, latencyMs: null, canned: false, urgent: false,
  };
  if (value === true) return blank;
  if (typeof value === "string") {
    const text = asText(value);
    return text ? { ...blank, text } : null;
  }
  if (!isObject(value)) return null;
  const signal = firstText(value.signal);
  const source = firstText(value.source, value.via, value.origin);
  return {
    id: firstText(value.id, value.messageId),
    kind: firstText(value.kind, value.type),
    seat: seatKey(value.seat ?? value.from),
    to: seatKey(value.to),
    signal,
    text: firstText(value.text, value.message, value.meaning, value.label, value.detail),
    at: asNumber(value.at ?? value.time),
    expiresAt: asNumber(value.expiresAt),
    heardAt: asNumber(value.heardAt),
    bits: asNumber(value.bits),
    playedAt: asNumber(value.playedAt),
    latencyMs: typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) ? value.latencyMs : null,
    canned: value.canned === true || source === "canned",
    urgent: signal === "OUT" || firstText(value.cue) === "urgent",
  };
}

function normalizeCanned(value: unknown): CannedState | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return { active: true, label: null, at: null };
  const text = asText(value);
  if (text) return { active: true, label: text, at: null };
  if (!isObject(value)) return null;
  const described: CannedState = {
    active: true,
    label: firstText(value.label, value.name, value.take, value.id, value.text),
    at: asNumber(value.at ?? value.startedAt),
  };
  for (const flag of ["active", "playing", "running", "started", "enabled"]) {
    if (typeof value[flag] === "boolean") return value[flag] ? described : null;
  }
  if (typeof value.available === "boolean" || typeof value.ready === "boolean") return null;
  return described;
}

function normalizeCodebook(value: unknown, preset: string | null): Record<string, string> {
  const book: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isObject(item)) continue;
      const signal = firstText(item.signal, item.key);
      const meaning = firstText(item.meaning, item.text, item.message);
      if (signal && meaning) book[signal] = meaning;
    }
    return book;
  }
  if (!isObject(value)) return book;
  let source: Raw = value;
  const nestedPreset = preset ? value[preset] : null;
  if (isObject(nestedPreset)) source = nestedPreset;
  else if (!SIGNALS.some(signal => signal in value)) {
    const nested = Object.values(value).find(isObject);
    if (nested) source = nested;
  }
  for (const [signal, meaning] of Object.entries(source)) {
    const text = typeof meaning === "string" ? asText(meaning)
      : isObject(meaning) ? firstText(meaning.meaning, meaning.text, meaning.message) : null;
    if (text) book[signal] = text;
  }
  return book;
}

function normalizePresetPending(value: unknown): string | null {
  if (value === true) return "pending";
  const text = asText(value);
  if (text) return text;
  if (isObject(value)) return firstText(value.preset, value.to, value.next, value.label);
  return null;
}

function normalizeSeat(key: SeatKey, value: unknown, onlineMap: Raw): SeatState {
  const seat = isObject(value) ? value : {};
  return {
    key,
    name: firstText(seat.name) ?? "Seat " + key,
    online: asBool(seat.online) ?? asBool(onlineMap[key]) ?? false,
    sim: asBool(seat.sim) ?? false,
    mode: asNumber(seat.mode),
    drafts: asBool(seat.drafts),
    listening: asBool(seat.listening),
    transcription: firstText(seat.transcription),
    voice: firstText(seat.voice),
    earbuds: { done: asBool(seat.earbuds), label: typeof seat.earbuds === "string" ? asText(seat.earbuds) : null },
    calibrated: asBool(seat.calibrated),
    ready: asBool(seat.ready),
    situation: firstText(seat.situation),
    transcript: asList(seat.transcript)
      .map(line => ({ at: isObject(line) ? asNumber(line.at) : null, text: firstText(isObject(line) ? line.text : null, line) }))
      .filter((line): line is TranscriptLine => Boolean(line.text)),
    pending: normalizeEvent(seat.pending),
    lastIn: normalizeEvent(seat.lastIn),
    lastOut: normalizeEvent(seat.lastOut),
  };
}

function normalizeCoach(value: unknown): CoachState | null {
  if (!isObject(value)) return null;
  const status = COACH_STATUSES.find(item => item === value.status) ?? "idle";
  return {
    available: value.available === true,
    status,
    beat: PITCH_BEATS.find(item => item === value.beat) ?? null,
    id: firstText(value.id),
    text: firstText(value.text),
    reason: firstText(value.reason),
    source: typeof value.source === "string" && Object.hasOwn(COACH_SOURCES, value.source) ? value.source : null,
    announcementId: firstText(value.announcementId),
  };
}

function normalizeSources(value: unknown): AnswerSource[] {
  return asList(value).filter(isObject).map(source => ({
    name: firstText(source.name) ?? "Reference", quote: firstText(source.quote) ?? "",
  }));
}

function normalizeRoom(value: unknown): RoomState {
  const room = isObject(value) ? value : {};
  return {
    listening: room.listening === true,
    listeningRequested: room.listeningRequested === true,
    transcription: firstText(room.transcription) ?? "off",
    level: asNumber(room.level) ?? 0,
    speakerStream: asNumber(room.speakerStream),
    transcript: asList(room.transcript).filter(isObject).map(turn => ({
      text: firstText(turn.text) ?? "",
      streamId: asNumber(turn.streamId) ?? undefined,
      speakers: asList(turn.speakers).filter(isObject).map(run => ({
        speaker: firstText(run.speaker) ?? undefined,
        label: firstText(run.label) ?? "Speaker",
        text: firstText(run.text) ?? "",
        seat: firstText(run.seat),
      })),
    })),
  };
}

export function normalizeState(raw: unknown): HubState {
  const source = isObject(raw) ? raw : {};
  const onlineMap = isObject(source.online) ? source.online : {};
  const seatsRaw = isObject(source.seats) ? source.seats : {};
  const preset = firstText(source.preset);
  const log: LogEntry[] = [];
  asList(source.log).forEach(entry => {
    const event = normalizeEvent(entry);
    if (event && (event.kind || event.text || event.signal)) log.push({ ...event, key: event.id ?? "index:" + log.length });
  });
  const announcement = isObject(source.announcement) ? source.announcement : null;
  const question = isObject(source.questionState) ? source.questionState : {};
  return {
    phase: PHASES.find(phase => phase === source.phase) ?? "lobby",
    hubId: firstText(source.hubId),
    sessionId: firstText(source.sessionId, source.id),
    cacheId: firstText(source.cacheId, source.activeId),
    preset,
    presetPending: normalizePresetPending(source.presetPending),
    context: firstText(source.context),
    canBegin: asBool(source.canBegin),
    bits: asNumber(source.bits),
    startedAt: asNumber(source.startedAt),
    canned: normalizeCanned(source.canned),
    announcement: announcement && {
      id: firstText(announcement.id),
      text: firstText(announcement.text),
      status: firstText(announcement.status),
      targets: asList(announcement.targets).filter((seat): seat is string => typeof seat === "string"),
      heard: asList(announcement.heard).filter((seat): seat is string => typeof seat === "string"),
      reason: firstText(announcement.reason),
    },
    references: asList(source.references).filter(isObject).map(item => ({
      id: firstText(item.id), name: firstText(item.name) ?? "Document", characters: asNumber(item.characters) ?? 0,
    })),
    referencesLoading: source.referencesLoading === true,
    questionAnswering: source.questionAnswering === true,
    questionState: {
      status: firstText(question.status) ?? "idle",
      question: firstText(question.question),
      answer: firstText(question.answer),
      sources: normalizeSources(question.sources),
    },
    roomInput: firstText(source.roomInput) ?? "phones",
    room: normalizeRoom(source.room),
    answerHistory: asList(source.log).filter(isObject).filter(entry => entry.kind === "answer_evidence")
      .map((entry, index) => ({ key: firstText(entry.id) ?? "answer:" + index, text: firstText(entry.text) ?? "", sources: normalizeSources(entry.sources) })),
    coach: normalizeCoach(source.coach),
    codebook: normalizeCodebook(source.codebook, preset),
    seats: { A: normalizeSeat("A", seatsRaw.A, onlineMap), B: normalizeSeat("B", seatsRaw.B, onlineMap) },
    log,
  };
}

export function normalizeInfo(raw: unknown): HubInfo | null {
  if (!isObject(raw)) return null;
  return {
    joinUrl: firstText(raw.joinUrl),
    stageUrl: firstText(raw.stageUrl),
    certificateUrl: firstText(raw.certificateUrl),
    secure: asBool(raw.secure),
    lanAvailable: asBool(raw.lanAvailable),
  };
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const countWords = (text: string | null) => text?.match(WORD)?.length ?? 0;

export function formatOffset(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--:--";
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return String(minutes).padStart(2, "0") + ":" + seconds;
  return String(Math.floor(minutes / 60)) + ":" + String(minutes % 60).padStart(2, "0") + ":" + seconds;
}

export function timelineBase(state: HubState): number | null {
  if (state.startedAt !== null) return state.startedAt;
  const times = state.log.map(entry => entry.at).filter((at): at is number => at !== null);
  return times.length ? Math.min(...times) : null;
}

export function offsetFrom(base: number | null, at: number | null): number | null {
  return base === null || at === null ? null : Math.max(0, at - base);
}

export interface TimelineRow extends LogEntry { offsetMs: number | null; offsetLabel: string; position: number }

export function timelineRows(state: HubState): TimelineRow[] {
  const messages = state.log.filter(entry => entry.kind === "message");
  const rows = messages.length ? messages : state.log.filter(entry => entry.text || entry.signal);
  const base = timelineBase(state);
  const times = rows.map(entry => entry.at).filter((at): at is number => at !== null);
  const span = times.length && base !== null ? Math.max(...times) - base : 0;
  return rows.map((entry, index) => {
    const offsetMs = offsetFrom(base, entry.at);
    const fallback = rows.length > 1 ? index / (rows.length - 1) : 0;
    const ratio = span > 0 && offsetMs !== null ? offsetMs / span : fallback;
    return { ...entry, offsetMs, offsetLabel: formatOffset(offsetMs), position: Math.min(1, Math.max(0, ratio)) };
  });
}

export interface RevealSummary {
  messages: number;
  words: number;
  playbackStarts: number;
  bits: number | null;
  durationMs: number | null;
}

export function revealSummary(state: HubState): RevealSummary {
  const messages = state.log.filter(entry => entry.kind === "message");
  const base = timelineBase(state);
  const times = state.log.map(entry => entry.at).filter((at): at is number => at !== null);
  const span = base !== null && times.length ? Math.max(...times) - base : null;
  return {
    messages: messages.length,
    words: messages.reduce((sum, entry) => sum + countWords(entry.text), 0),
    playbackStarts: messages.filter(entry => entry.playedAt !== null).length,
    bits: state.bits === null ? null : Math.round(state.bits * 100) / 100,
    durationMs: span && span > 0 ? span : null,
  };
}

export type OperatorAction =
  | "begin" | "preset" | "inject" | "replay" | "canned" | "reset" | "reveal" | "announce" | "coach_ask" | "coach_send";
export interface OperatorOptions {
  preset?: string;
  context?: string;
  seat?: string;
  signal?: string;
  text?: string;
  beat?: string;
  coachId?: string | null;
}

export function operatorFrame(action: OperatorAction, options: OperatorOptions = {}): Record<string, string> | null {
  const frame: Record<string, string> = { type: "operator", action };
  if (action === "preset") {
    const preset = firstText(options.preset);
    if (!preset) return null;
    frame.preset = preset;
    const context = firstText(options.context);
    if (context) frame.context = context;
  }
  if (action === "inject") {
    const seat = seatKey(options.seat);
    const signal = firstText(options.signal);
    if (!seat || !signal || !FIXED_SIGNALS.some(item => item === signal)) return null;
    frame.seat = seat;
    frame.signal = signal;
  }
  if (action === "announce") {
    const text = announcementText(options.text);
    if (!text) return null;
    frame.text = text;
  }
  if (action === "coach_ask") {
    if (!PITCH_BEATS.some(beat => beat === options.beat)) return null;
    frame.beat = options.beat as string;
  }
  if (action === "coach_send") {
    const id = typeof options.coachId === "string" ? asText(options.coachId) : null;
    if (!id) return null;
    frame.coachId = id;
  }
  return frame;
}

export function joinGuidance(info: HubInfo | null): string | null {
  if (!info) return null;
  let scheme: string | null = null;
  let host: string | null = null;
  if (info.joinUrl) {
    try {
      const url = new URL(info.joinUrl);
      scheme = url.protocol.replace(":", "");
      host = url.hostname.replace(/^\[|\]$/g, "");
    } catch { /* a hand-typed address is still worth showing */ }
  }
  if (info.secure === true || scheme === "wss" || scheme === "https") {
    return info.certificateUrl
      ? "Served with a local certificate. Install it on each phone once from " + info.certificateUrl + ", then open the join address and the microphone works."
      : "Served with a local certificate. Each phone has to accept the certificate warning once; after that the microphone opens normally.";
  }
  if (info.secure === false || scheme === "ws" || scheme === "http") {
    if (host && ["localhost", "127.0.0.1", "::1"].includes(host)) return null;
    return "Insecure origin at " + (host ?? "this address") + ". Browsers only open the microphone on a secure origin or on localhost, so start the hub with local TLS and share that address with the phones.";
  }
  return null;
}

export function roomStatus(seat: SeatState): string {
  if (seat.sim) return "Simulated";
  if (!seat.online) return "Offline";
  if (seat.transcription === "live") return "Transcribing";
  if (seat.transcription === "recovering") return "Reconnecting";
  if (seat.transcription === "unavailable") return "Transcription unavailable";
  if (seat.listening) return "Connecting microphone";
  return "Mic off";
}

export interface SetupStep { label: string; value: string; done: boolean; flag: boolean }

export function seatSteps(seat: SeatState): SetupStep[] {
  const modeLabel = seat.mode === 1 ? "one earbud" : seat.mode === 2 ? "two earbuds" : null;
  const voiceDone = seat.voice === "ready" || seat.voice === "fallback";
  return [
    {
      label: "Voice",
      value: seat.voice === "ready" ? "Cloned voice" : seat.voice === "fallback" ? "Premade voice"
        : seat.voice === "building" ? "Building" : seat.voice === "error" ? "Failed" : "Not started",
      done: voiceDone, flag: seat.voice === "error",
    },
    {
      label: "Earbuds",
      value: [seat.earbuds.done === true ? "Tested" : seat.earbuds.done === false ? "Not tested" : seat.earbuds.label ?? "Unknown", modeLabel]
        .filter(Boolean).join(" · "),
      done: seat.earbuds.done === true, flag: false,
    },
    { label: "Calibrated", value: seat.calibrated === true ? "Taught" : "Not taught", done: seat.calibrated === true, flag: false },
    { label: "Ready", value: seat.ready === true ? "Ready" : "Waiting", done: seat.ready === true, flag: false },
  ];
}

export function seatSummary(seat: SeatState): { text: string; tone: Tone; state: "ready" | "setup" | "waiting" } {
  if (seat.ready === true) return { text: "Ready", tone: "ok", state: "ready" };
  if (!seat.online) return { text: "Waiting to join", tone: "wait", state: "waiting" };
  if (seat.voice === "error") return { text: "Voice failed", tone: "flag", state: "setup" };
  if (seat.voice !== "ready" && seat.voice !== "fallback") return { text: "Setting up voice", tone: "wait", state: "setup" };
  if (seat.earbuds.done !== true) return { text: "Testing earbuds", tone: "wait", state: "setup" };
  if (seat.calibrated !== true) return { text: "Calibrating", tone: "wait", state: "setup" };
  return { text: "Choosing preset", tone: "wait", state: "setup" };
}

export function speechSpanMs(text: string | null): number {
  return Math.max(600, countWords(text) * 360);
}

export function describeEvent(event: HubEvent | null, fallback: string): string {
  if (!event) return fallback;
  const parts: string[] = [];
  if (event.signal) parts.push(SIGNAL_LABELS[event.signal] ?? event.signal);
  if (event.text) parts.push(event.text);
  if (!parts.length && event.kind) parts.push(KIND_LABELS[event.kind] ?? event.kind);
  return parts.length ? parts.join(" · ") : fallback;
}

export function announcementNote(progress: AnnouncementState): string | null {
  const heard = progress.heard.filter(isSeat);
  const targets = progress.targets.filter(isSeat);
  switch (progress.status) {
    case "building": return "Generating the system voice.";
    case "queued": return "Waiting for playback on " + targets.filter(seat => !heard.includes(seat)).join(" and ") + ".";
    case "played": return "Playback confirmed on both seats.";
    case "partial": return "Playback confirmed on Seat " + heard.join(" and ") + ".";
    case "failed":
      if (progress.reason === "playback_timeout") return "Neither seat confirmed playback. Check the two phones.";
      if (progress.reason === "no_seats") return "Connect a seat first.";
      if (progress.reason === "seat_left" || progress.reason === "seat_offline") {
        return "The seat disconnected before playback. Reconnect it, then send again.";
      }
      return "The announcement voice was unavailable. Try a preset line.";
    default: return null;
  }
}

export interface PitchCoachView { canAsk: boolean; canSend: boolean; draft: boolean; note: string }

export function pitchCoachView(state: HubState, connected: boolean, beat: string): PitchCoachView | null {
  const { coach, announcement } = state;
  if (!coach || state.phase !== "live" || state.preset !== "Pitch" || state.canned) return null;
  const asking = coach.status === "asking";
  const sent = coach.status === "sent";
  const draft = (coach.status === "ready" || sent) && Boolean(coach.id && coach.text);
  const changed = draft && !sent && coach.beat !== beat;
  const bothOnline = SEATS.every(seat => state.seats[seat].online);
  const busy = announcement?.status === "building" || announcement?.status === "queued";
  const source = (coach.source && COACH_SOURCES[coach.source]) ?? "Pitch coach";

  let note = coach.available ? "Ask Maritime for a cue." : "Ask the local coach for a cue.";
  if (!connected) note = "Waiting for the hub to reconnect.";
  else if (asking) note = coach.available ? "Waiting for Maritime…" : "Preparing a local cue…";
  else if (sent && coach.announcementId && announcement && coach.announcementId === announcement.id) {
    note = announcementNote(announcement) ?? "Cue sent.";
  } else if (sent) note = "Cue sent.";
  else if (changed) note = "Ask again for this pitch beat.";
  else if (draft && !bothOnline) note = "Connect both seats to send.";
  else if (draft && busy) note = "Wait for the current announcement.";
  else if (draft) note = "Ready to send.";

  return {
    canAsk: connected && !asking,
    canSend: connected && draft && !sent && !changed && bothOnline && !busy,
    draft,
    note: draft ? source + " · " + note : note,
  };
}

export interface LaneMark {
  lane: SeatKey;
  type: "speech" | "tap" | "heard" | "receipt" | "draft";
  at: number;
  end?: number;
  label?: string | null;
  seat?: SeatKey;
  urgent?: boolean;
}
export interface LaneView {
  marks: (LaneMark & { left: number; width?: number })[];
  ticks: { label: string; left: number }[];
}

export function revealLanes(state: HubState): LaneView | null {
  const base = timelineBase(state);
  const marks: LaneMark[] = [];
  for (const key of SEATS) {
    for (const line of state.seats[key].transcript) {
      if (line.at !== null) marks.push({ lane: key, type: "speech", at: line.at, end: line.at + speechSpanMs(line.text) });
    }
  }
  for (const entry of state.log) {
    if (entry.at === null || !isSeat(entry.seat)) continue;
    if (entry.kind === "message") {
      marks.push({ lane: entry.seat, type: "tap", at: entry.at, label: entry.signal, seat: entry.seat, urgent: entry.urgent });
      if (isSeat(entry.to)) marks.push({ lane: entry.to, type: "heard", at: entry.playedAt ?? entry.at, seat: entry.seat, urgent: entry.urgent });
    } else if (entry.kind === "receipt") marks.push({ lane: entry.seat, type: "receipt", at: entry.at, seat: entry.seat });
    else if (entry.kind === "draft") marks.push({ lane: entry.seat, type: "draft", at: entry.at, seat: entry.seat });
  }
  if (base === null || !marks.length) return null;
  const start = Math.max(base, Math.min(...marks.map(mark => mark.at)) - 1500);
  const span = Math.max(1000, Math.max(...marks.map(mark => mark.end ?? mark.at)) - start);
  const ratio = (at: number) => Math.min(1, Math.max(0, (at - start) / span)) * 100;
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(seconds => span / 1000 / seconds <= 6) ?? 1200;
  const offset = (start - base) / 1000;
  const ticks: LaneView["ticks"] = [];
  for (let seconds = Math.ceil(offset / step) * step; (seconds - offset) * 1000 <= span; seconds += step) {
    ticks.push({ label: seconds < 60 ? seconds + "s" : formatOffset(seconds * 1000), left: ((seconds - offset) * 1000) / span * 100 });
  }
  return {
    ticks,
    marks: marks.map(mark => ({
      ...mark, left: ratio(mark.at),
      width: mark.end === undefined ? undefined : Math.max(0.4, ratio(mark.end) - ratio(mark.at)),
    })),
  };
}
