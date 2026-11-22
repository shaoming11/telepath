import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import './StagePair.css';

type Cue = {
  id: string;
  text: string;
  direction: 'In' | 'Out';
  signal: string;
  tone: 'waiting' | 'sent' | 'started' | 'acknowledged' | 'recorded';
  label: string;
  detail: string;
};

type SeatCard = {
  seat: 'A' | 'B';
  name: string;
  status: string;
  current: Cue | null;
  previous: Cue | null;
  animate: boolean;
};

type Pair = { cards: SeatCard[]; announcement: string; entrance: boolean };

const INITIAL: Pair = {
  cards: (['A', 'B'] as const).map(seat => ({
    seat, name: 'Seat ' + seat, status: 'Offline', current: null, previous: null, animate: false,
  })),
  announcement: '',
  entrance: false,
};

function CuePlate({ card }: { card: SeatCard }) {
  const { seat, name, status, current, previous, animate } = card;
  const length = current?.text.length ?? 0;
  const tier = length <= 18 ? 'short' : length <= 40 ? 'medium' : length <= 100 ? 'long' : 'extended';
  return (
    <article className="stage-pair__plate" data-seat={seat} aria-labelledby={'pair-seat-' + seat}>
      <header className="stage-pair__head">
        <div>
          <h2 id={'pair-seat-' + seat}>Seat {seat}</h2>
          {name !== 'Seat ' + seat && <p>{name}</p>}
        </div>
        <span className="stage-pair__seat-state">{status}</span>
      </header>
      {current ? (
        <div className="stage-pair__cue" key={current.id} data-cue-id={current.id} data-motion={animate} data-size={tier}>
          <p className="stage-pair__route">{current.direction}{current.signal && <span>{current.signal}</span>}</p>
          <p className="stage-pair__text">{current.text}</p>
          <strong className="stage-pair__status" data-evidence={current.tone} key={current.tone}>{current.label}</strong>
          {current.detail && <p className="stage-pair__detail">{current.detail}</p>}
        </div>
      ) : (
        <p className="stage-pair__empty">No cue yet</p>
      )}
      {previous && <p className="stage-pair__previous">{previous.direction} · {previous.detail || previous.label} · {previous.text}</p>}
    </article>
  );
}

export function StagePair() {
  const root = useRef<HTMLElement>(null);
  const [view, set_view] = useState(INITIAL);
  useLayoutEffect(() => {
    const node = root.current;
    const update = (event: Event) => flushSync(() => set_view((event as CustomEvent<Pair>).detail));
    node?.addEventListener('telepathy:pair', update);
    return () => node?.removeEventListener('telepathy:pair', update);
  }, []);
  return (
    <section className="stage-pair" id="stage-pair" ref={root} tabIndex={-1} aria-label="Two-seat cue activity" data-enter={view.entrance}>
      <p className="sr-only" role="status" aria-atomic="true">{view.announcement}</p>
      {view.cards.map(card => <CuePlate key={card.seat} card={card} />)}
    </section>
  );
}
