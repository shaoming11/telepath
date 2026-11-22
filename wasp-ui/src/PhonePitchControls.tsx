import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type PitchState = {
  available: boolean;
  armed: boolean;
  live: boolean;
  connected: boolean;
  cue: { text: string; points: string[] } | null;
};

type PitchPlayback = { id: string; text: string };

const EMPTY_PITCH: PitchState = { available: false, armed: false, live: false, connected: false, cue: null };

export function PhonePitchControls() {
  const [state, setState] = useState(EMPTY_PITCH);
  const [playback, setPlayback] = useState<PitchPlayback>();
  const notes = useRef<HTMLElement>(null);

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
  useEffect(() => {
    if (!started || !notes.current?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const color = getComputedStyle(notes.current).getPropertyValue('--seat-rgb').trim();
    if (!color) return;
    const motion = notes.current.animate([
      { boxShadow: `inset 0 0 0 1px rgba(${color}, 0.6), 0 0 22px rgba(${color}, 0.18)` },
      { boxShadow: 'inset 0 0 0 1px transparent, 0 0 22px transparent' },
    ], { duration: 460, easing: 'cubic-bezier(.22,.68,.24,1)' });
    return () => motion.cancel();
  }, [started, playback]);

  const hint = !state.connected ? 'Waiting for the hub.'
    : !state.live ? 'Available when the Stage begins.'
    : state.armed ? 'Listening for questions. Tap to stop.' : 'Prepare while the judge speaks';

  return (
    <div data-pitch-owner="react" style={{ display: 'contents' }}>
      <button
        className="signal"
        id="question-mode"
        type="button"
        hidden={!state.available}
        disabled={!state.live || !state.connected}
        aria-pressed={state.armed}
        onClick={() => document.dispatchEvent(new Event('telepathy:toggle-question-mode'))}
      >
        <b>{state.armed ? 'Question mode on' : 'Question mode'}</b>
        <span>{hint}</span>
      </button>
      <section className="pitch-notes" ref={notes} id="live-pitch-notes" aria-labelledby="live-pitch-notes-label"
        hidden={!state.cue} data-playback={started ? 'started' : 'waiting'}>
        <h3 className="kicker" id="live-pitch-notes-label">Private cue</h3>
        <p id="live-pitch-cue" className="pitch-notes__cue">{state.cue?.text ?? ''}</p>
        <ul id="live-pitch-points" className="pitch-notes__points">
          {state.cue?.points.map((point, index) => <li key={index}>{point}</li>)}
        </ul>
      </section>
    </div>
  );
}
