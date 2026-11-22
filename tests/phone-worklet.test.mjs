import assert from 'node:assert/strict';
import { test } from 'node:test';

let loads = 0;

// Loads public/pcm-worklet.mjs the way an AudioWorkletGlobalScope would, with a chosen device rate.
async function load_worklet(rate, frame_samples) {
  const saved = ['AudioWorkletProcessor', 'registerProcessor', 'sampleRate'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let Processor;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { posted: [], postMessage(message) { this.posted.push(message); } }; } };
  globalThis.registerProcessor = (name, klass) => { Processor = klass; };
  globalThis.sampleRate = rate;
  try {
    await import('../public/pcm-worklet.mjs?rate=' + rate + '&n=' + frame_samples + '&load=' + (loads += 1));
    return new Processor({ processorOptions: { frame_samples } });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

function feed(processor, signal, block = 128) {
  for (let offset = 0; offset < signal.length; offset += block) {
    processor.process([[signal.subarray(offset, offset + block)]]);
  }
}

const frames_of = processor => processor.port.posted.map(message => ({ pcm: new Int16Array(message.pcm), level: message.level }));

test('48 kHz input becomes 16 kHz frames of the requested size with a steady tone intact', async () => {
  const processor = await load_worklet(48000, 800);
  const seconds = 1;
  const input = new Float32Array(48000 * seconds).map((_, index) => 0.5 * Math.sin(2 * Math.PI * 1000 * index / 48000));
  feed(processor, input);
  const frames = frames_of(processor);
  assert.ok(frames.length >= 18 && frames.length <= 20, 'about one second of 800-sample frames: ' + frames.length);
  for (const { pcm } of frames) assert.equal(pcm.length, 800);
  const settled = frames.slice(2);
  for (const { level } of settled) assert.ok(Math.abs(level - 0.5 / Math.SQRT2) < 0.03, 'tone RMS survives resampling: ' + level);
});

test('44.1 kHz input keeps frame boundaries when audio arrives in odd block sizes', async () => {
  const processor = await load_worklet(44100, 400);
  const input = new Float32Array(44100).map((_, index) => 0.25 * Math.sin(2 * Math.PI * 440 * index / 44100));
  feed(processor, input, 100);
  const frames = frames_of(processor);
  assert.ok(frames.length >= 38);
  assert.ok(frames.every(({ pcm }) => pcm.length === 400));
});

test('content above the new Nyquist is rejected instead of folding into the speech band', async () => {
  const processor = await load_worklet(48000, 800);
  const input = new Float32Array(48000).map((_, index) => 0.5 * Math.sin(2 * Math.PI * 12000 * index / 48000));
  feed(processor, input);
  const settled = frames_of(processor).slice(2);
  assert.ok(settled.length > 10);
  for (const { level } of settled) assert.ok(level < 0.02, 'aliased level ' + level);
});

test('stop message ends the processor and silence input yields no frames', async () => {
  const processor = await load_worklet(48000, 800);
  assert.equal(processor.process([[]]), true);
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(processor.process([[new Float32Array(128)]]), false);
  assert.equal(processor.port.posted.length, 0);
});
