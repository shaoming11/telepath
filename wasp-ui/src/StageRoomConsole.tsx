import { useLayoutEffect, useRef, useState } from 'react';

type MicDevice = { id: string; label: string };
type RoomTurn = { label: string; text: string; seat?: string };
type Speaker = { id: string; label: string; seat: string };

type RoomView = {
  wanted: boolean;
  canStart: boolean;
  devices: MicDevice[];
  tone: string;
  label: string;
  notice: string;
  waiting: boolean;
  turns: RoomTurn[];
  speakers: Speaker[];
  speakersDisabled: boolean;
  canClear: boolean;
};

const OFF: RoomView = {
  wanted: false, canStart: false, devices: [], tone: 'off', label: 'Off',
  notice: 'Start listening and allow microphone access.', waiting: false,
  turns: [], speakers: [], speakersDisabled: true, canClear: false,
};

const BAR_COUNT = 24;

function roomAction(action: string, details: Record<string, string> = {}) {
  document.dispatchEvent(new CustomEvent('telepathy:room-action', { detail: { action, ...details } }));
}

function RoomInputMeter({ wanted }: { wanted: boolean }) {
  const [level, setLevel] = useState(0);
  useLayoutEffect(() => {
    const update = (event: Event) => setLevel((event as CustomEvent<number>).detail);
    document.addEventListener('telepathy:room-level', update);
    return () => document.removeEventListener('telepathy:room-level', update);
  }, []);
  const bars = Math.round(level * BAR_COUNT);
  return (
    <div className="room-console__signal">
      <div className="room-console__meter-head">
        <label className="kicker" htmlFor="room-mic-level">Input level</label>
        <span className="mono" id="room-mic-readout" aria-hidden="true">{wanted ? Math.round(level * 100) + '%' : '—'}</span>
      </div>
      <meter className="sr-only" id="room-mic-level" min="0" max="1" value={level}>{level}</meter>
      <div className="room-console__meter" id="room-mic-bars" aria-hidden="true">
        {Array.from({ length: BAR_COUNT }, (_, index) => <span key={index} data-active={index < bars ? '' : undefined} />)}
      </div>
    </div>
  );
}

export function StageRoomConsole() {
  const [state, setState] = useState(OFF);
  const [device, setDevice] = useState('');
  const start = useRef<HTMLButtonElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  const focusAction = useRef<'start' | 'stop' | null>(null);
  const transcript = useRef<HTMLUListElement>(null);
  const stickToBottom = useRef(true);
  const turnKey = JSON.stringify(state.turns);

  useLayoutEffect(() => {
    const receive = (event: Event) => setState((event as CustomEvent<RoomView>).detail);
    document.addEventListener('telepathy:room-state', receive);
    return () => document.removeEventListener('telepathy:room-state', receive);
  }, []);

  useLayoutEffect(() => {
    if (state.wanted && focusAction.current === 'stop') {
      focusAction.current = null;
      stop.current?.focus({ preventScroll: true });
    } else if (!state.wanted && state.canStart && focusAction.current === 'start') {
      focusAction.current = null;
      start.current?.focus({ preventScroll: true });
    }
  }, [state.wanted, state.canStart]);

  useLayoutEffect(() => {
    if (stickToBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [turnKey]);

  return (
    <section className="room-console" id="room-microphone-panel" aria-labelledby="room-mic-title" data-state={state.tone} data-room-owner="react">
      <header className="room-console__head">
        <div>
          <h2 id="room-mic-title">Room microphone</h2>
          <p>One Mac input for both seats. Phones handle whispers and taps.</p>
        </div>
        <div className="room-console__actions">
          <span className="room-console__state" id="room-mic-state" aria-hidden="true">{state.label}</span>
          <button className="room-console__start" id="room-mic-start" type="button" ref={start}
            disabled={!state.canStart} hidden={state.wanted} onClick={() => {
              if (document.activeElement === start.current) focusAction.current = 'stop';
              roomAction('start');
            }}>Start listening</button>
          <button id="room-mic-stop" type="button" ref={stop} hidden={!state.wanted} onClick={() => {
            if (document.activeElement === stop.current) focusAction.current = 'start';
            roomAction('stop');
          }}>Stop listening</button>
        </div>
      </header>
      <div className="room-console__input">
        <div className="room-console__device">
          <label className="kicker" htmlFor="room-mic-device">Input device</label>
          <select id="room-mic-device" disabled={state.wanted}
            value={state.devices.some(item => item.id === device) ? device : ''} onChange={event => setDevice(event.currentTarget.value)}>
            <option value="">System default</option>
            {state.devices.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
        </div>
        <RoomInputMeter wanted={state.wanted} />
      </div>
      <p className="room-console__notice" id="room-mic-status" role="status">{state.notice}</p>
      <div className="room-console__transcript" aria-labelledby="room-transcript-title">
        <div className="room-console__transcript-head">
          <h3 className="kicker" id="room-transcript-title">Room transcript</h3>
          <button id="room-transcript-clear" className="room-console__clear" type="button" hidden={!state.canClear}
            onClick={() => roomAction('clear')}>Clear transcript</button>
        </div>
        <p className="room-console__empty" id="room-transcript-empty" hidden={Boolean(state.turns.length)}>
          {state.waiting ? 'Waiting for the first words…' : 'Speech will appear here as it’s transcribed.'}
        </p>
        <ul className="room-console__turns" ref={transcript} id="room-transcript" aria-labelledby="room-transcript-title" tabIndex={0}
          hidden={!state.turns.length} onScroll={event => {
            const list = event.currentTarget;
            stickToBottom.current = list.scrollHeight - list.clientHeight - list.scrollTop < 24;
          }}>
          {state.turns.map((run, index) => (
            <li key={index} className="room-console__turn" data-seat={run.seat}>
              <span className="room-console__speaker">{run.label}</span><span>{run.text}</span>
            </li>
          ))}
        </ul>
        <details className="room-console__speakers" id="room-speaker-controls" hidden={!state.speakers.length}>
          <summary>Assign speakers</summary>
          <div id="room-speakers">
            {state.speakers.map(speaker => (
              <label key={speaker.id}>{speaker.label}
                <select value={speaker.seat} disabled={state.speakersDisabled}
                  onChange={event => roomAction('assign', { speaker: speaker.id, seat: event.currentTarget.value })}>
                  <option value="">Unassigned</option><option value="A">Seat A</option><option value="B">Seat B</option>
                </select>
              </label>
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}
