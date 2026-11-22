// Deterministic stand-ins for the browser pieces the phone modules touch. Nothing here uses a real
// clock, socket, microphone or audio device. `world.advance(ms)` moves the wall clock, every pending
// timer and (while running) the audio clock together, so tests control the order of events exactly.

export function createWorld() {
  const world = {
    now: 0,
    timers: [],
    next_timer: 1,
    contexts: [],
    durations: {},
    fetches: [],
    fetch_gate: null,
  };

  const add_timer = (fn, delay, interval) => {
    const timer = { id: world.next_timer++, fn, at: world.now + Math.max(0, Number(delay) || 0), interval: interval ? Math.max(1, Number(delay) || 1) : 0 };
    world.timers.push(timer);
    return timer.id;
  };
  const remove_timer = id => {
    world.timers = world.timers.filter(timer => timer.id !== id);
  };
  world.set_timeout = (fn, delay) => add_timer(fn, delay, false);
  world.set_interval = (fn, delay) => add_timer(fn, delay, true);
  world.clear_timer = id => { if (id != null) remove_timer(id); };

  world.advance = (ms, { audio = true } = {}) => {
    const end = world.now + ms;
    for (;;) {
      const due = world.timers.filter(timer => timer.at <= end).toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      const target = due ? due.at : end;
      const step = target - world.now;
      world.now = target;
      if (audio) for (const context of world.contexts) context.tick(step / 1000);
      if (!due) break;
      if (due.interval) due.at += due.interval;
      else remove_timer(due.id);
      due.fn();
    }
  };

  world.flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };

  class FakeSource {
    constructor(context) {
      this.context = context;
      this.playbackRate = { value: 1 };
      this.listeners = [];
      this.startAt = null;
      this.stopped = false;
      this.ended = false;
      this.buffer = null;
    }
    connect(destination) { this.destination = destination; }
    disconnect() {}
    addEventListener(type, fn) { if (type === 'ended') this.listeners.push(fn); }
    start(at = 0) { this.startAt = at; }
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this.finish();
    }
    finish() {
      if (this.ended) return;
      this.ended = true;
      for (const fn of this.listeners) fn();
    }
    get playing() {
      return this.startAt !== null && !this.stopped && this.context.currentTime >= this.startAt;
    }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = {};
      this.sources = [];
      this.listeners = [];
      this.resume_gate = null;
      this.audioWorklet = { modules: [], addModule: async url => { this.audioWorklet.modules.push(String(url)); } };
      world.contexts.push(this);
    }
    tick(seconds) {
      if (this.state !== 'running') return;
      this.currentTime += seconds;
      for (const source of this.sources) {
        if (source.startAt !== null && !source.stopped && this.currentTime >= source.startAt + (source.buffer?.duration ?? 0) / source.playbackRate.value) source.finish();
      }
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBuffer(channels, length, rate) { return { duration: length / rate }; }
    createBufferSource() {
      const source = new FakeSource(this);
      this.sources.push(source);
      return source;
    }
    createMediaStreamSource(stream) {
      return { stream, connect() {}, disconnect() {} };
    }
    decodeAudioData(data, ok) {
      const buffer = { duration: world.durations[data?.url] ?? 1, url: data?.url };
      ok?.(buffer);
      return Promise.resolve(buffer);
    }
    addEventListener(type, fn) { if (type === 'statechange') this.listeners.push(fn); }
    set_state(state) {
      this.state = state;
      for (const fn of this.listeners) fn();
    }
    resume() {
      if (this.state === 'running') return Promise.resolve();
      return new Promise(resolve => {
        this.resume_gate = () => {
          this.set_state('running');
          resolve();
        };
      });
    }
    allow_resume() { this.resume_gate?.(); this.resume_gate = null; }
    started() { return this.sources.filter(source => source.startAt !== null); }
    live() { return this.sources.filter(source => source.startAt !== null && !source.stopped); }
  }

  world.install = () => {
    const saved = new Map();
    const set = (name, value) => {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    };
    set('setTimeout', world.set_timeout);
    set('setInterval', world.set_interval);
    set('clearTimeout', world.clear_timer);
    set('clearInterval', world.clear_timer);
    set('performance', { now: () => world.now });
    set('AudioContext', FakeAudioContext);
    set('location', { href: 'https://hub.test/', protocol: 'https:', host: 'hub.test' });
    set('fetch', async url => {
      world.fetches.push(String(url));
      if (world.fetch_gate) await world.fetch_gate;
      return { ok: true, status: 200, arrayBuffer: async () => ({ url: String(url) }) };
    });
    return () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    };
  };

  return world;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
