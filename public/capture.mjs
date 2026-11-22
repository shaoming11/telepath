export const PCM_RATE = 16000;

const WORKLET_URL = new URL('./pcm-worklet.mjs', import.meta.url);
const WORKLET_NAME = 'pcm-worklet';
const BASE64_CHUNK = 0x6000;
const WAV_HEADER_BYTES = 44;
const RESUME_WAIT_MS = 600;
const RECORDING_GRACE_MS = 10_000;
const MIN_CLONE_SPEECH_SAMPLES = 15 * PCM_RATE;
const MAX_CLONE_SAMPLES = 36 * PCM_RATE;
const PAUSE_PAD_SAMPLES = Math.round(PCM_RATE * 0.16);
const CLONE_CAPTURE_LIMIT_MS = 120_000;
const MIC_CONSTRAINTS = Object.freeze({
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
});

export function bytes_to_base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function encode_wav(chunks, sample_rate = PCM_RATE) {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const data_bytes = samples * 2;
  const output = new Uint8Array(WAV_HEADER_BYTES + data_bytes);
  const view = new DataView(output.buffer);
  const write_text = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write_text(0, 'RIFF');
  view.setUint32(4, 36 + data_bytes, true);
  write_text(8, 'WAVE');
  write_text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sample_rate, true);
  view.setUint32(28, sample_rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write_text(36, 'data');
  view.setUint32(40, data_bytes, true);
  let cursor = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      view.setInt16(cursor, chunk[index], true);
      cursor += 2;
    }
  }
  return output;
}

function set_audio_session(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {}
}

function resume_context(context) {
  if (context.state === 'running') return Promise.resolve(true);
  return Promise.race([
    context.resume().then(() => context.state === 'running').catch(() => false),
    new Promise(resolve => setTimeout(() => resolve(context.state === 'running'), RESUME_WAIT_MS)),
  ]);
}

export function createCapture({ get_context, frame_ms, on_frame, on_level, on_state, get_constraints }) {
  const prepared_contexts = new WeakSet();
  let status = 'idle';
  let stream = null;
  let source = null;
  let node = null;
  let sink = null;
  let opening = null;
  let opening_token = 0;
  let epoch = 0;
  let recording = null;

  function set_status(next, detail) {
    status = next;
    on_state?.(next, detail);
  }

  function fail_recording(message) {
    if (!recording) return;
    const { reject, timer } = recording;
    clearTimeout(timer);
    recording = null;
    reject(new Error(message));
  }

  function release_graph() {
    try { node?.port.postMessage({ type: 'stop' }); } catch {}
    try { source?.disconnect(); } catch {}
    try { node?.disconnect(); } catch {}
    try { sink?.disconnect(); } catch {}
    if (node) node.port.onmessage = null;
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    }
    stream = null;
    source = null;
    node = null;
    sink = null;
  }

  function receive({ data }) {
    if (!data?.pcm) return;
    const pcm = new Int16Array(data.pcm);
    if (!pcm.length) return;
    on_level?.(data.level);
    on_frame?.({
      audio: bytes_to_base64(new Uint8Array(pcm.buffer)),
      level: Math.min(1, Math.max(0, data.level)),
    });
    if (!recording) return;
    if (recording.adaptive) {
      const quiet = !Number.isFinite(data.level) || data.level < 0.009;
      let clipped = 0;
      for (let index = 0; index < pcm.length; index += 8) {
        if (Math.abs(pcm[index]) >= 32000) clipped += 1;
      }
      if (quiet || clipped * 8 >= pcm.length * 0.05) {
        if (quiet) recording.pause = pcm.subarray(Math.max(0, pcm.length - PAUSE_PAD_SAMPLES));
        recording.on_progress?.(recording.voiced / recording.target, {
          seconds: recording.voiced / PCM_RATE, ready: recording.voiced >= MIN_CLONE_SPEECH_SAMPLES, quiet, clipped: !quiet,
        });
        return;
      }
      if (recording.pause && recording.samples) {
        const pad = recording.pause.subarray(0, MAX_CLONE_SAMPLES - recording.samples);
        recording.chunks.push(pad);
        recording.samples += pad.length;
      }
      recording.pause = null;
      const speech = pcm.subarray(0, Math.min(recording.target - recording.voiced, MAX_CLONE_SAMPLES - recording.samples));
      recording.chunks.push(speech);
      recording.samples += speech.length;
      recording.voiced += speech.length;
      recording.on_progress?.(recording.voiced / recording.target, {
        seconds: recording.voiced / PCM_RATE, ready: recording.voiced >= MIN_CLONE_SPEECH_SAMPLES,
      });
      if (recording.voiced >= recording.target) finish_recording();
      else if (recording.samples >= MAX_CLONE_SAMPLES) {
        if (recording.voiced >= MIN_CLONE_SPEECH_SAMPLES) finish_recording();
        else fail_recording('Too little usable speech. Try again closer to the microphone.');
      }
      return;
    }
    recording.chunks.push(pcm);
    recording.samples += pcm.length;
    recording.on_progress?.(Math.min(1, recording.samples / recording.target));
    if (recording.samples < recording.target) return;
    finish_recording();
  }

  function finish_recording() {
    const { chunks, target, samples, adaptive, resolve, timer } = recording;
    clearTimeout(timer);
    recording = null;
    const length = adaptive ? samples : target;
    let remaining = length;
    const trimmed = [];
    for (const chunk of chunks) {
      if (remaining <= 0) break;
      trimmed.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      remaining -= chunk.length;
    }
    resolve({ wav: bytes_to_base64(encode_wav(trimmed)), samples: length, duration_ms: length / PCM_RATE * 1000 });
  }

  function stop_tracks(media) {
    for (const track of media?.getTracks() ?? []) {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    }
  }

  async function open() {
    if (!navigator.mediaDevices?.getUserMedia) {
      set_status('unsupported', 'This browser cannot open the microphone.');
      return false;
    }
    const context = get_context();
    if (!context?.audioWorklet) {
      set_status('unsupported', 'This browser cannot process microphone audio.');
      return false;
    }
    // stop() during a permission prompt or module load must not leave the microphone open afterwards.
    const token = epoch;
    const cancelled = () => token !== epoch;
    let acquired = null;
    set_status('requesting');
    set_audio_session('play-and-record');
    try {
      acquired = await navigator.mediaDevices.getUserMedia(get_constraints?.() ?? MIC_CONSTRAINTS);
      if (cancelled()) {
        stop_tracks(acquired);
        return false;
      }
      await resume_context(context);
      if (!prepared_contexts.has(context)) {
        await context.audioWorklet.addModule(WORKLET_URL);
        prepared_contexts.add(context);
      }
      if (cancelled()) {
        stop_tracks(acquired);
        return false;
      }
      const requested_ms = Number(frame_ms?.()) || 250;
      stream = acquired;
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { frame_samples: Math.round(PCM_RATE * requested_ms / 1000) },
      });
      sink = context.createGain();
      sink.gain.value = 0;
      node.port.onmessage = receive;
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          fail_recording('Microphone stopped.');
          release_graph();
          set_status('lost', 'The microphone stopped.');
        };
        track.onmute = () => { if (status === 'streaming') set_status('interrupted', 'The microphone is interrupted.'); };
        track.onunmute = () => {
          void resume_context(context);
          if (status === 'interrupted') set_status('streaming');
        };
      }
      set_status('streaming');
      return true;
    } catch (error) {
      if (cancelled()) {
        stop_tracks(acquired);
        return false;
      }
      stop_tracks(acquired);
      release_graph();
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      set_status(denied ? 'blocked' : 'error', denied ? 'Microphone permission was refused.' : 'The microphone could not start.');
      return false;
    }
  }

  function start() {
    if (stream) return Promise.resolve(true);
    if (!opening) {
      const attempt = open().finally(() => { if (opening === attempt) opening = null; });
      opening = attempt;
      opening_token = epoch;
      return attempt;
    }
    // An open that was cancelled by stop() resolves false. A start() after that stop wants a fresh one.
    if (opening_token === epoch) return opening;
    return opening.then(() => start());
  }

  return {
    start,
    stop() {
      epoch += 1;
      fail_recording('Microphone stopped.');
      release_graph();
      set_audio_session('playback');
      set_status('idle');
    },
    record({ duration_ms, speech_ms, on_progress }) {
      if (!stream) return Promise.reject(new Error('Microphone is not open.'));
      if (recording) return Promise.reject(new Error('Already recording.'));
      return new Promise((resolve, reject) => {
        const adaptive = Number.isFinite(speech_ms);
        recording = {
          chunks: [], samples: 0, voiced: 0, pause: null, adaptive,
          target: adaptive ? Math.min(MAX_CLONE_SAMPLES, Math.max(MIN_CLONE_SPEECH_SAMPLES, Math.round(PCM_RATE * speech_ms / 1000)))
            : Math.round(PCM_RATE * duration_ms / 1000),
          timer: setTimeout(() => {
            if (adaptive && recording.voiced >= MIN_CLONE_SPEECH_SAMPLES) finish_recording();
            else fail_recording(adaptive ? 'Too little usable speech. Try again closer to the microphone.' :
              'The microphone stopped delivering audio. Reconnect it and try again.');
          }, adaptive ? CLONE_CAPTURE_LIMIT_MS : duration_ms + RECORDING_GRACE_MS),
          on_progress, resolve, reject,
        };
      });
    },
    finish_record() {
      if (!recording?.adaptive || recording.voiced < MIN_CLONE_SPEECH_SAMPLES) return false;
      finish_recording();
      return true;
    },
    cancel_record() { fail_recording('Recording cancelled.'); },
    get status() { return status; },
    get deviceLabel() { return stream?.getAudioTracks()?.[0]?.label ?? ''; },
    get open() { return Boolean(stream); },
    get opening() { return Boolean(opening) && opening_token === epoch; },
    get recording() { return Boolean(recording); },
  };
}
