const BAR_COUNT = 12;
const AUDIO_PHASE = { idle: 'Quiet', queued: 'Queued', playing: 'Playing', paused: 'Paused' };
const AGENT_PHASE = { idle: 'Waiting for context', evaluating: 'Reading context', drafting: 'Preparing a cue', ready: 'Context updated', error: 'Review unavailable' };

function meterView(label, values, status, active) {
  const samples = values?.slice(-BAR_COUNT) ?? [];
  const bars = Array.from({ length: BAR_COUNT }, (_, index) => {
    const sample = samples[index - BAR_COUNT + samples.length];
    const height = Number.isFinite(sample) ? Math.min(1, Math.sqrt(Math.max(0, sample)) * 1.7) : 0;
    return Math.round(height * 100);
  });
  return { label, status, active, bars };
}

export function channelMonitorView(seatIds, snapshot, output) {
  const agent = snapshot?.agent;
  const sharedRoom = snapshot?.sharedRoom ?? null;
  const seats = seatIds.map(seat => {
    const value = snapshot?.seats?.[seat];
    const playback = output?.[seat] ?? value?.output;
    const micStatus = value?.transcription === 'unavailable' ? 'Transcription unavailable'
      : value?.listening ? value.transcription === 'live' ? 'Transcribing' : 'Mic listening'
      : sharedRoom || value?.online ? 'Mic off' : 'Waiting for seat';
    const input = value?.context;
    const summary = [input?.count ? input.count + (input.count === 1 ? ' line read' : ' lines read') : '', value?.situation]
      .filter(Boolean).join(' · ');
    const showRoom = seatIds.length === 1 || sharedRoom == null || sharedRoom === seat;
    return {
      seat,
      title: 'Seat ' + seat + (value?.name && value.name !== 'Seat ' + seat ? ' · ' + value.name : ''),
      mic: showRoom ? meterView(sharedRoom ? 'Shared Mac microphone' : 'Room input', value?.input,
        !sharedRoom && value?.source === 'companion' && value.listening ? 'Room mic · ' + micStatus : micStatus, Boolean(value?.listening)) : null,
      output: meterView(seatIds.length === 1 ? 'This phone’s audio' : 'Audio output',
        playback?.bars, AUDIO_PHASE[playback?.phase] ?? 'Quiet', playback?.phase === 'playing'),
      audioTitle: playback?.title ?? '',
      recent: showRoom ? value?.recentRuns ?? [] : [],
      partial: showRoom && value?.partial ? 'Live · ' + value.partial : '',
      summary: showRoom ? summary || 'No context update yet' : '',
      excerpt: showRoom && input?.excerpt ? 'Context read · ' + input.excerpt : '',
    };
  });
  return {
    mode: agent?.phase ?? 'idle',
    phase: AGENT_PHASE[agent?.phase] ?? AGENT_PHASE.idle,
    description: [agent?.summary, agent?.preset, agent?.mode].filter(Boolean).join(' · ') || 'Context agent standing by',
    sharedRoom,
    seats,
  };
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function write(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function meter(label) {
  const container = node('div', 'channel-meter');
  const header = node('div', 'channel-meter__head');
  const title = node('b', null, label);
  const state = node('span', 'channel-meter__state');
  header.append(title, state);
  const waveform = node('div', 'channel-meter__wave');
  waveform.setAttribute('aria-hidden', 'true');
  const bars = Array.from({ length: BAR_COUNT }, () => node('i'));
  waveform.append(...bars);
  container.append(header, waveform);
  return {
    container,
    update(view) {
      container.hidden = !view;
      if (!view) return;
      write(title, view.label);
      write(state, view.status);
      container.dataset.active = String(view.active);
      bars.forEach((bar, index) => {
        bar.style.height = 'max(2px, ' + view.bars[index] + '%)';
      });
    },
  };
}

function seatLane(seat) {
  const lane = node('article', 'channel-seat');
  lane.dataset.seat = seat;
  const heading = node('h3', 'channel-seat__title', 'Seat ' + seat);
  const mic = meter('Room input');
  const output = meter('Audio output');
  const audioTitle = node('p', 'channel-seat__output');
  const speech = node('ol', 'channel-seat__speech');
  const partial = node('p', 'channel-seat__context');
  const context = node('p', 'channel-seat__context');
  const excerpt = node('p', 'channel-seat__excerpt');
  let lastSpeech;
  lane.append(heading, mic.container, output.container, audioTitle, speech, partial, context, excerpt);
  return {
    lane,
    update(view) {
      write(heading, view.title);
      mic.update(view.mic);
      output.update(view.output);
      write(audioTitle, view.audioTitle);
      const speechKey = JSON.stringify(view.recent);
      if (speechKey !== lastSpeech) {
        lastSpeech = speechKey;
        speech.replaceChildren(...view.recent.map(run => {
          const item = node('li');
          item.append(node('b', null, run.label), node('span', null, run.text));
          return item;
        }));
      }
      write(partial, view.partial);
      write(context, view.summary);
      write(excerpt, view.excerpt);
    },
  };
}

export function mountChannelMonitor(host, seatIds) {
  if (!host) return null;
  if (host.dataset.channelOwner === 'react') {
    let previous = '';
    return {
      update(snapshot, output) {
        const view = channelMonitorView(seatIds, snapshot, output);
        const state = JSON.stringify(view);
        if (state === previous) return;
        previous = state;
        host.dispatchEvent(new CustomEvent('telepathy:channel-monitor', { detail: view }));
      },
    };
  }
  const heading = node('div', 'channel-monitor__head');
  const title = node('h2', 'channel-monitor__title', 'Live monitor');
  const phase = node('span', 'channel-monitor__phase');
  heading.append(title, phase);
  const agent = node('p', 'channel-monitor__agent');
  const lanes = node('div', 'channel-monitor__lanes');
  const components = seatIds.map(seatLane);
  lanes.append(...components.map(item => item.lane));
  host.replaceChildren(heading, agent, lanes);
  return {
    update(snapshot, output) {
      const view = channelMonitorView(seatIds, snapshot, output);
      host.dataset.agent = view.mode;
      write(phase, view.phase);
      write(agent, view.description);
      components.forEach((component, index) => component.update(view.seats[index]));
    },
  };
}
