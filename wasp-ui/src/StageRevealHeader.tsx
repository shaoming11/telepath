import { useLayoutEffect, useRef, useState } from 'react';

type Reveal = { bits: string; words: number | string; wordLabel: string; count: string; kicker: string };

const INITIAL: Reveal = { bits: '—', words: '—', wordLabel: 'words in confirmed cues', count: '', kicker: 'Reveal' };

export function StageRevealHeader() {
  const element = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState(INITIAL);
  useLayoutEffect(() => {
    const head = element.current;
    const update = (event: Event) => setReveal((event as CustomEvent<Reveal>).detail);
    head?.addEventListener('telepathy:reveal', update);
    return () => head?.removeEventListener('telepathy:reveal', update);
  }, []);

  return (
    <div className="reveal__head" id="reveal-head" data-reveal-owner="react" ref={element}>
      <div className="reveal__headline">
        <p className="kicker" id="reveal-kicker">{reveal.kicker}</p>
        <h1 className="display display--reveal" id="reveal-title" tabIndex={-1}><span className="display__dim">Everything that</span> went across.</h1>
      </div>
      <div className="score">
        <div className="score__num"><span id="reveal-bits">{reveal.bits}</span><small>bits tapped</small></div>
        <svg className="score__arrow" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true"><path d="M0 7h31M26 2l5 5-5 5" pathLength="1" /></svg>
        <div className="score__num"><span id="reveal-words">{reveal.words}</span><small id="reveal-word-label">{reveal.wordLabel}</small></div>
        <p className="score__count" id="reveal-count" aria-live="polite">{reveal.count}</p>
      </div>
    </div>
  );
}
