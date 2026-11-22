export const STORAGE_KEY = 'telepathy.phone.v1';
export const CONSENT_KEY = 'telepathy.phone.consent.v1';

export const APP_TIMING = Object.freeze({
  cueGapMs: 70,
  reconnectMinMs: 350,
  reconnectMaxMs: 3000,
  hubProbeMs: 4000,
  hubProbeTimeoutMs: 1800,
  audioRetryMs: 450,
  micFrameMs: 250,
  voiceSampleMs: 30000,
  roomSampleMs: 30000,
  calibrationLeadMs: 3000,
  calibrationWindowMs: 5200,
  calibrationRemovalWindowMs: 9000,
  calibrationSettleMs: 1500,
  calibrationRemovalSettleMs: 300,
  calibrationRestMs: 900,
  emulatedReactionMs: 420,
});

export const APP_TIMING_LIMITS = Object.freeze({
  micFrameMs: [50, 1000],
  voiceSampleMs: [5000, 36000],
  roomSampleMs: [5000, 120000],
});

export const DEFAULT_VOLUMES = Object.freeze({ cue: 0.72, voice: 0.58 });

export const SEAT_NAMES = Object.freeze(['A', 'B']);
export const PRESETS = Object.freeze(['Pitch', 'Party', 'Meeting', 'Custom']);

export const SIGNAL_LABELS = Object.freeze({
  R1: 'R1', R2: 'R2', L1: 'L1', L2: 'L2', LR: 'L-R', OUT: 'Out', BACK: 'Back',
});

export const PATTERN_LABELS = Object.freeze({
  2: Object.freeze({
    R1: 'Right double-tap',
    R2: 'Two fast right double-taps',
    L1: 'Left double-tap',
    L2: 'Two fast left double-taps',
    LR: 'Left, then right',
    OUT: 'Remove an earbud',
    BACK: 'Put the earbud back',
  }),
  1: Object.freeze({
    R1: 'One double-tap',
    R2: 'Two fast double-taps',
    L2: 'Double-tap, pause, double-tap',
    LR: 'Three fast double-taps',
    OUT: 'Remove the earbud',
    BACK: 'Put the earbud back',
  }),
});

export const SYSTEM_MEANINGS = Object.freeze({
  L2: 'Hear the codebook',
  LR: 'Ask for a smart message',
  BACK: 'Tell your partner you are back',
});

export const SIGNAL_ORDER = Object.freeze({
  2: Object.freeze(['R1', 'R2', 'L1', 'L2', 'LR', 'OUT', 'BACK']),
  1: Object.freeze(['R1', 'R2', 'L2', 'LR', 'OUT', 'BACK']),
});

export const CALIBRATION_SIGNALS = Object.freeze({
  2: Object.freeze(['R1', 'R2', 'L1', 'L2', 'LR']),
  1: Object.freeze(['R1', 'R2', 'L2', 'LR']),
});

export const VOICE_SCRIPT = 'The quiet room holds more than it shows. A glance across the table, a pause before the answer, a small nod from someone who already knows how this ends. Today I will speak slowly and clearly, so my voice can carry a short message without anyone noticing. Good ideas need good timing. Every judge, every question and every minute matters. When the moment arrives, I will hear it, trust it, and move on with a steady, easy smile.';

export const CONSENT_TEXT = 'I agree to record my voice to make a clone for this session, and to let the hub listen to this room while the dot is lit.';

export const MEASURE_TEXT = 'This measures the time from each on-screen cue to the moment an earbud action reaches this page, and how evenly you space your taps. That span includes your reaction, the earbud, Bluetooth and the operating system together. It cannot separate them, so it is physical input timing and not a radio latency figure.';
