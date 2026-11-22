import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

type Reveal = { bits: string; words: number | string; wordLabel: string; count: string; kicker: string };

export function StageRevealHeader() {
  const element = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  useLayoutEffect(() => {
    const head = element.current;
    const update = (event: Event) => flushSync(() => setReveal((event as CustomEvent<Reveal>).detail));
    head?.addEventListener('telepathy:reveal', update);
    return () => head?.removeEventListener('telepathy:reveal', update);
  }, []);
  const long = Boolean(reveal && reveal.bits.length + String(reveal.words).length >= 6);

  return (
    <div className="reveal__head" id="reveal-head" data-reveal-owner="react" ref={element}>
      <p className="kicker" id="reveal-kicker">{reveal?.kicker ?? 'Reveal'}</p>
      <h1 id="reveal-title" className="score" tabIndex={-1} data-long={long} data-ready={Boolean(reveal)}>
        <span className="sr-only">Session results. </span>
        <span className="score__num"><span id="reveal-bits">{reveal?.bits}</span>{' '}<small>bits tapped</small></span>
        <span className="sr-only"> to </span>
        <svg className="score__arrow" width="80" height="33" viewBox="0 0 34 14" aria-hidden="true">
          <path d="M0 7h31M26 2l5 5-5 5" />
          <path className="score__arrow-trace" d="M0 7h31M26 2l5 5-5 5" pathLength="1" />
        </svg>
        <span className="score__num"><span id="reveal-words">{reveal?.words}</span>{' '}<small id="reveal-word-label">{reveal?.wordLabel}</small></span>
      </h1>
      <p className="score__count" id="reveal-count" aria-live="polite">{reveal?.count}</p>
    </div>
  );
}
