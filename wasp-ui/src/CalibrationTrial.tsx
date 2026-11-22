import { useLayoutEffect, useRef, useState } from 'react';

type Trial = {
  count: string;
  tone: 'ready' | 'now' | 'hit' | 'miss';
  phase: string;
  pattern: string;
  repetition: string;
  detail: string;
  expected: number;
  observed: number;
  progress: number;
};

export function CalibrationTrial() {
  const element = useRef<HTMLDivElement>(null);
  const [trial, setTrial] = useState<Trial>();
  useLayoutEffect(() => {
    const panel = element.current;
    const renderTrial = (event: Event) => setTrial((event as CustomEvent<Trial>).detail);
    panel?.addEventListener('telepathy:calibration-trial', renderTrial);
    return () => panel?.removeEventListener('telepathy:calibration-trial', renderTrial);
  }, []);

  const expected = trial?.expected ?? 0;
  const observed = trial?.observed ?? 0;
  const title = expected ? (expected === 2 ? 'Double-tap twice' : 'Double-tap three times') : trial?.pattern;
  const checking = trial?.tone === 'now' && observed >= expected && expected > 0;
  const phase = trial?.tone === 'hit' ? 'Accepted' : checking ? 'Checking' : trial?.tone === 'miss' && expected ? 'Retry' : trial?.phase;
  return (
    <div className="cal-trial wasp-trial" id="cal-trial" ref={element} data-calibration-owner="react" data-phase={trial?.tone}>
      <div className="cal-top">
        <span id="cal-count">{trial?.count}</span>
        <span className="cal-phase" id="cal-phase" role="status" aria-live="assertive" data-phase={checking ? 'checking' : trial?.tone}>{phase}</span>
      </div>
      <div className="cal-trial__prompt">
        <h3 className="cal-pattern" id="cal-pattern">{title}</h3>
        {expected > 0 && <p className="wasp-trial__instruction">One double-tap sends one Next Track event.</p>}
        <p id="cal-repetition">{trial?.repetition}</p>
        <div className="cal-trial__beats" id="cal-beats" aria-hidden="true" hidden={!expected}>
          {Array.from({ length: expected }, (_, index) => <i key={index} data-filled={index < observed} />)}
        </div>
      </div>
      <div className="wasp-trial__feedback">
        {expected > 0 && (
          <span className="wasp-trial__receipt">
            {observed} of {expected} events received{checking && ' · Checking timing…'}
          </span>
        )}
        <p className="cal-trial__feedback" id="cal-detail">{checking ? 'Wait for the result.' : trial?.detail}</p>
      </div>
      <div className="progress" aria-hidden="true">
        <i id="cal-bar" style={{ transform: `scaleX(${trial?.progress ?? 0})` }} />
      </div>
    </div>
  );
}
