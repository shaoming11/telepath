import { useLayoutEffect, useState } from 'react';

type PitchState = {
  available: boolean;
  armed: boolean;
  live: boolean;
  connected: boolean;
  roomLive: boolean;
  preparing: boolean;
  cue: { text: string; points: string[] } | null;
};

type PitchPlayback = { id: string; text: string };

const EMPTY_PITCH: PitchState = {
  available: false, armed: false, live: false, connected: false, roomLive: false, preparing: false, cue: null,
};

const normalized = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

export function PhonePitchControls() {
  const [state, setState] = useState(EMPTY_PITCH);
  const [playback, setPlayback] = useState<PitchPlayback>();

  useLayoutEffect(() => {
    const receiveState = (event: Event) => {
      const next = (event as CustomEvent<PitchState>).detail;
      setState(next);
      if (!next.cue) setPlayback(undefined);
    };
    const speechStarted = (event: Event) => setPlayback((event as CustomEvent<PitchPlayback>).detail);

    document.addEventListener('telepathy:pitch-state', receiveState);
    document.addEventListener('telepathy:pitch-speech-start', speechStarted);
    return () => {
      document.removeEventListener('telepathy:pitch-state', receiveState);
      document.removeEventListener('telepathy:pitch-speech-start', speechStarted);
    };
  }, []);

  const started = Boolean(playback && state.cue?.text === playback.text);
  const hint = !state.connected ? 'Waiting for the hub.'
    : !state.live ? 'After Stage begins'
    : !state.armed ? 'Tap to listen'
    : state.roomLive ? 'Listening for questions' : 'Waiting for room mic';
  const points = state.cue?.points.filter(point => normalized(point) !== normalized(state.cue?.text ?? '')) ?? [];
  const status = state.preparing ? 'Preparing cue' : started ? 'Voice started' : '';

  return (
    <div className="pitch-panel" data-pitch-owner="react" hidden={!state.available && !state.cue}>
      <div className="pitch-panel__controls" hidden={!state.available}>
        <button
          className="signal"
          id="question-mode"
          type="button"
          disabled={!state.live || !state.connected}
          aria-pressed={state.armed}
          onClick={() => document.dispatchEvent(new Event('telepathy:toggle-question-mode'))}
        >
          <b>Question Mode</b>
          <span>{hint}</span>
        </button>
        <button className="pitch-panel__request" type="button" aria-label="Get a private cue now"
          disabled={!state.live || !state.connected}
          onClick={() => document.dispatchEvent(new Event('telepathy:request-pitch-cue'))}>
          Cue now
        </button>
      </div>
      {!state.cue && <p className="pitch-panel__status" role="status" hidden={!status}>{status}</p>}
      <section className="pitch-notes" id="live-pitch-notes" aria-labelledby="live-pitch-notes-label"
        hidden={!state.cue} data-playback={started ? 'started' : 'waiting'}>
        <div className="pitch-panel__heading">
          <h3 className="kicker" id="live-pitch-notes-label">Private cue</h3>
          {state.cue && <p className="pitch-panel__status" role="status" hidden={!status}>{status}</p>}
        </div>
        <p id="live-pitch-cue" className="pitch-notes__cue">{state.cue?.text ?? ''}</p>
        <ul id="live-pitch-points" className="pitch-notes__points" hidden={!points.length}>
          {points.map((point, index) => <li key={index}>{point}</li>)}
        </ul>
      </section>
    </div>
  );
}
