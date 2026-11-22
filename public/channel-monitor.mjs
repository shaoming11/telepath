const BAR_COUNT = 12;
const AUDIO_PHASE = { idle: 'Quiet', queued: 'Queued', playing: 'Playing', paused: 'Paused' };
const AGENT_PHASE = { idle: 'Waiting for context', evaluating: 'Reading context', drafting: 'Preparing a cue', ready: 'Context updated', error: 'Review unavailable' };

function node(tag, class_name, text) {
  const element = document.createElement(tag);
  if (class_name) element.className = class_name;
  if (text) element.textContent = text;
  return element;
}

function write(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function meter(label) {
  const container = node('div', 'channel-meter');
  const header = node('div', 'channel-meter__head');
  const state = node('span', 'channel-meter__state');
  header.append(node('b', null, label), state);
  const waveform = node('div', 'channel-meter__wave');
  waveform.setAttribute('aria-hidden', 'true');
  const bars = Array.from({ length: BAR_COUNT }, () => node('i'));
  waveform.append(...bars);
  container.append(header, waveform);
  return {
    container,
    update(values, description, active = false) {
      write(state, description);
      container.dataset.active = String(active);
      const samples = values?.slice(-BAR_COUNT) ?? [];
      for (let i = 0; i < BAR_COUNT; i++) {
        const value = samples[i - BAR_COUNT + samples.length] ?? 0;
        const height = Math.min(1, Math.sqrt(Math.max(0, value)) * 1.7);
        bars[i].style.height = 'max(2px, ' + Math.round(height * 100) + '%)';
      }
    },
  };
}

function seatLane(seat) {
  const lane = node('article', 'channel-seat');
  lane.dataset.seat = seat;
  const heading = node('h3', 'channel-seat__title', 'Seat ' + seat);
  const mic = meter('Room input');
  const output = meter('Audio output');
  const audio_title = node('p', 'channel-seat__output');
  const speech = node('ol', 'channel-seat__speech');
  const partial = node('p', 'channel-seat__context');
  const context = node('p', 'channel-seat__context');
  const excerpt = node('p', 'channel-seat__excerpt');
  let last_speech;
  lane.append(heading, mic.container, output.container, audio_title, speech, partial, context, excerpt);
  return {
    lane,
    update(value, local_output, show_room) {
      const playback = local_output ?? value?.output;
      write(heading, 'Seat ' + seat + (value?.name && value.name !== 'Seat ' + seat ? ' · ' + value.name : ''));
      const mic_status = value?.listening ? value.transcription === 'live' ? 'Transcribing'
        : value.transcription === 'unavailable' ? 'Unavailable' : 'Mic listening'
        : value?.online ? 'Mic off' : 'Waiting for seat';
      mic.update(value?.input, value?.source === 'companion' && value.listening ? 'Room mic · ' + mic_status : mic_status, Boolean(value?.listening));
      output.update(playback?.bars, AUDIO_PHASE[playback?.phase] ?? 'Quiet', playback?.phase === 'playing');
      write(audio_title, playback?.title ?? '');
      mic.container.hidden = speech.hidden = partial.hidden = context.hidden = excerpt.hidden = !show_room;
      const recent = value?.recentRuns ?? [];
      const speech_key = JSON.stringify(recent);
      if (speech_key !== last_speech) {
        last_speech = speech_key;
        speech.replaceChildren(...recent.map(run => {
          const item = node('li');
          item.append(node('b', null, run.label), node('span', null, run.text));
          return item;
        }));
      }
      const inputs = value?.context;
      write(partial, value?.partial ? 'Live · ' + value.partial : '');
      const summary = [inputs?.count ? inputs.count + (inputs.count === 1 ? ' line read' : ' lines read') : '', value?.situation]
        .filter(Boolean).join(' · ');
      write(context, summary || 'No context update yet');
      write(excerpt, inputs?.excerpt ? 'Context read · ' + inputs.excerpt : '');
    },
  };
}

export function mountChannelMonitor(host, seatIds) {
  if (!host) return null;
  const heading = node('div', 'channel-monitor__head');
  const title = node('h2', 'channel-monitor__title', 'Live monitor');
  const phase = node('span', 'channel-monitor__phase');
  heading.append(title, phase);
  const agent = node('p', 'channel-monitor__agent');
  const lanes = node('div', 'channel-monitor__lanes');
  const components = seatIds.map(id => [id, seatLane(id)]);
  lanes.append(...components.map(([, item]) => item.lane));
  host.replaceChildren(heading, agent, lanes);
  return {
    update(snapshot, output) {
      const current = snapshot?.agent;
      host.dataset.agent = current?.phase ?? 'idle';
      write(phase, AGENT_PHASE[current?.phase] ?? AGENT_PHASE.idle);
      const description = [current?.summary, current?.preset, current?.mode].filter(Boolean).join(' · ');
      write(agent, description || 'Context agent standing by');
      for (const [seat, component] of components) {
        component.update(snapshot?.seats?.[seat], output?.[seat],
          seatIds.length === 1 || snapshot?.sharedRoom == null || snapshot.sharedRoom === seat);
      }
    },
  };
}
