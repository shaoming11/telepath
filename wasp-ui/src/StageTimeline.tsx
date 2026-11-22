import { useLayoutEffect, useRef, useState } from 'react';
import './StageTimeline.css';

type Entry = { id: string; kind: string; seat?: string; to?: string; text?: string; signal?: string; at: number; playedAt?: number; messageId?: string; draftId?: string; source?: string; sources?: Array<{ name?: string }> };
type Clip = { messageId: string; url: string };
type Snapshot = {
  hubId: string; sessionId: string; phase: string; canned?: boolean; canBegin?: boolean;
  coachScenario?: string; startedAt?: number; log: Entry[]; stageAudio?: Clip[];
  seats?: Record<string, { name: string; online: boolean; ready: boolean }>;
  references?: Array<{ name: string }>; research?: { status?: string; retained?: number };
  room?: { listening: boolean; transcript?: Array<{ text: string; speaker?: string }> };
};
const gestures: Record<string, string> = { R1: 'Single gesture', R2: 'Double gesture', L1: 'Triple gesture', L2: 'Read codebook', LR: 'Ask assistant', OUT: 'Earbud removed', BACK: 'Earbud returned' };
const kinds: Record<string, string> = { message: 'Teammate whisper', pitch_help: 'AI whisper', signal: 'Gesture', back: 'Movement', draft: 'Private draft', confirm: 'Approved', discard: 'Discarded', receipt: 'Acknowledged', announcement: 'Operator cue', answer_evidence: 'Context insight', preset_suggestion: 'Suggested context', preview_playback: 'Preview played' };
const scenarios = [['pitch', 'Pitches & Q&A'], ['interview', 'Interviews'], ['social', 'Networking & conversation']];
function action(action: string, options = {}) { document.dispatchEvent(new CustomEvent('telepathy:stage-action', { detail: { action, options } })); }
function replaying(active: boolean) { document.dispatchEvent(new CustomEvent('telepathy:stage-replay', { detail: active })); }

export function StageTimeline() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [link, setLink] = useState('connecting');
  const [setup, setSetup] = useState(false);
  const [filter, setFilter] = useState('All');
  const [playing, setPlaying] = useState<string | null>(null);
  const [notice, setNotice] = useState('Replay plays on this Mac only.');
  const [room, setRoom] = useState({ wanted: false, canStart: false, notice: '' });
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const request = useRef<AbortController | null>(null);
  const scope = useRef('');
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const stop = () => {
    request.current?.abort(); request.current = null;
    if (source.current) { source.current.onended = null; source.current.stop(); source.current = null; }
    replaying(false); setPlaying(null);
  };
  useLayoutEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Snapshot>).detail;
      const nextScope = next.hubId + ':' + next.sessionId;
      if (nextScope !== scope.current) { stop(); follow.current = true; setNotice('Replay plays on this Mac only.'); }
      scope.current = nextScope; setState(next);
    };
    const connection = (event: Event) => { const next = (event as CustomEvent<string>).detail; setLink(next); if (next !== 'live') stop(); };
    const mic = (event: Event) => setRoom((event as CustomEvent).detail);
    document.addEventListener('telepathy:stage-state', receive);
    document.addEventListener('telepathy:stage-link', connection);
    document.addEventListener('telepathy:room-state', mic);
    return () => {
      document.removeEventListener('telepathy:stage-state', receive);
      document.removeEventListener('telepathy:stage-link', connection);
      document.removeEventListener('telepathy:room-state', mic);
      stop(); void context.current?.close();
    };
  }, []);
  useLayoutEffect(() => {
    document.body.dataset.demoFocus = setup ? 'off' : 'on';
    return () => { delete document.body.dataset.demoFocus; };
  }, [setup]);
  useLayoutEffect(() => {
    if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [state?.log.length, filter, setup]);

  async function play(clip: Clip) {
    if (playing === clip.messageId) { stop(); setNotice('Replay stopped.'); return; }
    stop();
    if (state?.room?.listening && !room.wanted) {
      setNotice('Stop the room microphone in the listening tab before replaying.'); return;
    }
    const pending = new AbortController(); request.current = pending;
    const identity = scope.current;
    setPlaying(clip.messageId); setNotice('Loading the original whisper…'); replaying(true);
    try {
      const audio = context.current ??= new AudioContext();
      await audio.resume();
      const response = await fetch(clip.url, { signal: pending.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('expired');
      const buffer = await audio.decodeAudioData(await response.arrayBuffer());
      if (pending.signal.aborted || identity !== scope.current) return;
      const voice = audio.createBufferSource(); voice.buffer = buffer;
      const gain = audio.createGain(); gain.gain.value = 1.35;
      const limiter = audio.createDynamicsCompressor();
      limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
      voice.connect(gain).connect(limiter).connect(audio.destination);
      source.current = voice;
      voice.onended = () => { source.current = null; replaying(false); setPlaying(null); setNotice('Replay finished. Room capture is available.'); voice.disconnect(); gain.disconnect(); limiter.disconnect(); };
      voice.start(); setNotice('Playing on this Mac · room capture paused · 1.35× gain');
    } catch {
      if (!pending.signal.aborted) { stop(); setNotice('This clip is unavailable. New whispers will still appear here.'); }
    }
  }
  const events = (state?.log ?? []).filter(entry => kinds[entry.kind]);
  const rows = events.filter(entry => filter === 'All' || (filter === 'AI' ? entry.kind === 'pitch_help' : filter === 'Teammates' ? ['message', 'draft', 'confirm', 'discard', 'receipt'].includes(entry.kind) : ['signal', 'back', 'preview_playback'].includes(entry.kind)));
  const clips = new Map(state?.stageAudio?.map(clip => [clip.messageId, clip]));
  const name = (seat?: string) => seat ? state?.seats?.[seat]?.name || 'Seat ' + seat : 'Telepath';
  const whispers = events.filter(entry => ['message', 'pitch_help'].includes(entry.kind));
  return <div className="demo-stage">
    <header className="demo-nav"><a href="/stage" className="demo-brand">◈ Telepath<span>A private edge.</span></a>
      <div><span className="demo-connection" data-live={link === 'live'}>{link === 'live' ? state?.canned ? 'Scripted demo' : 'Hub connected' : link === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>
        <button onClick={() => setSetup(value => !value)}>{setup ? 'Back to demo' : 'Setup & controls'} <span aria-hidden="true">↗</span></button></div></header>
    {!setup && <>
      <section className="demo-intro"><div><p className="demo-eyebrow">YOUR CONVERSATION. YOUR PRIVATE CHANNEL.</p><h1>Stay in the moment.<br /><span>We’ll whisper the rest.</span></h1></div>
        <div className="demo-intro-right"><p>Context when you need it.<br />A teammate, without saying a word.</p><div className="demo-scenarios" aria-label="Conversation scenario">{scenarios.map(([id, label]) => <button key={id} aria-pressed={state?.coachScenario === id} disabled={link !== 'live' || !!state?.canned} onClick={() => action('coach_scenario', { scenario: id })}>{label}</button>)}</div></div></section>
      <div className="demo-features"><p><b>01 <span>Listen & assist</span></b> Conversation + your context → helpful private cues</p><p><b>02 <span>Think together</span></b> Earbud gesture → approve → teammate hears</p></div>
      <section className="demo-grid">
        <div className="demo-channel"><header className="demo-channel-head"><div><p className="demo-eyebrow">THE PRIVATE CHANNEL</p><h2>What we hear.</h2></div><span>{whispers.length} whispers <span aria-hidden="true">/</span> {events.filter(entry => entry.kind === 'signal').length} gestures</span></header>
          <div className="demo-filters" aria-label="Filter timeline">{['All', 'Teammates', 'AI', 'Gestures'].map(item => <button key={item} aria-pressed={filter === item} onClick={() => { setFilter(item); follow.current = true; }}>{item}</button>)}<span>{state?.phase === 'live' ? '● LIVE SESSION' : state?.phase === 'reveal' ? 'SESSION RECAP' : 'READY WHEN YOU ARE'}</span></div>
          <ol className="demo-timeline" ref={list} aria-label="Private message timeline" tabIndex={0} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {!rows.length && <li className="demo-empty"><span aria-hidden="true">⌁</span><h3>{filter === 'All' ? 'The conversation comes first.' : 'Nothing here yet.'}</h3><p>{filter === 'All' ? 'Your teammate’s signals and Telepath’s whispers appear here as they happen. Keep talking. We’ll keep the thread.' : 'Matching events will appear as the session unfolds.'}</p><div>Listen <span>→</span> Understand <span>→</span> Whisper</div></li>}
            {rows.map(entry => {
              const clipId = entry.messageId || entry.draftId;
              const clip = clipId ? clips.get(clipId) : undefined;
              const isWhisper = ['message', 'pitch_help', 'draft'].includes(entry.kind);
              const status = entry.kind === 'draft' ? 'Private preview · approval required' : entry.source === 'canned' ? 'Scripted' : entry.playedAt != null ? 'Playback confirmed' : isWhisper ? entry.messageId ? 'Sent · awaiting playback' : 'Text cue · no audio' : kinds[entry.kind];
              return <li key={entry.id} className={'demo-event ' + (isWhisper ? 'demo-whisper' : 'demo-gesture')} data-ai={entry.kind === 'pitch_help'}>
                <span className="demo-avatar" data-seat={entry.seat}>{entry.kind === 'pitch_help' ? '✦' : entry.seat || 'T'}</span>
                <div className="demo-event-content"><div className="demo-event-meta"><strong>{entry.kind === 'pitch_help' ? 'Telepath → ' + name(entry.seat) : entry.to ? name(entry.seat) + ' → ' + name(entry.to) : name(entry.seat)}</strong><span>{kinds[entry.kind]}</span><time>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
                  <p>{entry.text || gestures[entry.signal || ''] || kinds[entry.kind]}</p>
                  {isWhisper && <div className="demo-event-footer"><span>{status}{entry.signal ? ' · ' + (gestures[entry.signal] || entry.signal) : ''}</span>{clip ? <button className="demo-play" disabled={link !== 'live'} aria-label={(playing === clip.messageId ? 'Stop' : 'Replay') + ' whisper: ' + entry.text} onClick={() => void play(clip)}><span aria-hidden="true">{playing === clip.messageId ? '■' : '▶'}</span> {playing === clip.messageId ? 'Playing' : 'Hear it'}</button> : <span>Replay unavailable</span>}</div>}
                </div>
              </li>;
            })}
          </ol><footer className="demo-channel-footer"><span role="status">{notice}</span><button onClick={() => { follow.current = true; list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }}>Latest ↓</button></footer>
        </div>
        <aside className="demo-context"><section><p className="demo-eyebrow">IN THE ROOM</p><h2>Two people.<br />One silent channel.</h2><div className="demo-seats">{['A', 'B'].map(seat => <div key={seat}><span className="demo-avatar" data-seat={seat}>{seat}</span><div><b>{name(seat)}</b><small>{state?.seats?.[seat]?.ready ? 'Ready' : state?.seats?.[seat]?.online ? 'Connected · setting up' : 'Waiting to join'}</small></div></div>)}</div>
          <button className="demo-primary" disabled={link !== 'live' || (state?.phase !== 'live' && !state?.canBegin) || state?.phase === 'reveal' || !!state?.canned} onClick={() => action(state?.phase === 'live' ? 'reveal' : 'begin')}>{state?.phase === 'live' ? 'End & reveal session' : state?.phase === 'reveal' ? 'Session complete' : 'Begin session'}</button><button className="demo-mic" disabled={!room.wanted && !room.canStart} onClick={() => document.getElementById(room.wanted ? 'room-mic-stop' : 'room-mic-start')?.click()}>{room.wanted ? '● Stop listening' : 'Start listening'}</button><p className="demo-hint">{room.wanted ? playing ? 'Room capture paused for replay.' : 'Listening to the room.' : room.notice || 'Connect both seats in Setup to begin.'}</p></section>
          <section className="demo-memory"><p className="demo-eyebrow">CONTEXT THAT STAYS WITH YOU</p><h3>Listening. Connecting the dots.</h3><p>{state?.references?.length || 0} reference documents <span>·</span> {state?.research?.retained || 0} research notes</p><p>People, companies, and relevant topics add context for useful cues.</p>{state?.room?.transcript?.slice(-2).map((turn, i) => <blockquote key={i}>{turn.text}</blockquote>)}<small>Research: {state?.research?.status || 'idle'}</small></section>
          <p className="demo-footnote">A whisper in your ear.<br />A little more confidence in the room.</p>
        </aside>
      </section>
    </>}
  </div>;
}
