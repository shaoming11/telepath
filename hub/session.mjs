import { createResearch } from './research.mjs';
import { BUILD_STORY_EVIDENCE, BUILD_STORY_NOTES, fallbackPitchCue, isBuildStoryQuestion, isFrontendStackQuestion, isUsefulPitchCue, looksLikeQuestion, missingBuildPoint, nearlySameQuestion, sameQuestion, sourcedProjectCue } from './pitch-question.mjs';
import { BOOKS, CANNED_PITCH, DEFAULT_CONTEXT, SEATS, SIGNALS, bitsForMode, partnerOf } from './codebook.mjs';

import { codebookReadout, draftPrompt, STATUS_LINES } from './audio.mjs';
import { exactExcerptQuotes, packReferenceEvidence, recallRoomTurns, retrieveProjectReferences, retrieveReferences } from './references.mjs';
import { questionKey, validateAnswer } from './questions.mjs';
import { announcementText, OPERATOR_ANNOUNCEMENTS } from '../public/announcements.mjs';
import { COUNT_CALIBRATION_WINDOW_MS } from '../public/earbuds/airpods-1/input.mjs';
import { normalizePitch, normalizePitchHelp, recommendLocally } from '../maritime/policy.mjs';
import { createPitchPlanner } from './pitch-planner.mjs';
import { coachScenario, isGroundedScenario, scenarioFallbackCue, SCENARIO_QUERY, validateSocialCue } from './coach-scenarios.mjs';
import { createSessionMonitor } from '../monitor/session.mjs';
import { createSpeakerBindings, splitDiarizedSegment } from '../monitor/speakers.mjs';

const MAX_RECEIPT_RECOGNITION_MS = COUNT_CALIBRATION_WINDOW_MS + 500;

const DEFAULT_SETTINGS = Object.freeze({
  draftCooldownMs: 30_000,
  draftExpiryMs: 6_000,
  receiptWindowMs: 4_000,
  roomSenseMs: 15_000,
  roomContextMs: 45_000,
  serviceTimeoutMs: 3_000,
  announcementPlaybackMs: 8_000,
  coachTimeoutMs: 12_000,
  cacheTimeoutMs: 25_000,
  cacheAckRetryMs: 1_500,
  cacheAckRetries: 3,
  draftConfidence: 0.82,
  questionDebounceMs: 350,
  questionQuietMs: 2700,
  automaticQuietMs: 2500,
  automaticCooldownMs: 30000,
  automaticPlaybackGuard: true,
  questionTimeoutMs: 8000,
  pitchHelpTimeoutMs: 4800,
  pitchComposeMs: 1850,
  pitchRaceMs: 6000,
  pitchVerifyMs: 15_000,
  pitchSpeechMs: 4600,
  pitchPlaybackMs: 8000,
  pitchPauseBudgetMs: 12_000,
  pitchReviewMs: 1200,
  pitchQuestionSettleMs: 120,
  pitchRevisionMinMs: 350,
  scenarioRevisionLimit: 3,
  pitchRealtimeReconnectMs: 3000,
  pitchRealtimeReplyMs: 1550,
  pitchQuestionRepeatMs: 2500,
  pitchPlanWaitMs: 120,
  pitchPlanDebounceMs: 220,
  pitchHelpRepeatMs: 1500,
  pitchPartialMaxMs: 2500,
  pitchContext: DEFAULT_CONTEXT.Pitch,
  names: { A: 'Presenter', B: 'Coach' },
});

const USABLE_VOICES = new Set(['ready', 'fallback']);
const SYNCHRONIZED_STEPS = { earbuds: 'earbuds', calibrate: 'calibrated', ready: 'wantsReady' };
const CACHE_SIGNALS = Object.keys(BOOKS.Pitch);
const MAX_PITCH_CUE_WORDS = 20;
const TRANSCRIPTION_STATUSES = new Set(['waiting', 'connecting', 'live', 'recovering', 'unavailable']);

function createSeat(name) {
  return {
    name, online: false, sim: false, mode: 2, drafts: true,
    connected: false, connection: new AbortController(),
    listening: false, listeningRequested: false, roomMicSource: null, transcription: 'off',
    voice: 'idle', voiceRef: null, voiceRequest: null,
    earbuds: false, calibrated: false, wantsReady: false,
    situation: '', transcript: [], level: 0, pending: null,
    audioBusyUntil: -Infinity, lastIn: null, lastOut: null, lastDraftAt: -Infinity, lastSuggestionAt: -Infinity,
    pitchHelp: null, questionMode: null, pitchPlayback: null, lastPitchCue: null, lastPitchHelpAt: -Infinity,
    pendingTimer: null, lastDraftFingerprint: null, receipt: null, awaitingHeard: new Map(),
    cacheId: null, out: false, seenSignals: new Set(), listenVersion: 0,
  };
}

function withDeadline(fn, milliseconds, lifecycle) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lifecycle]);
  const timer = setTimeout(() => controller.abort(new Error('Service deadline exceeded')), milliseconds);
  let rejectAbort;
  const deadline = new Promise((resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
  return Promise.race([
    deadline,
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return fn(signal);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', rejectAbort);
  });
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function toUrl(value) {
  return typeof value === 'string' ? value : value?.url;
}

function announcementInFlight(announcement) {
  return announcement?.status === 'building' || announcement?.status === 'queued';
}

function signalIntent(frame, state, now) {
  const { draftId, receiptId, receiptPressedAt, signal } = frame;
  const { pending, receipt } = state;
  const approve = signal === 'R1';
  const discard = signal === 'L1' || state.mode === 1 && signal === 'R2';
  if ((approve || discard) && typeof draftId === 'string') {
    if (pending?.id !== draftId) return 'skip';
    if (discard) return 'discard';
    return pending.heardAt != null ? 'confirm' : 'skip';
  }

  const can_receipt = approve && receipt?.until >= now;
  if (approve && typeof receiptId === 'string') {
    if (receipt?.messageId !== receiptId) return 'skip';
    const recognized_in_time = Number.isFinite(receiptPressedAt)
      && receiptPressedAt >= receipt.openedAt && receiptPressedAt <= receipt.until
      && now - receiptPressedAt <= MAX_RECEIPT_RECOGNITION_MS;
    return can_receipt || recognized_in_time ? 'receipt' : 'skip';
  }

  const implicit_draft = pending && !Object.hasOwn(frame, 'draftId');
  if (implicit_draft && approve && pending.heardAt != null) return 'confirm';
  if (implicit_draft && discard) return 'discard';
  if (can_receipt && !Object.hasOwn(frame, 'receiptId')) return 'receipt';
  return implicit_draft && approve ? 'skip' : 'ordinary';
}

export class Session {
  constructor({ emitSeat, emitStage, audio, codec, coach, researchFactory = () => createResearch({ env: {} }), settings = {}, now = Date.now }) {
    this.emitSeat = emitSeat;
    this.emitStage = emitStage;
    this.audio = audio;
    this.codec = codec;
    this.coach = coach;
    this.researchFactory = researchFactory;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.now = now;
    this.generation = 0;
    this.setupReset = null;
    this.sequence = 0;
    this.senseTimer = null;
    this.cannedTimers = new Set();
    this.pitchReferences = [];
    this.closed = false;
    this.monitor = createSessionMonitor(now);
    this.pitchPlanner = createPitchPlanner({ remote: coach?.planPitchHelp?.bind(coach), now });
    this.pitchPlanTimer = null;
    this.coachScenario = coachScenario(this.settings.coachScenario);
    this.initialize();
  }

  initialize(connections = {}) {
    this.monitor.reset();
    this.generation += 1;
    this.sessionId = String(this.generation);
    this.lifecycle = new AbortController();
    this.scene = new AbortController();
    this.phase = 'lobby';
    this.preset = 'Pitch';
    this.context = this.settings.pitchContext;
    this.targetPreset = { preset: this.preset, context: this.context };
    this.startedAt = null;
    this.canned = false;
    this.log = [];
    this.bits = 0;
    this.lastReplay = null;
    this.announcement = null;
    this.coachState = { status: 'idle' };
    this.voiceRevision = 0;
    this.activeCache = null;
    this.cacheCandidate = null;
    this.calibration = null;
    this.sensing = false;
    this.references = [];
    this.researchReferences = [];
    this.research = this.researchFactory();
    this.researchPending = null;
    this.researchRunning = false;
    this.researchTimer = null;
    this.lastAutomaticCueAt = -Infinity;
    this.automaticCueTexts = new Set();
    this.referencesLoading = false;
    this.answerVersion = 0;
    this.answerController = null;
    this.answerTask = null;
    this.questionTimer = null;
    this.questionQuietTimer = null;
    this.questionTurns = [];
    this.questionSpeechPending = false;
    this.questionPartialSeats = new Set();
    this.roomInput = this.settings.roomInput === 'mac' ? 'mac' : 'phones';
    this.room = { listening: false, listeningRequested: false, transcription: 'off', listenVersion: 0, level: 0, transcript: [], partial: null };
    this.questionState = { status: 'idle' };
    this.dismissedQuestions = new Set();
    this.seats = Object.fromEntries(SEATS.map(seat => [
      seat, { ...createSeat(this.settings.names[seat]), ...connections[seat] },
    ]));
  }

  snapshot(viewer) {
    return {
      sessionId: this.sessionId,
      ...(this.setupReset && { setupReset: this.setupReset }),
      phase: this.phase,
      preset: this.preset,
      pitchHelp: this.preset === 'Pitch',
      coachScenario: this.coachScenario,
      questionModeAvailable: this.preset === 'Pitch' && this.roomInput === 'mac',
      presetPending: this.cacheCandidate?.preset ?? (this.targetPreset.preset !== this.preset ? this.targetPreset.preset : null),
      cacheId: this.activeCache?.id ?? null,
      context: this.context,
      roomInput: this.roomInput,
      room: { listening: this.room.listening, listeningRequested: this.room.listeningRequested,
        transcription: this.room.transcription, level: this.room.level,
        ...(viewer == null && { transcript: this.room.transcript.slice(), speakerStream: this.room.speakerStream }) },
      codebook: BOOKS[this.preset],
      calibration: this.calibration,
      online: Object.fromEntries(SEATS.map(seat => [seat, this.seats[seat].online])),
      seats: Object.fromEntries(SEATS.map(seat => {
        const state = this.seats[seat];
        const visible = viewer == null || viewer === seat;
        return [seat, {
          name: state.name, online: state.online, sim: state.sim, mode: state.mode,
          drafts: state.drafts, listening: state.listening, roomMicSource: state.roomMicSource,
          transcription: state.transcription, voice: state.voice,
          earbuds: state.earbuds, calibrated: state.calibrated, ready: this.isReady(seat),
          situation: visible ? state.situation : '',
          transcript: visible ? state.transcript.slice() : [],
          pending: visible ? state.pending : null,
          questionMode: visible && Boolean(state.questionMode),
          lastPitchCue: visible ? state.lastPitchCue : null,
          receipt: visible && state.receipt?.until >= this.now()
            ? { messageId: state.receipt.messageId, openedAt: state.receipt.openedAt, until: state.receipt.until }
            : null,
          lastIn: visible ? state.lastIn : null, lastOut: visible ? state.lastOut : null,
        }];
      })),
      canBegin: !this.referencesLoading && SEATS.every(seat => this.isReady(seat)),
      startedAt: this.startedAt,
      canned: this.canned,
      ...(viewer == null && { announcement: this.snapshotAnnouncement(), canReplay: this.canReplay() }),
      ...(viewer == null && { references: this.references.map(({ id, name, characters }) => ({ id, name, characters })),
        research: { ...this.research.snapshot?.(), retained: this.researchReferences.length },
        referencesLoading: this.referencesLoading, questionAnswering: this.codec?.questionAnswering === true,
        questionState: this.questionState }),
      ...(viewer == null && { coach: { available: Boolean(this.coach), ...this.coachState } }),
      log: viewer == null
        ? this.log.slice()
        : this.log.filter(entry => entry.seat === viewer || entry.to === viewer),
      bits: this.bits,
    };
  }

  publish() {
    if (this.closed) return;
    this.syncCacheGenerations();
    this.emitStage({ type: 'state', state: this.snapshot() });
    for (const seat of SEATS) {
      if (this.seats[seat].online) this.emitSeat(seat, { type: 'state', state: this.snapshot(seat) });
    }
    this.publishMonitor();
  }

  publishMonitor() {
    if (this.closed) return;
    this.emitStage(this.monitorFrame());
    for (const seat of SEATS) {
      if (this.seats[seat].online) this.emitSeat(seat, this.monitorFrame(seat));
    }
  }

  monitorFrame(viewer) {
    const phase = this.questionState.status;
    const helping = (viewer ? [viewer] : SEATS).some(seat => this.seats[seat].pitchHelp);
    const activity = helping
      ? { phase: 'evaluating', summary: 'Preparing a private pitch cue', preset: this.preset }
      : phase === 'researching'
      ? { phase: 'evaluating', summary: 'Checking the team references', preset: this.preset }
      : phase === 'preview'
        ? { phase: 'ready', summary: 'An answer is ready for a private preview', preset: this.preset }
        : null;
    return { type: 'monitor', monitor: this.monitor.snapshot(this.seats, viewer, {
      room: this.roomInput === 'mac' ? this.room : null, activity,
    }) };
  }

  append(kind, fields) {
    const entry = { id: String(++this.sequence), at: this.now(), kind, ...fields };
    this.log.push(entry);
    return entry;
  }

  isReady(seat) {
    const state = this.seats[seat];
    return Boolean(state.online && state.wantsReady && state.earbuds && state.calibrated
      && USABLE_VOICES.has(state.voice) && this.activeCache && state.cacheId === this.activeCache.id);
  }

  async connect(seat, sim = false) {
    let state = this.seats[seat];
    if (!state || this.closed) return;
    if (state.online) this.endConnection(seat);
    if (state.connected && state.sim !== sim) {
      void this.removeVoice(state.voiceRef);
      state = createSeat(state.name);
      this.seats[seat] = state;
      this.activeCache = null;
      this.replaceCacheCandidate(null);
      for (const person of SEATS) this.seats[person].cacheId = null;
      this.cancelScene('seat_changed');
    }
    state.online = true;
    state.sim = sim;
    state.connected = true;
    state.connection = new AbortController();
    state.cacheId = null;
    if (this.activeCache) this.sendManifest(seat, this.activeCache);
    if (this.cacheCandidate?.bank) {
      this.cacheCandidate.ack.delete(seat);
      this.sendManifest(seat, this.cacheCandidate);
    }
    this.publish();
    await this.ensureCache();
  }

  disconnect(seat) {
    const state = this.seats[seat];
    if (!state?.online || this.closed) return;
    this.endConnection(seat);
    this.publish();
  }

  endConnection(seat) {
    this.stopQuestionMode(seat);
    this.cancelAnswers('disconnect');
    this.questionPartialSeats.delete(seat);
    this.questionSpeechPending = this.questionPartialSeats.size > 0;
    const state = this.seats[seat];
    state.connection.abort();
    state.online = false;
    this.monitor.clearSeat(seat);
    state.cacheId = null;
    state.receipt = null;
    state.awaitingHeard.clear();
    state.out = false;
    this.cacheCandidate?.ack.delete(seat);
    this.stopListening(seat);
    this.clearPending(seat, 'disconnect');
    const announcement = this.announcement;
    if (announcementInFlight(announcement) && announcement.targets.has(seat)) {
      if (!announcement.heard.has(seat)) announcement.disconnected.add(seat);
      this.checkAnnouncementTargets(announcement);
    }
  }

  liveScope(seats = []) {
    return AbortSignal.any([
      this.lifecycle.signal, this.scene.signal, ...seats.map(seat => this.seats[seat].connection.signal),
    ]);
  }

  cancelScene(reason) {
    this.clearPitchPlanning();
    for (const seat of SEATS) this.stopQuestionMode(seat);
    this.cancelAnswers(reason);
    this.questionTurns = [];
    this.questionSpeechPending = false;
    this.questionPartialSeats.clear();
    this.questionState = { status: 'idle' };
    this.scene.abort();
    this.scene = new AbortController();
    this.coachState = { status: 'idle' };
    for (const seat of SEATS) {
      this.seats[seat].lastPitchCue = null;
      this.seats[seat].pitchPlayback = null;
      this.clearPending(seat, reason);
    }
  }

  sendManifest(seat, candidate) {
    this.emitSeat(seat, {
      type: 'cache', sessionId: this.sessionId, activeId: candidate.id, items: candidate.bank[partnerOf(seat)],
    });
  }

  syncCacheGenerations() {
    const active = this.activeCache?.id ?? null;
    const pending = this.cacheCandidate?.id ?? null;
    if (this.pinnedCache?.active === active && this.pinnedCache.pending === pending) return;
    this.audio.setCacheGenerations?.(active, pending);
    this.pinnedCache = { active, pending };
  }

  replaceCacheCandidate(candidate) {
    if (this.cacheCandidate) {
      clearTimeout(this.cacheCandidate.retryTimer);
      this.cacheCandidate.lifecycle.abort();
    }
    this.cacheCandidate = candidate;
  }

  resendUnacknowledgedManifest(candidate) {
    for (const seat of SEATS) {
      if (this.seats[seat].online && !candidate.ack.has(seat)) this.sendManifest(seat, candidate);
    }
  }

  scheduleCacheRetry(candidate) {
    if (candidate.retries >= this.settings.cacheAckRetries || this.settings.cacheAckRetryMs <= 0) return;
    candidate.retryTimer = setTimeout(() => {
      if (this.cacheCandidate !== candidate || this.closed) return;
      candidate.retries += 1;
      this.resendUnacknowledgedManifest(candidate);
      this.scheduleCacheRetry(candidate);
    }, this.settings.cacheAckRetryMs);
    candidate.retryTimer.unref();
  }

  cacheMatches(cache) {
    const { preset, context } = this.targetPreset;
    return cache?.preset === preset && cache.context === context && cache.voiceRevision === this.voiceRevision;
  }

  async ensureCache() {
    if (this.canned || !SEATS.every(seat => this.seats[seat].online && USABLE_VOICES.has(this.seats[seat].voice))) return;
    if (this.cacheMatches(this.cacheCandidate)) return;
    if (this.cacheMatches(this.activeCache)) {
      if (this.cacheCandidate) {
        this.replaceCacheCandidate(null);
        this.publish();
      }
      return;
    }

    const { preset, context } = this.targetPreset;
    const candidate = {
      id: 'cache-' + ++this.sequence, preset, context, voiceRevision: this.voiceRevision, bank: null, ack: new Set(),
      lifecycle: new AbortController(), retries: 0, retryTimer: null,
    };
    this.replaceCacheCandidate(candidate);
    this.publish();

    try {
      const entries = await withDeadline(signal => Promise.all(SEATS.map(async speaker => {
        const voice = this.seats[speaker];
        const items = await this.audio.buildCache(speaker, preset, BOOKS[preset], {
          voice: voice.voiceRef, sim: voice.sim, activeId: candidate.id, signal,
        });
        if (!Array.isArray(items) || !CACHE_SIGNALS.every(pattern => items.some(item =>
          item.key === [speaker, preset, pattern].join(':') && typeof item.url === 'string'
        ))) throw new Error('Incomplete fixed-message bank');
        return [speaker, items];
      })), this.settings.cacheTimeoutMs, AbortSignal.any([this.lifecycle.signal, candidate.lifecycle.signal]));

      if (candidate !== this.cacheCandidate || this.closed) return;
      candidate.bank = Object.fromEntries(entries);
      this.resendUnacknowledgedManifest(candidate);
      this.scheduleCacheRetry(candidate);
    } catch {
      if (candidate !== this.cacheCandidate || this.closed) return;
      this.replaceCacheCandidate(null);
      this.append('cache_error', { seat: null, text: 'Fixed audio was unavailable' });
      this.publish();
    }
  }

  cacheReady(seat, id) {
    const state = this.seats[seat];
    if (this.activeCache?.id === id && state.cacheId !== id) {
      state.cacheId = id;
      this.publish();
    }
    const candidate = this.cacheCandidate;
    if (!candidate?.bank || candidate.id !== id) return;
    candidate.ack.add(seat);
    if (!SEATS.every(person => this.seats[person].online && candidate.ack.has(person))) return;

    const previous = this.preset;
    const context_changed = candidate.context !== this.context;
    this.activeCache = candidate;
    this.replaceCacheCandidate(null);
    this.preset = candidate.preset;
    this.context = candidate.context;
    for (const person of SEATS) this.seats[person].cacheId = id;
    if (previous !== this.preset || context_changed) this.cancelScene('preset_changed');
    if (previous !== this.preset) this.append('preset', { seat: null, text: this.preset });
    this.publish();
  }

  async selectPreset(preset, customContext) {
    if (this.canned || !Object.hasOwn(BOOKS, preset)) return;
    const context = preset === 'Pitch' ? this.settings.pitchContext
      : preset === 'Custom' ? cleanText(customContext, 240) || DEFAULT_CONTEXT.Custom
      : DEFAULT_CONTEXT[preset];
    this.targetPreset = { preset, context };
    if (!this.activeCache) {
      this.preset = preset;
      this.context = context;
    }
    this.publish();
    const pending = this.cacheCandidate;
    if (pending?.bank && this.cacheMatches(pending)) {
      this.resendUnacknowledgedManifest(pending);
      return;
    }
    await this.ensureCache();
  }

  async handleSeat(seat, frame) {
    const state = this.seats[seat];
    if (this.closed || !state?.online || !frame) return;
    if (frame.sessionId != null && frame.sessionId !== this.sessionId) return;
    switch (frame.type) {
      case 'signal': return this.receiveSignal(seat, frame);
      case 'heard': return this.heard(seat, frame);
      case 'configure': return this.configure(seat, frame);
      case 'setup': return this.setup(seat, frame);
      case 'preset': return this.selectPreset(frame.preset, frame.context);
      case 'cache_ready': return this.cacheReady(seat, frame.activeId);
      case 'voice': return this.recordVoice(seat, frame);
      case 'voice_preview': return this.previewVoice(seat);
      case 'mic': return this.receiveMic(seat, frame);
      case 'audio_monitor':
        if (this.monitor.updateOutput(seat, frame)) this.publishMonitor();
        return;
      case 'calibration': return this.applyCalibration(frame.profile);
      case 'listen': return this.setListening(seat, frame.enabled === true);
      case 'sim_transcript':
        if (state.sim) {
          state.level = this.levelValue(frame.level);
          this.addTranscript(seat, frame.text);
        }
        break;
    }
  }

  applyCalibration(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || JSON.stringify(profile).length > 20_000) return;
    this.calibration = structuredClone(profile);
    for (const person of SEATS) {
      if (this.seats[person].online) this.emitSeat(person, { type: 'calibration', profile: this.calibration });
    }
    this.publish();
  }

  configure(seat, frame) {
    const state = this.seats[seat];
    if (frame.mode === 1 || frame.mode === 2) state.mode = frame.mode;
    if (typeof frame.drafts === 'boolean') {
      state.drafts = frame.drafts;
      if (!state.drafts && state.pending?.kind === 'draft') this.clearPending(seat, 'disabled');
    }
    this.publish();
  }

  async setup(seat, { step, complete, fallback }) {
    const state = this.seats[seat];
    if (step === 'voice' && complete === true && fallback === true) {
      const previous = state.voiceRef;
      state.voiceRequest?.abort();
      state.voiceRequest = null;
      state.voiceRef = null;
      state.voice = 'fallback';
      if (previous?.id) this.invalidateVoiceCache();
      this.emitSeat(seat, { type: 'voice_status', status: 'fallback', detail: 'Using the premade voice.' });
      this.publish();
      await Promise.all([this.ensureCache(), this.removeVoice(previous)]);
      return;
    }
    if (step === 'voice' && complete === true && !USABLE_VOICES.has(state.voice) && state.voice !== 'building') {
      state.voice = 'fallback';
      this.publish();
      return this.ensureCache();
    }
    if (Object.hasOwn(SYNCHRONIZED_STEPS, step)) {
      state[SYNCHRONIZED_STEPS[step]] = complete === true;
      this.publish();
    }
  }

  invalidateVoiceCache() {
    this.voiceRevision += 1;
    this.replaceCacheCandidate(null);
  }

  cue(seat, cue, options = {}) {
    if (this.seats[seat].online) {
      if (options.url && options.text) {
        this.seats[seat].audioBusyUntil = this.now() + Math.min(15000, Math.max(2500, options.text.split(/\s+/).length * 450 + 500));
      }
      this.emitSeat(seat, { type: 'audio', cue, sessionId: this.sessionId, ...options });
    }
  }

  async receiveSignal(seat, frame) {
    const { id, signal } = frame;
    const state = this.seats[seat];
    if (!SIGNALS.includes(signal) || (state.mode === 1 && signal === 'L1')) {
      this.cue(seat, 'error');
      return;
    }
    if (typeof id === 'string' && id.length <= 128) {
      if (state.seenSignals.has(id)) return;
      state.seenSignals.add(id);
      if (state.seenSignals.size > 2048) state.seenSignals.delete(state.seenSignals.values().next().value);
    }
    if (this.phase !== 'live' || this.canned) return;

    this.expirePending(seat);
    const intent = signalIntent(frame, state, this.now());
    this.append('signal', { seat, signal });
    if (intent === 'confirm') {
      await this.confirmPending(seat);
    } else if (intent === 'discard') {
      this.clearPending(seat, 'discarded');
    } else if (intent === 'receipt') {
      const receipt = state.receipt;
      state.receipt = null;
      this.append('receipt', {
        seat, to: receipt.from, signal, text: receipt.text, messageId: receipt.messageId, bits: 0,
      });
      this.cue(receipt.from, 'receipt');
    } else if (intent === 'skip') {
      this.publish();
      return;
    } else if (signal === 'BACK') {
      if (state.out) {
        state.out = false;
        this.append('back', { seat, to: partnerOf(seat), signal });
        this.cue(partnerOf(seat), 'back');
      }
    } else if (signal === 'LR') {
      this.publish();
      if (frame.purpose === 'question_mode' && this.preset === 'Pitch') this.toggleQuestionMode(seat);
      else if (frame.purpose === 'pitch_help' && this.preset === 'Pitch') await this.requestPitchHelp(seat);
      else await this.sense(seat);
    } else if (signal === 'L2') {
      this.publish();
      await this.readCodebook(seat);
    } else if (signal !== 'OUT' || !state.out) {
      if (signal === 'OUT') state.out = true;
      if (Object.hasOwn(frame, 'cacheId') && frame.cacheId !== (this.activeCache?.id ?? null)) this.cue(seat, 'error');
      else this.sendFixed(seat, signal);
    }
    this.publish();
  }

  sendFixed(seat, signal, source = 'seat') {
    const recipient = partnerOf(seat);
    const receiver = this.seats[recipient];
    const text = CACHE_SIGNALS.includes(signal) ? BOOKS[this.preset][signal] : null;
    const cache_id = this.activeCache?.id;
    if (!text || !receiver.online || !cache_id || receiver.cacheId !== cache_id) {
      this.cue(seat, 'error');
      return false;
    }
    this.deliver(seat, signal, text, {
      cue: signal === 'OUT' ? 'urgent' : 'soft', activeId: cache_id,
      key: [seat, this.preset, signal].join(':'),
    }, source === 'operator' ? 0 : bitsForMode(this.seats[seat].mode), 'fixed', source);
    return true;
  }

  deliver(seat, signal, text, audio, bits, messageKind, source = 'seat') {
    const recipient = partnerOf(seat);
    const messageId = 'message-' + ++this.sequence;
    const entry = this.append('message', { seat, to: recipient, signal, text, bits, messageId, messageKind, preset: this.preset, source });
    this.bits += bits;
    this.seats[seat].lastOut = entry;
    const state = this.seats[recipient];
    state.lastIn = entry;
    const replayUrl = audio.url ?? this.activeCache?.bank[seat]?.find(item => item.key === audio.key)?.url;
    this.lastReplay = replayUrl ? { entry, cue: audio.cue, url: replayUrl } : null;
    this.audio.retainReplayAsset?.(replayUrl ?? null);
    state.awaitingHeard.set(messageId, entry);
    if (state.awaitingHeard.size > 32) state.awaitingHeard.delete(state.awaitingHeard.keys().next().value);
    this.cue(seat, 'sent');
    this.cue(recipient, audio.cue, { ...audio, text, messageId });
  }

  canReplay() {
    return this.phase === 'live' && !this.canned && Boolean(this.lastReplay && this.seats[this.lastReplay.entry.to].online);
  }

  heard(seat, frame) {
    const announcement = this.announcement;
    if (announcement && frame.messageId === announcement.id) {
      this.hearAnnouncement(announcement, seat);
      return;
    }
    if (this.phase !== 'live' || this.canned) return;
    const state = this.seats[seat];
    if (state.pending && state.pending.id === frame.messageId && state.pending.heardAt == null) {
      if (state.pending.expiresAt <= this.now()) {
        this.clearPending(seat, 'expired');
        this.publish();
        return;
      }
      const heardAt = this.now();
      this.append('preview_playback', {
        seat, draftId: frame.messageId, latencyMs: heardAt - state.pending.decisionAt,
      });
      this.setPending(seat, { ...state.pending, heardAt, expiresAt: heardAt + this.settings.draftExpiryMs });
      this.publish();
      return;
    }
    const entry = state.awaitingHeard.get(frame.messageId);
    if (!entry) return;
    state.awaitingHeard.delete(frame.messageId);
    const playedAt = this.now();
    entry.playedAt = playedAt;
    entry.playbackLatencyMs = Math.max(0, playedAt - entry.at);
    if (entry.kind === 'pitch_help') {
      entry.requestToPlaybackMs = Math.max(0, playedAt - entry.requestedAt);
      this.publish();
      return;
    }
    state.receipt = {
      from: entry.seat,
      text: entry.text,
      messageId: entry.messageId,
      openedAt: playedAt,
      until: playedAt + this.settings.receiptWindowMs,
    };
    this.publish();
  }

  async recordVoice(seat, { wav, requestId }) {
    const state = this.seats[seat];
    if (typeof wav !== 'string' || wav.length < 128 || wav.length > 2_050_000 || state.voice === 'building') return;
    const generation = this.generation;
    const id = typeof requestId === 'string' ? requestId : 'voice-' + ++this.sequence;
    const request = new AbortController();
    const signal = AbortSignal.any([this.lifecycle.signal, request.signal]);
    const previous = state.voiceRef;
    state.voiceRequest = request;
    state.voice = 'building';
    this.emitSeat(seat, { type: 'voice_status', status: 'building', requestId: id });
    this.publish();

    let voice;
    try {
      voice = await this.audio.makeVoice(seat, wav, id, { signal });
    } catch {
      voice = { status: 'fallback', detail: 'Using the available fallback voice.' };
    }
    if (generation !== this.generation || this.closed || this.seats[seat].voiceRequest !== request) {
      await this.removeVoice(voice);
      return;
    }
    state.voiceRequest = null;
    const keep_previous = previous?.status === 'ready' && voice?.status !== 'ready';
    const detail = keep_previous ? 'New recording failed. Your current voice is still ready.' : voice?.detail;
    if (keep_previous) voice = previous;
    const status = USABLE_VOICES.has(voice?.status) || voice?.status === 'error' ? voice.status : 'fallback';
    state.voiceRef = voice?.id && voice.id === previous?.id ? previous : voice ?? null;
    state.voice = status;
    const voice_changed = (previous?.id ?? null) !== (state.voiceRef?.id ?? null);
    if (voice_changed) this.invalidateVoiceCache();
    this.emitSeat(seat, {
      type: 'voice_status', status, requestId: id, detail,
    });
    this.publish();
    if (USABLE_VOICES.has(status)) await this.ensureCache();
    if (voice_changed) await this.removeVoice(previous);
  }

  async removeVoice(voice) {
    if (!voice?.id) return;
    try { await this.audio.removeVoice?.(voice); } catch {}
  }

  async previewVoice(seat) {
    const state = this.seats[seat];
    if (state.voiceRef?.status !== 'ready' || state.voicePreviewPending || state.sim) return;
    state.voicePreviewPending = true;
    const voice = state.voiceRef;
    const signal = this.liveScope([seat]);
    try {
      const text = 'Hi, this is my Telepathy voice. Take a moment to hear how I sound at a normal speaking volume.';
      const url = toUrl(await withDeadline(requestSignal => this.audio.speech(seat, text, {
        voice, role: 'voice-preview', signal: requestSignal,
      }), 8000, signal));
      if (!signal.aborted && state.voiceRef === voice) {
        if (url) this.cue(seat, null, { kind: 'voice_preview', text, url });
        else this.emitSeat(seat, { type: 'voice_preview_error' });
      }
    } catch {
      if (!signal.aborted) this.emitSeat(seat, { type: 'voice_preview_error' });
    } finally {
      state.voicePreviewPending = false;
    }
  }

  addTranscript(seat, value, generation = this.generation, meta) {
    const state = seat === 'room' ? this.room : this.seats[seat];
    if (this.closed || generation !== this.generation || this.canned || this.phase === 'reveal'
        || !state || (seat === 'room' ? !state.listening : !state.online)) return;
    const text = cleanText(typeof value === 'string' ? value : value?.text, 1200);
    if (!text) return;
    const wasSpeaking = this.questionPartialSeats.delete(seat);
    this.questionSpeechPending = this.questionPartialSeats.size > 0;
    this.monitor.updatePartial(seat, '');
    if (seat === 'room') this.room.partial = null;
    state.transcript.push({
      at: this.now(), text,
      ...(Number.isInteger(meta?.segment) && { streamId: meta.streamId, segment: meta.segment }),
    });
    if (this.phase === 'live') this.researchInBackground(state.transcript);
    if (seat === 'room' && state.transcript.length > 60) state.transcript.splice(0, state.transcript.length - 60);
    if (this.phase === 'live' && !(seat === 'room' && SEATS.some(person => this.seats[person].questionMode)) && (this.references.length || this.researchReferences.length) && this.codec?.questionAnswering) {
      const key = questionKey(text);
      const duplicate = this.questionTurns.slice(-4).some(turn => this.now() - turn.at < 2000 && questionKey(turn.text) === key);
      if (!duplicate) {
        this.cancelAnswers('conversation_updated');
        this.questionTurns.push({ seat, text, at: this.now() });
        this.questionTurns = this.questionTurns.filter(turn => this.now() - turn.at < 45_000).slice(-20);
      }
      if (!duplicate || wasSpeaking) {
        clearTimeout(this.questionTimer);
        clearTimeout(this.questionQuietTimer);
        this.questionTimer = setTimeout(() => void this.answerQuestion(), this.settings.questionDebounceMs);
        this.questionQuietTimer = setTimeout(() => void this.answerQuestion(), this.settings.questionQuietMs);
        this.questionTimer.unref();
        this.questionQuietTimer.unref();
      }
    }
    if (seat === 'room') {
      this.schedulePitchPlanning();
      this.commitPitchQuestion(state.transcript.at(-1));
    }
    this.publish();
  }

  updateDiarization(seat, streamId, message, merged = false) {
    const state = seat === 'room' ? this.room : this.seats[seat];
    if (state.speakerStream !== streamId) {
      state.speakerStream = streamId;
      state.speakerBindings = createSpeakerBindings();
    }
    const bindings = state.speakerBindings;
    if (merged) {
      if (!bindings.merge(message.from_speaker_id, message.to_speaker_id)) return;
      this.refreshSpeakerLabels(state);
    } else {
      const segment = splitDiarizedSegment(message);
      const entry = segment && state.transcript.findLast(item => item.streamId === streamId && item.segment === segment.index);
      if (!entry) return;
      entry.speakers = segment.runs.map(run => ({ text: run.text, ...bindings.describe(run.speaker) }));
    }
    if (seat === 'room') this.schedulePitchPlanning();
    this.publish();
  }

  refreshSpeakerLabels(state) {
    for (const entry of state.transcript) {
      if (entry.streamId === state.speakerStream && entry.speakers) {
        entry.speakers = entry.speakers.map(run => ({ text: run.text, ...state.speakerBindings.describe(run.speaker) }));
      }
    }
  }

  assignRoomSpeaker({ stream, speaker, seat }) {
    if (this.roomInput !== 'mac' || this.canned || this.phase === 'reveal' || !Number.isInteger(stream)
        || stream !== this.room.speakerStream || !this.room.speakerBindings?.assign(speaker, seat)) return;
    this.refreshSpeakerLabels(this.room);
    this.schedulePitchPlanning();
    this.publish();
  }

  cancelAnswers(reason) {
    this.answerVersion++;
    this.answerController?.abort();
    this.answerController = null;
    this.answerTask = null;
    clearTimeout(this.questionTimer);
    clearTimeout(this.questionQuietTimer);
    for (const seat of SEATS) {
      if (this.seats?.[seat]?.pending?.answerVersion != null) {
        this.clearPending(seat, reason);
        if (reason === 'conversation_updated') this.seats[seat].lastDraftAt = -Infinity;
      }
    }
    if (this.questionState?.status === 'preview' || this.questionState?.status === 'researching') {
      this.questionState = { ...this.questionState, status: 'cancelled', reason };
    }
  }

  schedulePitchPlanning() {
    if (!this.coach?.planPitchHelp || this.closed || this.canned || this.phase !== 'live' || this.preset !== 'Pitch'
        || !this.pitchReferences.length || !this.seats.A.online || this.seats.A.sim) return;
    clearTimeout(this.pitchPlanTimer);
    this.pitchPlanTimer = setTimeout(() => {
      if (!this.room.listening || !this.seats.A.online || this.seats.A.sim || this.closed || this.canned || this.phase !== 'live' || this.preset !== 'Pitch') return;
      const { context } = this.pitchContext('A', this.now(), false);
      if (context.turns.length) this.pitchPlanner.prepare(context);
    }, this.settings.pitchPlanDebounceMs);
    this.pitchPlanTimer.unref();
  }

  clearPitchPlanning() {
    clearTimeout(this.pitchPlanTimer);
    this.pitchPlanTimer = null;
    this.pitchPlanner.clear();
  }

  researchInBackground(turns) {
    if (this.research.enabled === false) return;
    this.researchPending = turns.slice(-8);
    if (this.researchRunning || this.researchTimer) return;
    const generation = this.generation;
    const run = async () => {
      this.researchTimer = null;
      if (this.closed || generation !== this.generation || this.phase !== 'live') return;
      const latest = this.researchPending;
      this.researchPending = null;
      this.researchRunning = true;
      try {
        const document = await this.research.observe(latest, { signal: this.liveScope(),
          known: [...this.references.slice(0, 4), ...this.researchReferences] });
        if (!document || this.closed || generation !== this.generation || this.phase !== 'live') return;
        this.researchReferences = [...this.researchReferences, document].slice(-12);
        this.clearPitchPlanning();
        for (const seat of SEATS) {
          const mode = this.seats[seat].questionMode;
          mode?.candidate?.controller.abort();
          if (mode) mode.candidate = null;
        }
      } finally {
        if (generation === this.generation && !this.closed && !this.lifecycle.signal.aborted) {
          this.researchRunning = false;
          // Coalesce speech received during a lookup; never lose the latest context.
          this.researchTimer = setTimeout(() => {
            this.researchTimer = null;
            if (this.researchPending) this.researchInBackground(this.researchPending);
          }, 15000);
          this.researchTimer.unref();
        }
      }
    };
    void run().catch(() => {});
  }

  lastSpeechAt() {
    return Math.max(this.room.transcript.at(-1)?.at ?? -Infinity,
      ...SEATS.map(seat => this.seats[seat].transcript.at(-1)?.at ?? -Infinity));
  }

  canWhisperAutomatically(seat, text = '') {
    const state = this.seats[seat];
    return this.phase === 'live' && !this.canned && !this.closed && state.online
      && !this.room.partial && !this.questionSpeechPending
      && !SEATS.some(person => this.seats[person].pending || this.seats[person].receipt?.until > this.now())
      && (!this.settings.automaticPlaybackGuard || !SEATS.some(person => this.seats[person].audioBusyUntil > this.now()))
      && !announcementInFlight(this.announcement)
      && this.now() - this.lastSpeechAt() >= this.settings.automaticQuietMs
      && this.now() - this.lastAutomaticCueAt >= this.settings.automaticCooldownMs
      && (!text || !this.automaticCueTexts.has(questionKey(text)));
  }

  rememberAutomaticCue(text) {
    this.lastAutomaticCueAt = this.now();
    this.automaticCueTexts.add(questionKey(text));
    if (this.automaticCueTexts.size > 100) this.automaticCueTexts.delete(this.automaticCueTexts.values().next().value);
  }

  async valuableWhisper(text, passages, signal) {
    // The offline rehearsal uses deterministic emulated cues, never a live model.
    if (!this.room.listening && SEATS.every(seat => this.seats[seat].sim) && this.codec?.mode === 'local') return true;
    if (!this.codec?.assessWhisper) return true;
    try {
      return await withDeadline(deadline => this.codec.assessWhisper({ text, passages,
        turns: [...this.room.transcript, ...SEATS.flatMap(seat => this.seats[seat].transcript)]
          .sort((a, b) => a.at - b.at).slice(-8).map(({ text }) => ({ text })),
        signal: deadline }), 1800, signal) === true;
    } catch { return false; }
  }

  pitchContext(seat, began, includePartial = true) {
    const history = this.room.transcript.flatMap(turn =>
      turn.speakers?.length ? turn.speakers.map(run => ({ at: turn.at, speaker: run.label, text: run.text }))
        : [{ at: turn.at, speaker: 'Room', text: turn.text }]);
    const turns = history.filter(turn => began - turn.at <= this.settings.roomContextMs);
    const partial = this.room.partial;
    if (includePartial && partial && began - partial.at <= this.settings.pitchPartialMaxMs
        && questionKey(partial.text) !== questionKey(turns.at(-1)?.text)) {
      turns.push({ speaker: 'Room (live partial)', text: partial.text });
    }
    const recent = turns.slice(-6);
    const latest = recent.at(-1)?.text ?? '';
    const earlier = recallRoomTurns(history.filter(turn => !recent.includes(turn)), latest);
    const pitch = this.coachScenario === 'pitch';
    const query = recent.slice(-3).map(turn => turn.text).join(' ') || SCENARIO_QUERY[this.coachScenario];
    const corpus = [...this.references, ...this.researchReferences, ...(pitch ? this.pitchReferences : [])];
    let passages = corpus.length ? retrieveProjectReferences(corpus, query, 7, latest) : [];
    const frontendStack = pitch ? this.pitchReferences.find(doc => doc.kind === 'frontend')
      ?.chunks.find(chunk => chunk.heading === 'Active frontend stack') : undefined;
    if (frontendStack && isFrontendStackQuestion(latest)) {
      passages = [frontendStack, ...passages.filter(passage => passage.id !== frontendStack.id)].slice(0, 7);
    }
    const overview = pitch ? this.pitchReferences.find(doc => doc.name === 'Telepathy technical reference.md')
      ?.chunks.find(chunk => chunk.heading === 'Project overview')?.text : undefined;
    const project = [overview, frontendStack?.text].filter(Boolean).join('\n\n') || undefined;
    return { passages, recent, earlier, project, frontendStack, context: normalizePitchHelp({
      type: 'pitch_help', seat, elapsedSeconds: Math.min(86400, Math.max(0, Math.floor((began - this.startedAt) / 1000))),
      turns: recent, passages,
    }) };
  }

  stopQuestionMode(seat) {
    const state = this.seats[seat];
    const mode = state.questionMode;
    if (!mode) return;
    clearTimeout(mode.timer);
    mode.controller.abort();
    state.questionMode = null;
  }

  toggleQuestionMode(seat) {
    if (this.seats[seat].questionMode) this.stopQuestionMode(seat);
    else {
      this.cancelAnswers('question_mode');
      const controller = new AbortController();
      const scope = AbortSignal.any([this.liveScope([seat]), controller.signal]);
      const realtime = this.coachScenario === 'pitch' ? this.codec?.openPitchRealtime?.(scope) : null;
      this.seats[seat].questionMode = { controller, scope, realtime, realtimeOpenedAt: this.now(), revisions: 0, candidate: null, timer: null };
      if (this.room.partial && this.now() - this.room.partial.at <= this.settings.pitchPartialMaxMs) {
        this.preparePitchQuestion(this.room.partial.text);
      }
    }
    this.publish();
  }

  fallbackCue(text, question) {
    return scenarioFallbackCue(this.coachScenario, question) ?? fallbackPitchCue(text, question);
  }

  selectCoachScenario(value) {
    const scenario = coachScenario(value);
    if (this.closed || this.canned || this.phase === 'reveal' || scenario === this.coachScenario) return;
    this.coachScenario = scenario;
    this.clearPitchPlanning();
    for (const seat of SEATS) {
      const armed = Boolean(this.seats[seat].questionMode);
      this.stopQuestionMode(seat);
      this.seats[seat].pitchHelp?.abort();
      if (armed) this.toggleQuestionMode(seat);
    }
    this.append('coach_scenario', { seat: null, text: scenario });
    if (this.phase === 'live' && this.room.listening) this.schedulePitchPlanning();
    this.publish();
  }

  pitchRealtime(mode) {
    if (this.coachScenario !== 'pitch') return null;
    if (mode.realtime?.closed && !mode.scope.aborted
        && this.now() - mode.realtimeOpenedAt >= this.settings.pitchRealtimeReconnectMs) {
      mode.realtimeOpenedAt = this.now();
      mode.realtime = this.codec.openPitchRealtime(mode.scope);
    }
    return mode.realtime;
  }

  preparePitchQuestion(text) {
    if (this.phase !== 'live' || this.canned || this.preset !== 'Pitch' || !looksLikeQuestion(text)) return;
    for (const seat of SEATS) {
      const mode = this.seats[seat].questionMode;
      if (!mode || (this.seats[seat].pitchHelp && !mode.delivery)) continue;
      const previous = mode.candidate;
      if (previous) {
        const growth = questionKey(text).split(' ').length - questionKey(previous.text).split(' ').length;
        // Pitch redrafts over its warm Realtime session. Other scenarios redraft through the text API, a few times at most.
        const redraft = mode.realtime ? mode.revisions < 2 : this.coachScenario !== 'pitch' && mode.revisions < this.settings.scenarioRevisionLimit;
        if (!redraft || growth < 3 || this.now() - previous.at < this.settings.pitchRevisionMinMs) continue;
        previous.controller.abort();
      }
      mode.revisions++;
      const controller = new AbortController();
      const scope = AbortSignal.any([this.liveScope([seat]), mode.controller.signal, controller.signal]);
      const input = this.pitchContext(seat, this.now());
      const started = performance.now();
      const realtime = this.pitchRealtime(mode);
      const task = withDeadline(signal => this.composePitchCue(input, signal, started, realtime),
        this.settings.pitchComposeMs, scope).catch(() => null);
      mode.candidate = { text, controller, task, at: this.now(), corpus: this.pitchReferences, uploads: this.references, research: this.researchReferences };
    }
  }

  holdActivePitchCues() {
    for (const seat of SEATS) {
      const state = this.seats[seat];
      const playback = state.pitchPlayback;
      if (!playback || playback.held || playback.until <= this.now()) continue;
      playback.held = true;
      state.awaitingHeard.delete(playback.entry.messageId);
      this.emitSeat(seat, { type: 'pitch_help_hold', messageId: playback.entry.messageId });
    }
  }

  async waitForPitchPause(signal) {
    while (this.room.partial || this.questionSpeechPending || this.now() - this.lastSpeechAt() < this.settings.automaticQuietMs) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    signal.throwIfAborted();
  }

  pitchAnswerAfter(seat, anchor) {
    if (!anchor) return '';
    const turns = this.room.transcript;
    const index = turns.indexOf(anchor);
    if (index < 0) return '';
    const answer = [];
    for (const candidate of turns.slice(index + 1, index + 4)) {
      if (looksLikeQuestion(candidate.text)) break;
      if (candidate.speakers?.some(run => run.seat)) {
        answer.push(...candidate.speakers.filter(run => run.seat === seat).map(run => run.text));
      } else answer.push(candidate.text);
    }
    return answer.join(' ');
  }

  async reviewPitchAnswer(question, spoken, passages, signal) {
    if (questionKey(spoken).split(' ').length < 4 || this.coachScenario === 'social') return null;
    if (this.coachScenario === 'pitch' && isBuildStoryQuestion(question)) {
      const answer = missingBuildPoint(spoken);
      const source = passages.find(passage => passage.text.includes(BUILD_STORY_EVIDENCE));
      return answer && source ? { answer, source: 'project-reference', sources: [{ id: source.id, name: source.name, quote: BUILD_STORY_EVIDENCE }], timing: {} } : null;
    }
    if (!this.codec?.questionAnswering || !passages.length) return null;
    const turns = [{ text: question }, { text: spoken }];
    try {
      const value = await withDeadline(deadline => this.codec.answer({
        activeQuestion: question, turns, passages, requested: true, quietMs: 2500, signal: deadline,
      }), this.settings.pitchReviewMs, signal);
      const reviewed = validateAnswer(value, passages, turns);
      return reviewed.status === 'advice' ? { ...reviewed, source: 'answer-review', timing: {} } : null;
    } catch { return null; }
  }

  commitPitchQuestion(entry) {
    for (const seat of SEATS) {
      const state = this.seats[seat];
      const mode = state.questionMode;
      if (!mode) continue;
      const playback = state.pitchPlayback;
      if (playback?.held) {
        state.pitchPlayback = null;
        if (!looksLikeQuestion(entry.text)) {
          const prior = playback;
          clearTimeout(mode.timer);
          mode.timer = setTimeout(() => {
            if (this.seats[seat].questionMode !== mode) return;
            const spoken = this.pitchAnswerAfter(seat, prior.anchor);
            if (spoken) void this.requestPitchHelp(seat, {
              question: prior.question, anchor: prior.anchor, spoken, scope: mode.scope,
            });
          }, this.settings.pitchQuestionSettleMs);
          mode.timer.unref();
          continue;
        }
      }
      const candidate = mode.candidate;
      mode.candidate = null;
      mode.revisions = 0;
      if (!looksLikeQuestion(entry.text) || (this.seats[seat].pitchHelp && !mode.delivery)
          || (mode.lastQuestion && sameQuestion(mode.lastQuestion.text, entry.text)
            && entry.at - mode.lastQuestion.at < this.settings.pitchQuestionRepeatMs)
          || (mode.pendingQuestion && sameQuestion(mode.pendingQuestion.text, entry.text))) {
        candidate?.controller.abort();
        continue;
      }
      clearTimeout(mode.timer);
      mode.pending?.controller.abort();
      mode.pending = candidate;
      mode.pendingQuestion = entry;
      mode.timer = setTimeout(() => {
        if (this.seats[seat].questionMode !== mode) return;
        mode.pending = null;
        mode.pendingQuestion = null;
        if (this.seats[seat].pitchHelp && !mode.delivery) {
          candidate?.controller.abort();
          return;
        }
        const questions = entry.speakers?.filter(run => looksLikeQuestion(run.text)) ?? [];
        if (questions.length && questions.every(run => run.seat === seat)) {
          candidate?.controller.abort();
          return;
        }
        const prepared = candidate && candidate.corpus === this.pitchReferences && candidate.uploads === this.references && candidate.research === this.researchReferences
          && (this.coachScenario === 'pitch' ? sameQuestion(candidate.text, entry.text) : nearlySameQuestion(candidate.text, entry.text)) ? candidate : null;
        if (!prepared) candidate?.controller.abort();
        mode.lastQuestion = entry;
        mode.delivery?.abort();
        const delivery = new AbortController();
        mode.delivery = delivery;
        const input = this.pitchContext(seat, this.now(), false);
        const scope = AbortSignal.any([mode.scope, delivery.signal]);
        void this.requestPitchHelp(seat, { input, prepared, question: entry.text, anchor: entry, scope, realtime: this.pitchRealtime(mode) })
          .finally(() => { if (mode.delivery === delivery) mode.delivery = null; });
      }, this.settings.pitchQuestionSettleMs);
      mode.timer.unref();
    }
  }

  async composePitchCue({ context, passages, recent, earlier, project, frontendStack }, signal, started, realtime) {
    const question = recent.at(-1)?.text ?? '';
    const scenario = this.coachScenario;
    const pitch = scenario === 'pitch';
    const known = pitch ? sourcedProjectCue(question, passages, frontendStack) : null;
    if (known && !this.coach?.draftPitchCue) {
      return { ...validateAnswer(known, passages, recent), source: 'project-reference', timing: {} };
    }
    if (!this.codec?.pitchHelp || (!passages.length && isGroundedScenario(scenario))) return null;
    if (!pitch) realtime = null;
    const { plan, source } = await this.pitchPlanner.select(context, { signal, waitMs: this.settings.pitchPlanWaitMs });
    const planned = performance.now();
    const selected = new Set(plan.passageIds);
    const ranked = [...passages.filter(passage => selected.has(passage.id)), ...passages.filter(passage => !selected.has(passage.id))];
    const input = { ...context, project, turns: recent.map(({ speaker, text }) => ({ speaker, text })),
      ...(earlier?.length && { earlierRoomContext: earlier }), passages: ranked, plan };
    const evidence = realtime ? packReferenceEvidence(ranked, recent.at(-1)?.text ?? '') : [];
    const raw = realtime ? await withDeadline(deadline => realtime.generate({
      ...input, turns: input.turns.slice(-4), passages: evidence,
      plan: { ...plan, passageIds: plan.passageIds.filter(id => evidence.some(passage => passage.id === id)) },
    }, deadline), this.settings.pitchRealtimeReplyMs, signal).catch(() => null) : null;
    signal.throwIfAborted();
    let cue;
    if (raw) {
      try {
        cue = validateAnswer({ ...raw, sources: exactExcerptQuotes(raw.sources, evidence) }, evidence, recent);
      } catch {}
      if (cue?.status === 'answer' && cue.answer.split(/\s+/).length <= MAX_PITCH_CUE_WORDS && isUsefulPitchCue(cue.answer, question)) {
        return { ...cue, source: 'openai-realtime', timing: { planMs: Math.round(planned - started), composeMs: Math.round(performance.now() - planned) } };
      }
    }
    const result = await this.codec.pitchHelp({ signal, ...input, ...(!pitch && { scenario }) });
    if (!result) return null;
    cue = scenario === 'social' ? result : validateAnswer(result, ranked, recent);
    if (cue.status !== 'answer' || cue.answer.split(/\s+/).length > MAX_PITCH_CUE_WORDS || (pitch && !isUsefulPitchCue(cue.answer, question))) return null;
    return { ...cue, source, timing: { planMs: Math.round(planned - started), composeMs: Math.round(performance.now() - planned) } };
  }

  async racePitchCue(input, prepared, started, realtime, signal) {
    const compose = deadline => prepared?.task ?? this.composePitchCue(input, deadline, started, realtime);
    if (!this.coach?.draftPitchCue) {
      return withDeadline(compose, this.settings.pitchComposeMs, signal);
    }
    const { passages, recent } = input;
    const scenario = this.coachScenario;
    const context = { ...input.context, passages, turns: recent, scenario };
    const validate = raw => {
      const cue = scenario === 'social' ? validateSocialCue(raw, passages) : validateAnswer(raw, passages, recent);
      if (cue.status !== 'answer' || cue.answer.split(/\s+/).length > MAX_PITCH_CUE_WORDS
          || (scenario === 'pitch' && !isUsefulPitchCue(cue.answer, recent.at(-1)?.text))) {
        throw new Error('Provider did not return a usable cue');
      }
      return cue;
    };
    const providers = [
      { name: 'OpenAI', source: 'openai', draft: compose, verify: this.codec?.verifyPitchCue?.bind(this.codec) },
      { name: 'Maritime', source: 'maritime', draft: deadline => this.coach.draftPitchCue(context, { signal: deadline }),
        verify: this.coach.verifyPitchCue?.bind(this.coach) },
    ];
    const drafts = providers.map(provider => withDeadline(provider.draft, this.settings.pitchVerifyMs, signal));
    const candidates = drafts.map((draft, index) => draft.then(raw => {
      const cue = validate(raw);
      return { ...cue, source: raw.source === 'openai-realtime' ? raw.source : providers[index].source, timing: raw.timing ?? {}, index };
    }));
    const winner = await withDeadline(() => Promise.any(candidates), this.settings.pitchRaceMs, signal);
    const index = 1 - winner.index;
    const reviewer = providers[index];
    return { ...winner, verify: reviewer.verify && (async deadline => {
      const alternate = await drafts[index];
      deadline.throwIfAborted();
      const verdict = await reviewer.verify({
        ...context, firstCue: winner.answer, alternative: typeof alternate?.answer === 'string' ? alternate.answer.slice(0, 180) : '',
      }, { signal: deadline });
      if (verdict?.status === 'resolved') return { provider: reviewer.name };
      if (verdict?.status !== 'answer' || scenario === 'social') return null;
      const corrected = validate(verdict);
      if (questionKey(corrected.answer) === questionKey(winner.answer)) return null;
      return { provider: reviewer.name, correction: corrected };
    }) };
  }

  async speakPitchCue(seat, text, signal) {
    try {
      return toUrl(await withDeadline(deadline => this.audio.speech(seat, text, {
        voice: null, sim: false, role: 'assistant', signal: deadline, whisper: true,
      }), this.settings.pitchSpeechMs, signal));
    } catch { return null; }
  }

  async requestPitchHelp(seat, { input, prepared, question, anchor, spoken, scope, realtime } = {}) {
    const state = this.seats[seat];
    const began = this.now();
    if (!state.online || (state.pitchHelp && !state.pitchHelp.signal.aborted && !question)
        || (!question && began - state.lastPitchHelpAt < this.settings.pitchHelpRepeatMs)) {
      prepared?.controller.abort();
      return;
    }
    const notify = text => this.emitSeat(seat, { type: 'pitch_help_status', text });
    if (state.sim) {
      notify('Live pitch help requires a real seat.');
      return;
    }
    state.lastPitchHelpAt = began;
    const controller = new AbortController();
    state.pitchHelp = controller;
    const lifecycle = AbortSignal.any([controller.signal, this.liveScope([seat]), ...(scope ? [scope] : [])]);
    const resolved = input ?? this.pitchContext(seat, began);
    const started = performance.now();
    let surfacedCue = false;
    let verifying = false;
    notify('Preparing a private pitch cue…');
    this.publishMonitor();
    try {
      const reply = await withDeadline(async signal => {
        let cue = spoken
          ? await this.reviewPitchAnswer(question, spoken, resolved.passages, signal)
          : await this.racePitchCue(resolved, prepared, started, realtime, signal).catch(() => null)
            ?? (anchor ? null : { answer: this.fallbackCue(question ?? resolved.recent.at(-1)?.text ?? '', Boolean(question)), source: 'local-fallback', sources: [], timing: {} });
        if (anchor) await this.waitForPitchPause(signal);
        let checkedAnswer = spoken || this.pitchAnswerAfter(seat, anchor);
        const reviewAnswers = this.coachScenario !== 'social';
        if (checkedAnswer && !spoken && reviewAnswers) cue = await this.reviewPitchAnswer(question, checkedAnswer, resolved.passages, signal);
        if (!cue) return null;
        if (anchor && ((isGroundedScenario(this.coachScenario) && !cue.sources?.length) || !this.canWhisperAutomatically(seat, cue.answer)
          || !await this.valuableWhisper(cue.answer, resolved.passages, signal))) return null;
        const composed = performance.now();
        const showCue = () => {
          notify(cue.answer);
          surfacedCue = true;
          state.lastPitchCue = {
            text: cue.answer,
            points: !checkedAnswer && this.coachScenario === 'pitch' && isBuildStoryQuestion(question ?? resolved.recent.at(-1)?.text ?? '')
              ? BUILD_STORY_NOTES
              : cue.sources.slice(0, 1).map(source => source.quote.slice(0, 180)),
          };
          this.emitSeat(seat, { type: 'state', state: this.snapshot(seat) });
        };
        showCue();
        let url = await this.speakPitchCue(seat, cue.answer, signal);
        if (anchor) await this.waitForPitchPause(signal);
        const latestAnswer = this.pitchAnswerAfter(seat, anchor);
        if (reviewAnswers && latestAnswer && latestAnswer !== checkedAnswer) {
          checkedAnswer = latestAnswer;
          cue = await this.reviewPitchAnswer(question, checkedAnswer, resolved.passages, signal);
          if (!cue) return null;
          showCue();
          url = await this.speakPitchCue(seat, cue.answer, signal);
          if (anchor) await this.waitForPitchPause(signal);
          if (this.pitchAnswerAfter(seat, anchor) !== checkedAnswer) return null;
        }
        const rendered = performance.now();
        return { ...cue, url, reviewed: Boolean(checkedAnswer), timing: {
          ...cue.timing, speechMs: Math.round(rendered - composed), hubMs: Math.round(rendered - started),
        } };
      }, Math.max(this.settings.pitchHelpTimeoutMs, this.settings.pitchPauseBudgetMs), lifecycle);
      if (lifecycle.aborted || !reply) return;
      if (anchor) {
        const latest = this.room.transcript.at(-1);
        if (!this.canWhisperAutomatically(seat, reply.answer)
          || latest && latest !== anchor && looksLikeQuestion(latest.text) && !sameQuestion(latest.text, anchor.text)) return;
        this.rememberAutomaticCue(reply.answer);
      }
      const messageId = reply.url ? 'pitch-help-' + (this.sequence + 1) : null;
      const entry = this.append('pitch_help', { seat, text: reply.answer, source: reply.source, sources: reply.sources,
        scenario: this.coachScenario, ...(reply.ungrounded && { ungrounded: true }),
        timing: reply.timing, requestedAt: began, messageId });
      if (messageId) {
        state.awaitingHeard.set(messageId, entry);
        if (state.awaitingHeard.size > 32) state.awaitingHeard.delete(state.awaitingHeard.keys().next().value);
        if (anchor && !reply.reviewed) state.pitchPlayback = { entry, question, anchor, until: this.now() + 10_000 };
        this.cue(seat, 'sent', { kind: 'pitch_help', url: reply.url, text: reply.answer, messageId, expiresAfterMs: this.settings.pitchPlaybackMs });
      } else {
        this.emitSeat(seat, { type: 'pitch_help_audio_failed' });
      }
      if (reply.verify && state.lastPitchCue) {
        verifying = true;
        const shown = state.lastPitchCue;
        const lastTurn = this.room.transcript.at(-1);
        const current = () => !lifecycle.aborted && state.lastPitchCue === shown
          && (!state.pitchHelp || state.pitchHelp === controller)
          && this.room.transcript.at(-1) === lastTurn && !this.room.partial;
        void withDeadline(reply.verify, this.settings.pitchVerifyMs, lifecycle).then(async result => {
          if (!current() || !result) return;
          const revised = result.correction;
          const url = revised && !anchor ? await this.speakPitchCue(seat, 'Correction. ' + revised.answer, lifecycle) : null;
          if (!current()) return;
          state.lastPitchCue = revised ? {
            text: revised.answer, points: ['Correction verified by ' + result.provider, ...revised.sources.map(source => source.quote)],
          } : { ...shown, points: [...shown.points, 'Verified by ' + result.provider] };
          this.emitSeat(seat, { type: 'state', state: this.snapshot(seat) });
          if (revised && !url && !anchor) this.emitSeat(seat, { type: 'pitch_help_audio_failed' });
          if (url) {
            const messageId = 'pitch-help-' + (this.sequence + 1);
            const correction = this.append('pitch_help', { seat, text: revised.answer, sources: revised.sources,
              source: result.provider.toLowerCase() + '-review', scenario: this.coachScenario, requestedAt: began, messageId });
            state.awaitingHeard.set(messageId, correction);
            if (state.awaitingHeard.size > 32) state.awaitingHeard.delete(state.awaitingHeard.keys().next().value);
            this.cue(seat, 'sent', { kind: 'pitch_help', url, text: revised.answer, messageId, expiresAfterMs: this.settings.pitchPlaybackMs });
            this.publish();
          }
        }).catch(() => {}).finally(() => prepared?.controller.abort());
      }
    } catch {
      if (!lifecycle.aborted && !surfacedCue) notify(this.fallbackCue(question ?? resolved.recent.at(-1)?.text ?? '', Boolean(question)));
    } finally {
      if (!verifying) prepared?.controller.abort();
      if (state.pitchHelp === controller) state.pitchHelp = null;
      if (!lifecycle.aborted) this.publish();
    }
  }

  async answerQuestion(requestedSeat) {
    const sender = requestedSeat ?? 'B';
    if (this.closed || this.phase !== 'live' || this.canned || !(this.references.length || this.researchReferences.length) || !this.codec?.questionAnswering
        || !this.canDraft(sender) || !this.questionTurns.length || this.questionSpeechPending) return;
    if (this.answerTask) {
      // A manual request supersedes an automatic evaluation; a quiet timer gets one follow-up.
      if (requestedSeat) this.cancelAnswers('requested');
      else {
        const version = this.answerVersion;
        await this.answerTask;
        if (version === this.answerVersion) return this.answerQuestion();
        return;
      }
    }
    const version = this.answerVersion;
    const generation = this.generation;
    const controller = new AbortController();
    this.answerController = controller;
    const signal = AbortSignal.any([controller.signal, this.liveScope([sender, partnerOf(sender)])]);
    const current = () => !signal.aborted && version === this.answerVersion && generation === this.generation && this.phase === 'live' && !this.canned;
    const turns = this.questionTurns.filter(turn => this.now() - turn.at < 45_000);
    if (!turns.length) return;
    const passages = retrieveReferences([...this.references, ...this.researchReferences], [this.questionState.question ?? '', ...turns.slice(-6).map(turn => turn.text)].join(' '));
    const activeQuestion = this.questionState.question ?? '';
    this.questionState = { status: 'researching', question: activeQuestion };
    this.publish();
    const task = (async () => {
      try {
        const result = validateAnswer(await withDeadline(deadline => this.codec.answer({
          signal: deadline, passages, turns, activeQuestion, requested: Boolean(requestedSeat),
          quietMs: this.now() - turns.at(-1).at,
        }), this.settings.questionTimeoutMs, signal), passages, turns);
        if (!current()) return;
        if (result.status === 'advice' && !requestedSeat && this.now() - turns.at(-1).at < 2500) {
          this.questionState = { status: 'waiting', question: result.question };
          return;
        }
        const key = result.status + ':' + questionKey(result.question);
        this.questionState = result;
        if (!['answer', 'advice'].includes(result.status) || this.dismissedQuestions.has(key)) {
          if (this.dismissedQuestions.has(key)) this.questionState = { ...result, status: 'already_offered' };
          return;
        }
        if (!this.canDraft(sender)) return;
        if (!requestedSeat && (!this.canWhisperAutomatically(sender, result.answer)
          || !await this.valuableWhisper(result.answer, passages, signal))) {
          this.questionState = { status: 'waiting', question: result.question }; return;
        }
        await withDeadline(previewSignal => this.previewDraft(sender, { kind: 'draft', text: result.answer, started_at: this.now(), signal: previewSignal,
          fingerprint: key, automatic: !requestedSeat, answer: { answerVersion: version, suggestionKey: key, suggestionKind: result.suggestionKind,
            question: result.question, sources: result.sources, responseQuote: result.responseQuote } }), this.settings.serviceTimeoutMs, signal);
        if (current() && this.seats[sender].pending?.answerVersion === version) {
          this.questionState = { ...result, status: 'preview' };
          this.append('answer_evidence', { seat: sender, text: result.question + (result.responseQuote ? ' · Answer heard: “' + result.responseQuote + '”' : '') + ' → ' + result.answer,
            sources: result.sources, question: result.question, suggestionKind: result.suggestionKind, responseQuote: result.responseQuote });
        }
      } catch {
        if (version === this.answerVersion && generation === this.generation && !controller.signal.aborted) {
          this.questionState = { status: 'unavailable', question: activeQuestion, reason: 'Answer unavailable or timed out. Fixed whispers still work.' };
        }
      } finally {
        if (this.answerTask === task) this.answerTask = null;
        if (version === this.answerVersion && generation === this.generation) this.publish();
      }
    })();
    this.answerTask = task;
    await task;
  }

  levelValue(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  transcriptionCallbacks(seat, generation, listenVersion) {
    const current = () => generation === this.generation && (seat === 'room' ? this.room : this.seats[seat]).listenVersion === listenVersion;
    const committed = (text, meta) => { if (current()) this.addTranscript(seat, text, generation, meta); };
    const track_questions = Boolean(this.codec?.questionAnswering);
    const room = seat === 'room';
    if (!track_questions && !room) return committed;
    return {
      committed,
      partial: text => {
        if (!current() || !text?.trim()) return;
        if (room) {
          this.room.partial = { at: this.now(), text: cleanText(text, 260) };
          this.monitor.updatePartial(seat, text);
          this.holdActivePitchCues();
          this.preparePitchQuestion(text);
        }
        if (track_questions && this.phase === 'live') {
          this.questionPartialSeats.add(seat);
          this.questionSpeechPending = true;
          this.cancelAnswers('conversation_updated');
          this.publish();
        } else if (room) this.publishMonitor();
      },
      ...(room && {
        diarized: (message, stream) => { if (current()) this.updateDiarization(seat, stream, message); },
        merged: (message, stream) => { if (current()) this.updateDiarization(seat, stream, message, true); },
      }),
    };
  }

  async receiveMic(seat, frame, source = 'phone') {
    if (this.roomInput === 'mac') return;
    const state = this.seats[seat];
    if (!state.listening || state.roomMicSource !== source || typeof frame.audio !== 'string' || frame.audio.length > 48_000) return;
    state.level = this.levelValue(frame.level);
    this.monitor.updateInput(seat, state.level);
    this.publishMonitor();
    const generation = this.generation;
    const listen_version = state.listenVersion;
    try {
      await this.audio.mic?.(seat, frame.audio, state.level, this.transcriptionCallbacks(seat, generation, listen_version));
    } catch {}
  }

  async setListening(seat, enabled, source = 'phone') {
    if (this.roomInput === 'mac') return;
    const state = this.seats[seat];
    if (!enabled) {
      if (state.roomMicSource !== source) return;
      this.cancelAnswers('listening_stopped');
      this.questionPartialSeats.delete(seat);
      this.questionSpeechPending = this.questionPartialSeats.size > 0;
      this.stopListening(seat);
      this.publish();
      return;
    }
    if (!state.online || state.sim || this.canned || this.phase === 'reveal') return;
    if (state.listeningRequested) {
      if (source !== 'companion' || state.roomMicSource === 'companion') return;
      this.stopListening(seat);
    }
    const generation = this.generation;
    const listen_version = ++state.listenVersion;
    state.listeningRequested = true;
    state.roomMicSource = source;
    state.transcription = 'waiting';
    this.publish();
    try {
      const listening = await this.audio.listen?.(seat, true, this.transcriptionCallbacks(seat, generation, listen_version));
      if (generation !== this.generation || listen_version !== state.listenVersion || !state.online) return;
      state.listening = typeof this.audio.listen === 'function' && listening !== false && listening?.listening !== false;
    } catch {
      if (generation !== this.generation || listen_version !== state.listenVersion) return;
      state.listening = false;
    }
    if (!state.listening) {
      state.listeningRequested = false;
      state.roomMicSource = null;
      state.transcription = 'unavailable';
    }
    this.publish();
  }

  updateTranscriptionStatus({ seat, status } = {}) {
    if (seat === 'room') {
      if (this.closed || this.canned || this.phase === 'reveal' || !this.room.listeningRequested || !TRANSCRIPTION_STATUSES.has(status)) return;
      if (status === 'unavailable') this.stopRoomListening();
      this.room.transcription = status;
      this.publish();
      return;
    }
    const state = this.seats[seat];
    if (this.closed || this.canned || this.phase === 'reveal' || !state?.online || state.sim || !state.listeningRequested) return;
    if (!TRANSCRIPTION_STATUSES.has(status) || state.transcription === status) return;
    state.transcription = status;
    this.publish();
  }

  stopListening(seat) {
    const state = this.seats[seat];
    const was_requested = state.listeningRequested;
    state.listenVersion += 1;
    state.listening = false;
    state.listeningRequested = false;
    state.roomMicSource = null;
    state.transcription = 'off';
    state.level = 0;
    this.monitor.updatePartial(seat, '');
    if (was_requested) {
      try { Promise.resolve(this.audio.listen?.(seat, false)).catch(() => {}); } catch {}
    }
  }

  async setRoomListening(enabled) {
    if (!enabled) {
      this.stopRoomListening();
      this.publish();
      return;
    }
    if (this.closed || this.canned || this.phase === 'reveal' || this.room.listeningRequested) return;
    this.roomInput = 'mac';
    for (const seat of SEATS) this.stopListening(seat);
    this.cancelAnswers('input_changed');
    this.questionPartialSeats.clear();
    this.questionSpeechPending = false;
    const room = this.room;
    const version = ++room.listenVersion;
    const generation = this.generation;
    room.listeningRequested = true;
    room.transcription = 'waiting';
    this.publish();
    try {
      const result = await this.audio.listen?.('room', true, this.transcriptionCallbacks('room', generation, version), { diarize: true });
      if (generation !== this.generation || version !== room.listenVersion) return;
      room.listening = typeof this.audio.listen === 'function' && result !== false && result?.listening !== false;
    } catch { if (generation === this.generation && version === room.listenVersion) room.listening = false; }
    if (generation !== this.generation || version !== room.listenVersion) return;
    if (!room.listening) { room.listeningRequested = false; room.transcription = 'unavailable'; }
    this.publish();
  }

  async receiveRoomMic(frame) {
    if (this.roomInput !== 'mac' || !this.room.listening || this.canned || this.phase === 'reveal'
        || typeof frame.audio !== 'string' || frame.audio.length > 48_000) return;
    this.room.level = this.levelValue(frame.level);
    this.monitor.updateInput('room', this.room.level);
    this.publishMonitor();
    try {
      await this.audio.mic?.('room', frame.audio, this.room.level,
        this.transcriptionCallbacks('room', this.generation, this.room.listenVersion));
    } catch {}
  }

  stopRoomListening() {
    const wasRequested = this.room.listeningRequested;
    this.clearPitchPlanning();
    for (const seat of SEATS) {
      this.stopQuestionMode(seat);
      this.seats[seat].pitchHelp?.abort();
    }
    this.room.listenVersion++;
    this.room.listening = false;
    this.room.listeningRequested = false;
    this.room.transcription = 'off';
    this.room.level = 0;
    this.room.partial = null;
    this.monitor.updatePartial('room', '');
    this.questionPartialSeats.delete('room');
    this.questionSpeechPending = this.questionPartialSeats.size > 0;
    this.cancelAnswers('room_microphone_stopped');
    if (wasRequested) { try { Promise.resolve(this.audio.listen?.('room', false)).catch(() => {}); } catch {} }
  }

  finishLive(reason) {
    this.stopRoomListening();
    this.finishAnnouncement(reason);
    this.cancelScene(reason);
    this.replaceCacheCandidate(null);
    this.targetPreset = { preset: this.preset, context: this.context };
    clearInterval(this.senseTimer);
    this.senseTimer = null;
    this.monitor.setAnalysis('idle', 'Context review paused');
    for (const seat of SEATS) {
      const state = this.seats[seat];
      state.receipt = null;
      state.awaitingHeard.clear();
      this.stopListening(seat);
    }
  }

  startSensing() {
    if (!this.settings.roomSenseMs || this.senseTimer) return;
    this.senseTimer = setInterval(() => {
      if (this.phase === 'live' && !this.canned) void this.sense();
    }, this.settings.roomSenseMs);
    this.senseTimer.unref();
  }

  canDraft(seat) {
    const state = this.seats[seat];
    return state.online && state.drafts && !state.pending
      && this.now() - state.lastDraftAt >= this.settings.draftCooldownMs;
  }

  async sense(requestedSeat) {
    if ((this.references.length || this.researchReferences.length) && this.codec?.questionAnswering) {
      if (requestedSeat && this.questionTurns.length) return this.answerQuestion(requestedSeat);
      if (this.answerTask || ['waiting', 'answer', 'advice', 'preview'].includes(this.questionState.status)) return;
    }
    if (!this.codec?.evaluate || this.sensing || this.phase !== 'live' || this.canned) return;
    if (requestedSeat && !this.canDraft(requestedSeat)) return;
    const started_at = this.now();
    const { preset, context, seats, room } = this.snapshot();
    room.transcript = room.transcript.filter(entry => started_at - entry.at <= this.settings.roomContextMs).slice(-12);
    for (const seat of SEATS) {
      seats[seat].transcript = seats[seat].transcript
        .filter(entry => started_at - entry.at <= this.settings.roomContextMs).slice(-12);
      seats[seat].level = this.seats[seat].level;
    }
    if (!requestedSeat && !room.transcript.length && !SEATS.some(seat => seats[seat].transcript.length || seats[seat].level > 0.015)) return;
    const generation = this.generation;
    const connections = Object.fromEntries(SEATS.map(seat => [seat, this.seats[seat].connection.signal]));
    const lifecycle = this.liveScope(requestedSeat ? [requestedSeat] : []);
    this.sensing = true;
    const sim = !this.room.listening && (requestedSeat ? seats[requestedSeat].sim
      : SEATS.every(seat => !seats[seat].online || seats[seat].sim));
    this.monitor.startAnalysis({ ...seats, room }, { preset, mode: sim ? 'Simulation' : this.codec.mode ?? 'Live model', requestedSeat });
    this.publishMonitor();
    try {
      await withDeadline(async signal => {
        const result = await this.codec.evaluate({
          preset, context, now: this.now(), requestedSeat, sim, seats, room, signal,
        });
        if (signal.aborted || generation !== this.generation || preset !== this.preset || context !== this.context || this.phase !== 'live' || this.canned) return;
        for (const person of SEATS) {
          if (connections[person].aborted) continue;
          const situation = cleanText(result?.situations?.[person], 100);
          if (situation && this.seats[person].situation !== situation) {
            this.seats[person].situation = situation;
            this.append('situation', { seat: person, text: situation });
          }
        }
        this.publish();
        const suggestions = requestedSeat ? [requestedSeat] : SEATS;
        if (suggestions.some(person => Number.isFinite(result?.candidates?.[person]?.confidence)
          && result.candidates[person].confidence >= this.settings.draftConfidence && this.canDraft(person))) {
          this.monitor.setAnalysis('drafting', 'Preparing a preview');
          this.publishMonitor();
        }
        await Promise.all(suggestions.map(async person => {
          if (connections[person].aborted) return;
          const preview_signal = AbortSignal.any([signal, connections[person]]);
          const candidate = result?.candidates?.[person];
          if (Number.isFinite(candidate?.confidence) && candidate.confidence >= this.settings.draftConfidence && this.canDraft(person)) {
            const text = cleanText(candidate.text, 100);
            const evidence = SEATS.map(seat => this.seats[seat].transcript.at(-1)?.at ?? 0);
            evidence.push(this.room.transcript.at(-1)?.at ?? 0);
            const fingerprint = JSON.stringify([text, preset, ...evidence]);
            if (text && (requestedSeat || this.seats[person].lastDraftFingerprint !== fingerprint)) {
              await this.previewDraft(person, { kind: 'draft', text, started_at, signal: preview_signal, fingerprint, automatic: !requestedSeat });
            }
            return;
          }
          const suggested = typeof result?.suggestedPreset === 'string' ? result.suggestedPreset : result?.suggestedPreset?.[person];
          const state = this.seats[person];
          if (!requestedSeat && state.online && !state.pending && Object.hasOwn(BOOKS, suggested)
              && suggested !== this.preset && suggested !== 'Custom'
              && this.now() - state.lastSuggestionAt >= this.settings.draftCooldownMs) {
            const text = STATUS_LINES['sounds_like_' + suggested.toLowerCase()];
            await this.previewDraft(person, { kind: 'preset', text, preset: suggested, started_at, signal: preview_signal, automatic: true });
          }
        }));
      }, this.settings.serviceTimeoutMs, lifecycle);
      if (generation === this.generation && !lifecycle.aborted) {
        this.monitor.setAnalysis('ready', 'Context review complete');
        this.publishMonitor();
      }
    } catch {
      if (generation === this.generation && !lifecycle.aborted) {
        this.monitor.setAnalysis('error', 'The room context review did not finish');
        this.publishMonitor();
      }
    } finally {
      if (generation === this.generation) this.sensing = false;
    }
  }

  async previewDraft(seat, { kind, text, preset, started_at, signal, fingerprint, answer, automatic = false }) {
    const generation = this.generation;
    const state = this.seats[seat];
    const decisionAt = this.now();
    const speechAt = this.lastSpeechAt();
    if (automatic && (!this.canWhisperAutomatically(seat, text)
      || !answer && !await this.valuableWhisper(text, [], signal))) return;
    const line = kind === 'draft' ? 'Send: ' + text.replace(/[?.!]+$/, '') + '?' : text;
    try {
      const url = toUrl(await this.audio.speech(seat, line, {
        voice: null, sim: state.sim, role: 'assistant', signal,
      }));
      if (!url || signal.aborted || this.now() - started_at > this.settings.serviceTimeoutMs
          || generation !== this.generation || this.phase !== 'live' || this.canned
          || !state.online || state.pending || (kind === 'draft' && !this.canDraft(seat))) return;
      if (automatic && (this.lastSpeechAt() !== speechAt || !this.canWhisperAutomatically(seat, text))) return;
      if (automatic) this.rememberAutomaticCue(text);
      if (kind === 'draft') {
        state.lastDraftAt = this.now();
        state.lastDraftFingerprint = fingerprint;
      } else {
        state.lastSuggestionAt = this.now();
      }
      const pending = {
        id: 'draft-' + ++this.sequence, text, kind, preset, decisionAt,
        expiresAt: this.now() + this.settings.draftExpiryMs,
        ...answer,
      };
      this.setPending(seat, pending);
      this.append(kind === 'draft' ? 'draft' : 'preset_suggestion', { seat, text, draftId: pending.id });
      this.cue(seat, kind === 'draft' ? 'draft' : 'system', {
        url, text, messageId: pending.id, decisionAt, expiresAt: pending.expiresAt,
      });
      this.publish();
    } catch {}
  }

  setPending(seat, pending) {
    const state = this.seats[seat];
    clearTimeout(state.pendingTimer);
    state.pending = pending;
    state.pendingTimer = setTimeout(() => {
      if (this.seats[seat].pending !== pending) return;
      this.clearPending(seat, 'expired');
      this.publish();
    }, Math.max(0, pending.expiresAt - this.now()));
    state.pendingTimer.unref();
  }

  expirePending(seat) {
    const pending = this.seats[seat].pending;
    if (pending && pending.expiresAt <= this.now()) this.clearPending(seat, 'expired');
  }

  clearPending(seat, reason) {
    const state = this.seats[seat];
    const pending = state.pending;
    if (!pending) return null;
    clearTimeout(state.pendingTimer);
    state.pending = null;
    state.pendingTimer = null;
    if (pending.answerVersion != null && ['confirmed', 'discarded', 'expired'].includes(reason)) {
      this.dismissedQuestions.add(pending.suggestionKey ?? 'answer:' + questionKey(pending.question));
      this.questionState = { ...this.questionState, status: reason };
    }
    this.append(reason === 'confirmed' ? 'confirm' : 'discard', {
      seat, text: pending.text, draftId: pending.id, reason,
    });
    return pending;
  }

  async confirmPending(seat) {
    const candidate = this.seats[seat].pending;
    if (!candidate) return;
    if (candidate.answerVersion != null && candidate.answerVersion !== this.answerVersion) {
      this.clearPending(seat, 'stale');
      this.publish();
      return;
    }
    const pending = this.clearPending(seat, 'confirmed');
    this.publish();
    if (pending.kind === 'preset') return this.selectPreset(pending.preset);
    const generation = this.generation;
    const state = this.seats[seat];
    const recipient = partnerOf(seat);
    const receiver = this.seats[recipient];
    const lifecycle = pending.answerVersion != null && this.answerController
      ? AbortSignal.any([this.liveScope([seat, recipient]), this.answerController.signal]) : this.liveScope([seat, recipient]);
    if (!receiver.online) return;
    try {
      const url = toUrl(await withDeadline(signal => this.audio.speech(seat, pending.text, {
        voice: state.voiceRef, sim: state.sim, role: 'seat', signal,
      }), this.settings.serviceTimeoutMs, lifecycle));
      if (!url || lifecycle.aborted || generation !== this.generation || this.phase !== 'live' || this.canned || !receiver.online
          || pending.answerVersion != null && pending.answerVersion !== this.answerVersion) return;
      this.deliver(seat, 'R1', pending.text, { cue: 'soft', url }, 1, 'smart');
    } catch {}
  }

  async readCodebook(seat) {
    const generation = this.generation;
    const state = this.seats[seat];
    const lifecycle = this.liveScope([seat]);
    const preset = this.preset;
    const text = codebookReadout(preset, state.mode);
    try {
      const url = toUrl(await withDeadline(signal => this.audio.speech(seat, text, {
        voice: null, sim: state.sim, role: 'codebook', signal,
      }), this.settings.serviceTimeoutMs, lifecycle));
      if (url && !lifecycle.aborted && generation === this.generation && preset === this.preset && this.phase === 'live' && !this.canned) {
        this.cue(seat, 'system', { url, text, rate: 1.06 });
      }
    } catch {}
  }

  snapshotAnnouncement() {
    const announcement = this.announcement;
    if (!announcement) return null;
    const { id, text, status, targets, heard, disconnected, reason } = announcement;
    return { id, text, status, targets: [...targets.keys()], heard: SEATS.filter(seat => heard.has(seat)),
      disconnected: SEATS.filter(seat => disconnected.has(seat)), ...(reason && { reason }) };
  }

  async announce(value, approvedCoach) {
    if (this.canned || this.phase === 'reveal' || announcementInFlight(this.announcement)) return;
    const text = announcementText(value);
    if (!text) return;
    const targets = new Map(SEATS.filter(seat => this.seats[seat].online)
      .map(seat => [seat, this.seats[seat].connection]));
    const announcement = {
      id: 'announcement-' + ++this.sequence, text, targets, heard: new Set(), disconnected: new Set(),
      status: 'building', lifecycle: new AbortController(),
    };
    this.announcement = announcement;
    if (approvedCoach) {
      this.coachState = { ...approvedCoach, status: 'sent', announcementId: announcement.id };
    }
    if (targets.size === 0) this.finishAnnouncement('no_seats');
    this.publish();
    if (announcement.status !== 'building') return;

    const lifecycle = AbortSignal.any([this.lifecycle.signal, announcement.lifecycle.signal]);
    const sim = [...targets.keys()].every(seat => this.seats[seat].sim);
    let url;
    try {
      url = toUrl(await withDeadline(signal => this.audio.announcement
        ? this.audio.announcement(text, { sim, signal })
        : this.audio.speech('A', text, { role: 'system', sim, signal }), this.settings.serviceTimeoutMs, lifecycle));
    } catch (error) {
      if (!lifecycle.aborted) {
        this.finishAnnouncement(error?.message === 'Service deadline exceeded' ? 'speech_timeout' : 'voice_unavailable');
        this.publish();
      }
      return;
    }
    if (lifecycle.aborted || this.announcement !== announcement) return;
    if (!url) {
      this.finishAnnouncement('voice_unavailable');
      this.publish();
      return;
    }

    announcement.status = 'queued';
    announcement.expiresAt = this.now() + this.settings.announcementPlaybackMs;
    announcement.timer = setTimeout(() => {
      if (this.announcement !== announcement || announcement.status !== 'queued') return;
      this.finishAnnouncement('playback_timeout');
      this.publish();
    }, this.settings.announcementPlaybackMs);
    announcement.timer.unref();
    this.append('announcement', { seat: null, source: 'operator', text });
    for (const [seat, connection] of targets) {
      if (connection.signal.aborted) continue;
      this.cue(seat, 'system', {
        kind: 'announcement', url, text, messageId: announcement.id, expiresAt: announcement.expiresAt,
        expiresAfterMs: this.settings.announcementPlaybackMs,
      });
    }
    this.publish();
  }

  hearAnnouncement(announcement, seat) {
    const connection = announcement.targets.get(seat);
    if (announcement.status !== 'queued' || !connection || connection.signal.aborted || announcement.heard.has(seat)) return;
    if (this.now() >= announcement.expiresAt) {
      this.finishAnnouncement('playback_timeout');
    } else {
      announcement.heard.add(seat);
      this.checkAnnouncementTargets(announcement);
    }
    this.publish();
  }

  checkAnnouncementTargets(announcement) {
    if (![...announcement.targets].every(([seat, connection]) => announcement.heard.has(seat) || connection.signal.aborted)) return;
    this.finishAnnouncement(announcement.targets.size < SEATS.length ? 'seat_offline' : 'seat_left');
  }

  finishAnnouncement(reason) {
    const announcement = this.announcement;
    if (!announcementInFlight(announcement)) return;
    clearTimeout(announcement.timer);
    announcement.lifecycle.abort();
    const heard = announcement.heard.size;
    announcement.status = heard === SEATS.length ? 'played' : heard > 0 ? 'partial' : 'failed';
    if (announcement.status !== 'played') announcement.reason = reason;
  }

  async askCoach(beat) {
    if (this.phase !== 'live' || this.canned || this.preset !== 'Pitch' || this.coachState.status === 'asking') return;
    const input = normalizePitch({
      beat,
      elapsedSeconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1_000)),
      onlineSeats: SEATS.filter(seat => this.seats[seat].online).length,
      readySeats: SEATS.filter(seat => this.isReady(seat)).length,
      acknowledgedMessages: this.log.filter(entry => entry.kind === 'receipt').length,
    });
    if (!input) return;

    const pending = { status: 'asking', beat: input.beat, id: 'coach-' + ++this.sequence };
    const scope = this.liveScope();
    this.coachState = pending;
    this.emitStage({ type: 'state', state: this.snapshot() });

    let recommendation;
    if (this.coach) {
      try {
        recommendation = await withDeadline(signal => this.coach.recommend(input, { signal }), this.settings.coachTimeoutMs, scope);
      } catch {}
    }
    if (scope.aborted || this.coachState !== pending) return;

    const findCue = id => OPERATOR_ANNOUNCEMENTS.find(line => line.id === id);
    if (!findCue(recommendation?.cueId)) recommendation = { ...recommendLocally(input), source: 'local' };
    const cue = findCue(recommendation.cueId);
    this.coachState = {
      ...pending, status: 'ready', text: cue.text, reason: recommendation.reason, source: recommendation.source,
    };
    this.emitStage({ type: 'state', state: this.snapshot() });
  }

  approveCoach(id) {
    const current = this.coachState;
    if (this.phase !== 'live' || this.canned || this.preset !== 'Pitch' || current.status !== 'ready'
      || current.id !== id || !SEATS.every(seat => this.seats[seat].online)) return;
    return this.announce(current.text, current);
  }

  async handleStage(frame) {
    if (this.closed || !frame) return;
    switch (frame.action) {
      case 'begin':
        if (this.phase !== 'lobby' || this.referencesLoading || !SEATS.every(seat => this.isReady(seat))) return;
        this.phase = 'live';
        this.startedAt = this.now();
        this.startSensing();
        if (this.room.listening) this.schedulePitchPlanning();
        break;
      case 'preset': return this.selectPreset(frame.preset, frame.context);
      case 'coach_scenario': return this.selectCoachScenario(frame.scenario);
      case 'announce': return this.announce(frame.text);
      case 'room_speaker_assign': return this.assignRoomSpeaker(frame);
      case 'room_transcript_clear':
        if (this.roomInput !== 'mac' || this.canned || this.phase === 'reveal') return;
        this.clearPitchPlanning();
        for (const seat of SEATS) {
          this.stopQuestionMode(seat);
          this.seats[seat].pitchHelp?.abort();
        }
        this.room.transcript = [];
        this.room.partial = null;
        this.questionTurns = this.questionTurns.filter(turn => turn.seat !== 'room');
        this.monitor.updatePartial('room', '');
        this.cancelAnswers('room_transcript_cleared');
        break;
      case 'coach_ask': return this.askCoach(frame.beat);
      case 'coach_send': return this.approveCoach(frame.coachId);
      case 'inject':
        if (this.phase !== 'live' || this.canned || !SEATS.includes(frame.seat)) return;
        this.sendFixed(frame.seat, frame.signal, 'operator');
        break;
      case 'replay': {
        if (!this.canReplay()) return;
        const { entry, cue, url } = this.lastReplay;
        this.append('replay', { seat: entry.seat, to: entry.to, text: entry.text, messageId: entry.messageId });
        this.cue(entry.to, cue, { url, text: entry.text });
        break;
      }
      case 'reveal':
        if (this.phase !== 'live') return;
        for (const timer of this.cannedTimers) clearTimeout(timer);
        this.cannedTimers.clear();
        this.phase = 'reveal';
        this.finishLive('reveal');
        break;
      case 'canned': return this.playCanned();
      case 'reset': return this.reset();
      default: return;
    }
    this.publish();
  }

  playCanned() {
    for (const timer of this.cannedTimers) clearTimeout(timer);
    this.cannedTimers.clear();
    this.finishLive('canned');
    this.canned = true;
    this.phase = 'live';
    this.preset = 'Pitch';
    this.context = this.settings.pitchContext;
    this.targetPreset = { preset: this.preset, context: this.context };
    this.startedAt = this.now();
    this.log = [];
    this.bits = 0;
    this.lastReplay = null;
    this.audio.retainReplayAsset?.(null);
    for (const seat of SEATS) {
      this.seats[seat].lastIn = null;
      this.seats[seat].lastOut = null;
      this.seats[seat].transcript = [];
      this.seats[seat].situation = seat === 'A' ? 'Presenting Telepathy' : 'Watching the judges';
    }
    this.publish();

    const scale = this.settings.cannedTimeScale ?? 1;
    for (const beat of CANNED_PITCH) {
      const timer = setTimeout(() => {
        this.cannedTimers.delete(timer);
        if (!this.canned || this.closed) return;
        this.playCannedBeat(beat);
        this.publish();
      }, beat.delay * scale);
      this.cannedTimers.add(timer);
    }
  }

  playCannedBeat({ seat, transcript, signal, receipt, draft, confirm, reveal }) {
    const source = 'canned';
    if (reveal) {
      this.phase = 'reveal';
    } else if (transcript) {
      this.seats[seat].transcript.push({ at: this.now(), text: transcript });
    } else if (receipt) {
      const last = this.seats[seat].lastIn;
      if (last) {
        this.append('signal', { seat, signal: 'R1', source });
        this.append('receipt', { seat, to: last.seat, text: last.text, messageId: last.messageId, bits: 0, source });
      }
    } else if (draft) {
      this.append('draft', { seat, text: draft, source });
      this.emitStage({ type: 'audio', cue: 'draft', text: draftPrompt(draft), voiceRole: 'assistant' });
    } else if (confirm) {
      this.append('confirm', { seat, text: confirm, source });
      this.cannedMessage(seat, 'R1', confirm);
    } else if (signal) {
      this.cannedMessage(seat, signal);
    }
  }

  cannedMessage(seat, signal, smartText) {
    const text = smartText ?? BOOKS.Pitch[signal];
    const partner = partnerOf(seat);
    const bits = smartText ? 1 : 2;
    this.append('signal', { seat, signal, source: 'canned' });
    const event = this.append('message', {
      seat, to: partner, signal, text, bits, messageKind: smartText ? 'smart' : 'fixed', source: 'canned',
      messageId: 'canned-' + ++this.sequence, preset: 'Pitch',
    });
    this.bits += bits;
    this.seats[seat].lastOut = event;
    this.seats[partner].lastIn = event;
    this.emitStage({ type: 'audio', cue: signal === 'OUT' ? 'urgent' : 'soft', text, voiceRole: seat });
  }

  clearTimers() {
    for (const seat of SEATS) this.stopQuestionMode(seat);
    this.clearPitchPlanning();
    clearTimeout(this.researchTimer);
    this.researchTimer = null;
    this.researchPending = null;
    this.stopRoomListening();
    this.cancelAnswers('reset');
    this.finishAnnouncement('reset');
    clearInterval(this.senseTimer);
    this.senseTimer = null;
    for (const timer of this.cannedTimers) clearTimeout(timer);
    this.cannedTimers.clear();
    this.replaceCacheCandidate(null);
    for (const seat of SEATS) clearTimeout(this.seats[seat].pendingTimer);
  }

  async reset() {
    this.clearTimers();
    this.lifecycle.abort();
    this.codec?.reset?.();
    const previous = this.seats;
    const connections = Object.fromEntries(SEATS.map(seat => [
      seat, { online: previous[seat].online, sim: previous[seat].sim, connected: previous[seat].connected },
    ]));
    this.initialize(connections);
    this.setupReset = this.sessionId;
    const cleanup = this.disposeAudio(previous);
    this.publish();
    await cleanup;
  }

  async disposeAudio(seats) {
    try { await this.audio.reset?.(); } catch {}
    await Promise.all(SEATS.map(seat => this.removeVoice(seats[seat].voiceRef)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.lifecycle.abort();
    this.codec?.reset?.();
    await this.disposeAudio(this.seats);
  }
}
