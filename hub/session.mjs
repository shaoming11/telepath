import { BOOKS, CANNED_PITCH, DEFAULT_CONTEXT, SEATS, SIGNALS, bitsForMode, partnerOf } from './codebook.mjs';

import { codebookReadout, draftPrompt, STATUS_LINES } from './audio.mjs';
import { announcementText, OPERATOR_ANNOUNCEMENTS } from '../public/announcements.mjs';
import { normalizePitch, recommendLocally } from '../maritime/policy.mjs';

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
  pitchContext: DEFAULT_CONTEXT.Pitch,
  names: { A: 'Presenter', B: 'Coach' },
});

const USABLE_VOICES = new Set(['ready', 'fallback']);
const SYNCHRONIZED_STEPS = { earbuds: 'earbuds', calibrate: 'calibrated', ready: 'wantsReady' };
const CACHE_SIGNALS = Object.keys(BOOKS.Pitch);
const TRANSCRIPTION_STATUSES = new Set(['waiting', 'connecting', 'live', 'recovering', 'unavailable']);

function createSeat(name) {
  return {
    name, online: false, sim: false, mode: 2, drafts: true,
    connected: false, connection: new AbortController(),
    listening: false, listeningRequested: false, roomMicSource: null, transcription: 'off',
    voice: 'idle', voiceRef: null, voiceRequest: null,
    earbuds: false, calibrated: false, wantsReady: false,
    situation: '', transcript: [], level: 0, pending: null,
    lastIn: null, lastOut: null, lastDraftAt: -Infinity, lastSuggestionAt: -Infinity,
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
  const { draftId, receiptId, signal } = frame;
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
    return can_receipt && receipt.messageId === receiptId ? 'receipt' : 'skip';
  }

  const implicit_draft = pending && !Object.hasOwn(frame, 'draftId');
  if (implicit_draft && approve && pending.heardAt != null) return 'confirm';
  if (implicit_draft && discard) return 'discard';
  if (can_receipt && !Object.hasOwn(frame, 'receiptId')) return 'receipt';
  return implicit_draft && approve ? 'skip' : 'ordinary';
}

export class Session {
  constructor({ emitSeat, emitStage, audio, codec, coach, settings = {}, now = Date.now }) {
    this.emitSeat = emitSeat;
    this.emitStage = emitStage;
    this.audio = audio;
    this.codec = codec;
    this.coach = coach;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.now = now;
    this.generation = 0;
    this.setupReset = null;
    this.sequence = 0;
    this.senseTimer = null;
    this.cannedTimers = new Set();
    this.closed = false;
    this.initialize();
  }

  initialize(connections = {}) {
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
      presetPending: this.cacheCandidate?.preset ?? (this.targetPreset.preset !== this.preset ? this.targetPreset.preset : null),
      cacheId: this.activeCache?.id ?? null,
      context: this.context,
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
          receipt: visible && state.receipt?.until >= this.now()
            ? { messageId: state.receipt.messageId, until: state.receipt.until }
            : null,
          lastIn: visible ? state.lastIn : null, lastOut: visible ? state.lastOut : null,
        }];
      })),
      canBegin: SEATS.every(seat => this.isReady(seat)),
      startedAt: this.startedAt,
      canned: this.canned,
      ...(viewer == null && {
        announcement: this.snapshotAnnouncement(),
        coach: { available: Boolean(this.coach), ...this.coachState },
      }),
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
    const state = this.seats[seat];
    state.connection.abort();
    state.online = false;
    state.cacheId = null;
    state.receipt = null;
    state.awaitingHeard.clear();
    state.out = false;
    this.cacheCandidate?.ack.delete(seat);
    this.stopListening(seat);
    this.clearPending(seat, 'disconnect');
    const announcement = this.announcement;
    if (announcementInFlight(announcement) && announcement.targets.has(seat)) {
      this.checkAnnouncementTargets(announcement);
    }
  }

  liveScope(seats = []) {
    return AbortSignal.any([
      this.lifecycle.signal, this.scene.signal, ...seats.map(seat => this.seats[seat].connection.signal),
    ]);
  }

  cancelScene(reason) {
    this.scene.abort();
    this.scene = new AbortController();
    this.coachState = { status: 'idle' };
    for (const seat of SEATS) this.clearPending(seat, reason);
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
    if (this.seats[seat].online) this.emitSeat(seat, { type: 'audio', cue, sessionId: this.sessionId, ...options });
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
      await this.sense(seat);
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
    state.receipt = {
      from: entry.seat,
      text: entry.text,
      messageId: entry.messageId,
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

  addTranscript(seat, value, generation = this.generation) {
    const state = this.seats[seat];
    if (this.closed || generation !== this.generation || this.canned || this.phase === 'reveal' || !state.online) return;
    const text = cleanText(typeof value === 'string' ? value : value?.text, 1200);
    if (!text) return;
    state.transcript.push({ at: this.now(), text });
    this.publish();
  }

  levelValue(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  async receiveMic(seat, frame, source = 'phone') {
    const state = this.seats[seat];
    if (!state.listening || state.roomMicSource !== source || typeof frame.audio !== 'string' || frame.audio.length > 48_000) return;
    state.level = this.levelValue(frame.level);
    const generation = this.generation;
    const listen_version = state.listenVersion;
    try {
      await this.audio.mic?.(seat, frame.audio, state.level, text => {
        if (state.listenVersion === listen_version) this.addTranscript(seat, text, generation);
      });
    } catch {}
  }

  async setListening(seat, enabled, source = 'phone') {
    const state = this.seats[seat];
    if (!enabled) {
      if (state.roomMicSource !== source) return;
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
      const listening = await this.audio.listen?.(seat, true, text => {
        if (state.listenVersion === listen_version) this.addTranscript(seat, text, generation);
      });
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
    if (was_requested) {
      try { Promise.resolve(this.audio.listen?.(seat, false)).catch(() => {}); } catch {}
    }
  }

  finishLive(reason) {
    this.finishAnnouncement(reason);
    this.cancelScene(reason);
    this.replaceCacheCandidate(null);
    this.targetPreset = { preset: this.preset, context: this.context };
    clearInterval(this.senseTimer);
    this.senseTimer = null;
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
    if (!this.codec?.evaluate || this.sensing || this.phase !== 'live' || this.canned) return;
    if (requestedSeat && !this.canDraft(requestedSeat)) return;
    const started_at = this.now();
    const { preset, context, seats } = this.snapshot();
    for (const seat of SEATS) {
      seats[seat].transcript = seats[seat].transcript
        .filter(entry => started_at - entry.at <= this.settings.roomContextMs).slice(-12);
      seats[seat].level = this.seats[seat].level;
    }
    if (!requestedSeat && !SEATS.some(seat => seats[seat].transcript.length || seats[seat].level > 0.015)) return;
    const generation = this.generation;
    const connections = Object.fromEntries(SEATS.map(seat => [seat, this.seats[seat].connection.signal]));
    const lifecycle = this.liveScope(requestedSeat ? [requestedSeat] : []);
    this.sensing = true;
    const sim = requestedSeat ? seats[requestedSeat].sim
      : SEATS.every(seat => !seats[seat].online || seats[seat].sim);
    try {
      await withDeadline(async signal => {
        const result = await this.codec.evaluate({
          preset, context, now: this.now(), requestedSeat, sim, seats, signal,
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
        await Promise.all(suggestions.map(async person => {
          if (connections[person].aborted) return;
          const preview_signal = AbortSignal.any([signal, connections[person]]);
          const candidate = result?.candidates?.[person];
          if (Number.isFinite(candidate?.confidence) && candidate.confidence >= this.settings.draftConfidence && this.canDraft(person)) {
            const text = cleanText(candidate.text, 100);
            const evidence = SEATS.map(seat => this.seats[seat].transcript.at(-1)?.at ?? 0);
            const fingerprint = JSON.stringify([text, preset, ...evidence]);
            if (text && (requestedSeat || this.seats[person].lastDraftFingerprint !== fingerprint)) {
              await this.previewDraft(person, { kind: 'draft', text, started_at, signal: preview_signal, fingerprint });
            }
            return;
          }
          const suggested = typeof result?.suggestedPreset === 'string' ? result.suggestedPreset : result?.suggestedPreset?.[person];
          const state = this.seats[person];
          if (!requestedSeat && state.online && !state.pending && Object.hasOwn(BOOKS, suggested)
              && suggested !== this.preset && suggested !== 'Custom'
              && this.now() - state.lastSuggestionAt >= this.settings.draftCooldownMs) {
            const text = STATUS_LINES['sounds_like_' + suggested.toLowerCase()];
            await this.previewDraft(person, { kind: 'preset', text, preset: suggested, started_at, signal: preview_signal });
          }
        }));
      }, this.settings.serviceTimeoutMs, lifecycle);
    } catch {
    } finally {
      if (generation === this.generation) this.sensing = false;
    }
  }

  async previewDraft(seat, { kind, text, preset, started_at, signal, fingerprint }) {
    const generation = this.generation;
    const state = this.seats[seat];
    const decisionAt = this.now();
    const line = kind === 'draft' ? 'Send: ' + text.replace(/[?.!]+$/, '') + '?' : text;
    try {
      const url = toUrl(await this.audio.speech(seat, line, {
        voice: null, sim: state.sim, role: 'assistant', signal,
      }));
      if (!url || signal.aborted || this.now() - started_at > this.settings.serviceTimeoutMs
          || generation !== this.generation || this.phase !== 'live' || this.canned
          || !state.online || state.pending || (kind === 'draft' && !this.canDraft(seat))) return;
      if (kind === 'draft') {
        state.lastDraftAt = this.now();
        state.lastDraftFingerprint = fingerprint;
      } else {
        state.lastSuggestionAt = this.now();
      }
      const pending = {
        id: 'draft-' + ++this.sequence, text, kind, preset, decisionAt,
        expiresAt: this.now() + this.settings.draftExpiryMs,
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
    this.append(reason === 'confirmed' ? 'confirm' : 'discard', {
      seat, text: pending.text, draftId: pending.id, reason,
    });
    return pending;
  }

  async confirmPending(seat) {
    const pending = this.clearPending(seat, 'confirmed');
    this.publish();
    if (pending.kind === 'preset') return this.selectPreset(pending.preset);
    const generation = this.generation;
    const state = this.seats[seat];
    const recipient = partnerOf(seat);
    const receiver = this.seats[recipient];
    const lifecycle = this.liveScope([seat, recipient]);
    if (!receiver.online) return;
    try {
      const url = toUrl(await withDeadline(signal => this.audio.speech(seat, pending.text, {
        voice: state.voiceRef, sim: state.sim, role: 'seat', signal,
      }), this.settings.serviceTimeoutMs, lifecycle));
      if (!url || lifecycle.aborted || generation !== this.generation || this.phase !== 'live' || this.canned || !receiver.online) return;
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
    const { id, text, status, targets, heard, reason } = announcement;
    return { id, text, status, targets: [...targets.keys()], heard: SEATS.filter(seat => heard.has(seat)), ...(reason && { reason }) };
  }

  async announce(value, approvedCoach) {
    if (this.canned || this.phase === 'reveal' || announcementInFlight(this.announcement)) return;
    const text = announcementText(value);
    if (!text) return;
    const targets = new Map(SEATS.filter(seat => this.seats[seat].online)
      .map(seat => [seat, this.seats[seat].connection]));
    const announcement = {
      id: 'announcement-' + ++this.sequence, text, targets, heard: new Set(),
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
        if (this.phase !== 'lobby' || !SEATS.every(seat => this.isReady(seat))) return;
        this.phase = 'live';
        this.startedAt = this.now();
        this.startSensing();
        break;
      case 'preset': return this.selectPreset(frame.preset, frame.context);
      case 'announce': return this.announce(frame.text);
      case 'coach_ask': return this.askCoach(frame.beat);
      case 'coach_send': return this.approveCoach(frame.coachId);
      case 'inject':
        if (this.phase !== 'live' || this.canned || !SEATS.includes(frame.seat)) return;
        this.sendFixed(frame.seat, frame.signal, 'operator');
        break;
      case 'replay': {
        if (this.phase !== 'live' || this.canned) return;
        const replay = this.lastReplay;
        if (!replay || !this.seats[replay.entry.to].online) return;
        const { entry, cue, url } = replay;
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
