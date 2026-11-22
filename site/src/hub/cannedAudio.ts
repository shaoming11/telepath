const CUE_GAP_S = 0.07;

export function createCannedAudio(base: string) {
  let context: AudioContext | null = null;
  let generation = 0;
  let cursor = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const cache = new Map<string, Promise<AudioBuffer | null>>();

  function load(path: string): Promise<AudioBuffer | null> {
    let pending = cache.get(path);
    if (!pending) {
      pending = (async () => {
        if (!context) return null;
        try {
          const response = await fetch(base + path);
          if (!response.ok) return null;
          return await context.decodeAudioData(await response.arrayBuffer());
        } catch {
          return null;
        }
      })();
      cache.set(path, pending);
    }
    return pending;
  }

  function start(buffer: AudioBuffer, at: number, gain: number) {
    if (!context) return;
    const source = context.createBufferSource();
    const level = context.createGain();
    level.gain.value = gain;
    source.buffer = buffer;
    source.connect(level).connect(context.destination);
    sources.add(source);
    source.addEventListener("ended", () => sources.delete(source));
    source.start(at);
  }

  return {
    unlock() {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      context ??= new Context();
      void context.resume().catch(() => {});
      for (const cue of ["soft", "urgent", "draft"]) void load("/assets/cue-" + cue + ".mp3");
    },
    async play(url: string, cue: string | null) {
      if (!context) return;
      const run = generation;
      const [cueBuffer, speech] = await Promise.all([cue ? load("/assets/cue-" + cue + ".mp3") : null, load(url)]);
      if (run !== generation || !context || context.state !== "running") return;
      let at = Math.max(context.currentTime + 0.03, cursor);
      if (cueBuffer) {
        start(cueBuffer, at, 0.6);
        at += cueBuffer.duration + CUE_GAP_S;
      }
      if (speech) {
        start(speech, at, 0.75);
        at += speech.duration;
      }
      cursor = at + CUE_GAP_S;
    },
    clear() {
      generation += 1;
      cursor = 0;
      for (const source of sources) {
        try { source.stop(); } catch { /* already ended */ }
      }
      sources.clear();
    },
  };
}
