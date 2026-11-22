import { useLayoutEffect, useRef, useState } from 'react';

type Meter = { label: string; status: string; active: boolean; bars: number[] };
type Seat = {
  seat: string;
  title: string;
  mic: Meter | null;
  output: Meter;
  audioTitle: string;
  recent: { label: string; text: string }[];
  partial: string;
  summary: string;
  excerpt: string;
};
type View = { mode: string; phase: string; description: string; sharedRoom: string | null; seats: Seat[] };

const INITIAL: View = { mode: 'idle', phase: 'Waiting for context', description: 'Context agent standing by', sharedRoom: null, seats: [] };

function ChannelMeter({ meter }: { meter: Meter }) {
  return (
    <div className="channel-meter" data-active={meter.active}>
      <div className="channel-meter__head">
        <b>{meter.label}</b><span className="channel-meter__state">{meter.status}</span>
      </div>
      <div className="channel-meter__wave" aria-hidden="true">
        {meter.bars.map((height, index) => <i key={index} style={{ height: `max(2px, ${height}%)` }} />)}
      </div>
    </div>
  );
}

function RoomContext({ lane }: { lane: Seat }) {
  const excerpt = lane.recent.some(run => lane.excerpt === 'Context read · ' + run.text) ? '' : lane.excerpt;
  return (
    <>
      <ol className="channel-seat__speech">
        {lane.recent.map((run, index) => (
          <li key={index}><b>{run.label}</b> <span>{run.text}</span></li>
        ))}
      </ol>
      <p className="channel-seat__context">{lane.partial}</p>
      <p className="channel-seat__context">{lane.summary === 'No context update yet' ? '' : lane.summary}</p>
      <p className="channel-seat__excerpt">{excerpt}</p>
    </>
  );
}

function ChannelSeat({ lane, separateRoom }: { lane: Seat; separateRoom: boolean }) {
  const room = !separateRoom && lane.mic;
  return (
    <article className="channel-seat" data-seat={lane.seat}>
      <h3 className="channel-seat__title">{lane.title}</h3>
      <div className="channel-seat__meters" data-room={Boolean(room)}>
        {room && <ChannelMeter meter={room} />}
        <ChannelMeter meter={lane.output} />
      </div>
      <p className="channel-seat__output">{lane.audioTitle}</p>
      {room && <RoomContext lane={lane} />}
    </article>
  );
}

export function ChannelMonitor({ id, className }: { id: string; className: string }) {
  const panel = useRef<HTMLElement>(null);
  const [view, setView] = useState(INITIAL);
  useLayoutEffect(() => {
    const host = panel.current;
    const update = (event: Event) => setView((event as CustomEvent<View>).detail);
    host?.addEventListener('telepathy:channel-monitor', update);
    return () => host?.removeEventListener('telepathy:channel-monitor', update);
  }, []);
  const shared = id === 'phone-monitor' ? undefined : view.seats.find(lane => lane.seat === view.sharedRoom);
  return (
    <section id={id} ref={panel} className={className} aria-label="Live audio and context" data-channel-owner="react" data-agent={view.mode}>
      <div className="channel-monitor__head">
        <h2 className="channel-monitor__title">Live monitor</h2>
        <span className="channel-monitor__phase" role="status">{view.phase}</span>
      </div>
      <p className="channel-monitor__agent" hidden={view.mode === 'idle'}>{view.description}</p>
      {shared?.mic && (
        <div className="channel-monitor__shared-room">
          <ChannelMeter meter={shared.mic} />
          <RoomContext lane={shared} />
        </div>
      )}
      <div className="channel-monitor__lanes">
        {view.seats.map(lane => <ChannelSeat key={lane.seat} lane={lane} separateRoom={Boolean(shared)} />)}
      </div>
    </section>
  );
}
