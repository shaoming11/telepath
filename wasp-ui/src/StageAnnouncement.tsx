import { useLayoutEffect, useRef, useState } from 'react';

type Announcement = {
  canSend: boolean;
  rehearsal: boolean;
  busy: boolean;
  note: string;
  action: string;
  receipt: {
    id: string;
    text: string;
    summary: string;
    showSummary: boolean;
    seats: { seat: string; tone: string; outcome?: string; label: string }[];
  } | null;
};

const INITIAL: Announcement = {
  canSend: false, rehearsal: false, busy: false, note: 'Waiting for the hub.',
  action: 'Send announcement', receipt: null,
};

export function StageAnnouncement() {
  const form = useRef<HTMLFormElement>(null);
  const [view, setView] = useState(INITIAL);
  useLayoutEffect(() => {
    const node = form.current;
    const update = (event: Event) => setView((event as CustomEvent<Announcement>).detail);
    node?.addEventListener('telepathy:announcement', update);
    return () => node?.removeEventListener('telepathy:announcement', update);
  }, []);
  const receipt = view.receipt;

  return (
    <form className="operator__group announcement" id="op-announce" ref={form} data-announce-owner="react">
      <h3 className="operator__label">Announce to seats</h3>
      <label className="field-label" htmlFor="op-announce-preset">Preset line</label>
      <select id="op-announce-preset" className="control">
        <option value="">Choose a preset line</option>
      </select>
      <label className="field-label" htmlFor="op-announce-text">Message</label>
      <textarea id="op-announce-text" className="control control--text" rows={2} maxLength={140} readOnly={view.rehearsal} />
      <button id="op-announce-send" className="op-action op-action--solid" type="submit"
        disabled={!view.canSend && !view.busy} aria-disabled={!view.canSend}>{view.action}</button>
      <p className="operator__note" id="op-announce-status" role="status">{view.note}</p>
      <p className="sr-only" role="status" aria-atomic="true">{receipt?.summary}</p>
      {receipt && (
        <section className="announcement-receipt" aria-label="Last announcement" id="op-announce-receipt">
          <h4>Last announcement</h4>
          <p className="announcement-receipt__message">{receipt.text}</p>
          <dl className="announcement-receipt__seats">
            {receipt.seats.map(row => (
              <div key={row.seat}>
                <dt>Seat {row.seat}</dt>
                <dd><span key={receipt.id + ':' + row.label} data-tone={row.tone} data-outcome={row.outcome}>{row.label}</span></dd>
              </div>
            ))}
          </dl>
          {receipt.showSummary && <p className="operator__note announcement-receipt__summary">{receipt.summary}</p>}
        </section>
      )}
    </form>
  );
}
