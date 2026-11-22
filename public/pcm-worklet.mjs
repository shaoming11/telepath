const TARGET_RATE = 16000;
const ZERO_CROSSINGS = 8;
const PHASES = 256;
const CUTOFF = 0.45;
const DEFAULT_FRAME_SAMPLES = 4000;

function sinc(value) {
  if (Math.abs(value) < 1e-9) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function blackman(position) {
  return 0.42 + 0.5 * Math.cos(Math.PI * position) + 0.08 * Math.cos(2 * Math.PI * position);
}

function build_filter(ratio) {
  const cutoff = Math.min(CUTOFF, CUTOFF / ratio);
  const half = Math.ceil(ZERO_CROSSINGS / (2 * cutoff));
  const taps = 2 * half;
  const table = new Float32Array(PHASES * taps);
  for (let phase = 0; phase < PHASES; phase += 1) {
    const fraction = phase / PHASES;
    let sum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = tap - half + 1 - fraction;
      const position = distance / half;
      const value = Math.abs(position) >= 1 ? 0 : 2 * cutoff * sinc(2 * cutoff * distance) * blackman(position);
      table[phase * taps + tap] = value;
      sum += value;
    }
    for (let tap = 0; tap < taps; tap += 1) table[phase * taps + tap] /= sum;
  }
  return { half, taps, table };
}

class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frame_samples = options?.processorOptions?.frame_samples;
    this.frame_samples = Number.isInteger(frame_samples) && frame_samples > 0 ? frame_samples : DEFAULT_FRAME_SAMPLES;
    this.ratio = sampleRate / TARGET_RATE;
    this.filter = build_filter(this.ratio);
    this.buffer = new Float32Array(Math.max(4096, this.filter.taps * 4));
    this.fill = 0;
    this.read_position = this.filter.half;
    this.frame = new Int16Array(this.frame_samples);
    this.frame_fill = 0;
    this.energy = 0;
    this.running = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'stop') this.running = false;
    };
  }

  push_sample(value) {
    const clipped = Math.max(-1, Math.min(1, value));
    this.energy += clipped * clipped;
    this.frame[this.frame_fill] = Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767);
    this.frame_fill += 1;
    if (this.frame_fill < this.frame_samples) return;
    const level = Math.sqrt(this.energy / this.frame_samples);
    const pcm = this.frame.buffer;
    this.port.postMessage({ pcm, level }, [pcm]);
    this.frame = new Int16Array(this.frame_samples);
    this.frame_fill = 0;
    this.energy = 0;
  }

  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;

    const frames = channels[0].length;
    if (this.fill + frames > this.buffer.length) {
      const larger = new Float32Array(Math.max(this.buffer.length * 2, this.fill + frames));
      larger.set(this.buffer.subarray(0, this.fill));
      this.buffer = larger;
    }
    for (let index = 0; index < frames; index += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[index];
      this.buffer[this.fill + index] = mixed / channels.length;
    }
    this.fill += frames;

    const { half, taps, table } = this.filter;
    while (Math.floor(this.read_position) + half < this.fill) {
      const center = Math.floor(this.read_position);
      const phase = Math.min(PHASES - 1, Math.floor((this.read_position - center) * PHASES));
      const offset = phase * taps;
      const first = center - half + 1;
      let sample = 0;
      for (let tap = 0; tap < taps; tap += 1) sample += this.buffer[first + tap] * table[offset + tap];
      this.push_sample(sample);
      this.read_position += this.ratio;
    }

    const drop = Math.floor(this.read_position) - half + 1;
    if (drop > 0) {
      const usable = Math.min(drop, this.fill);
      this.buffer.copyWithin(0, usable, this.fill);
      this.fill -= usable;
      this.read_position -= usable;
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
