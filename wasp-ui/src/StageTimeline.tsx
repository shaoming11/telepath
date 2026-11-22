import { useLayoutEffect, useRef, useState } from 'react';
import './StageTimeline.css';

type Entry = { id: string; kind: string; seat?: string; to?: string; text?: string; signal?: string; at: number; playedAt?: number; messageId?: string; draftId?: string; source?: string; sources?: Array<{ name?: string }> };
type Clip = { messageId: string; url: string };
type RoomRun = { text: string; label: string; speaker?: string; seat?: 'A' | 'B' | null };
type RoomTurn = { at: number; text: string; speakers?: RoomRun[] };
type Snapshot = {
  hubId: string; sessionId: string; phase: string; canned?: boolean; canBegin?: boolean;
  coachScenario?: string; startedAt?: number; log: Entry[]; stageAudio?: Clip[];
  seats?: Record<string, { name: string; online: boolean; ready: boolean }>;
  references?: Array<{ name: string }>; research?: { status?: string; retained?: number };
  room?: { listening: boolean; transcription?: string; partial?: string; transcript?: RoomTurn[] };
};
const gestures: Record<string, string> = { R1: 'Single gesture', R2: 'Double gesture', L1: 'Triple gesture', L2: 'Read codebook', LR: 'Ask assistant', OUT: 'Earbud removed', BACK: 'Earbud returned' };
const kinds: Record<string, string> = { message: 'Teammate whisper', pitch_help: 'AI whisper', signal: 'Gesture', back: 'Movement', draft: 'Private draft', confirm: 'Approved', discard: 'Discarded', receipt: 'Acknowledged', announcement: 'Operator cue', answer_evidence: 'Context insight', preset_suggestion: 'Suggested context', preview_playback: 'Preview played' };
const scenarios = [['pitch', 'Pitch Q&A'], ['social', 'Stranger Interview']];
const liveKinds = new Set(['message', 'pitch_help', 'announcement']);
function voiceColor(run: RoomRun) {
  if (run.seat) return run.seat;
  if (!run.speaker) return 'room';
  const index = Array.from(run.speaker).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
  return 'voice-' + index;
}

function RoomTranscript({ turns, seats }: { turns?: RoomTurn[]; seats?: Snapshot['seats'] }) {
  const runs = (turns ?? []).slice(-4).flatMap(turn =>
    (turn.speakers?.length ? turn.speakers : [{ label: 'Room', text: turn.text }])
      .map((run, index) => ({ run, key: turn.at + ':' + index + ':' + run.text }))).slice(-6);
  return (
    <ol className="demo-room-transcript" aria-label="Room transcript" role="log">
      {runs.length ? runs.map(({ run, key }) => (
        <li key={key} data-voice={voiceColor(run)}>
          <strong>{run.seat && seats?.[run.seat]?.name ? seats[run.seat].name : run.label}</strong>
          <span>{run.text}</span>
        </li>
      )) : <li className="demo-room-empty">Speaker turns appear as people talk.</li>}
    </ol>
  );
}
function action(action: string, options = {}) { document.dispatchEvent(new CustomEvent('telepathy:stage-action', { detail: { action, options } })); }
function replaying(active: boolean) { document.dispatchEvent(new CustomEvent('telepathy:stage-replay', { detail: active })); }

export function StageTimeline() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [link, setLink] = useState('connecting');
  const [setup, setSetup] = useState(false);
  const [filter, setFilter] = useState('All');
  const [playing, setPlaying] = useState<string | null>(null);
  const [speaker, setSpeaker] = useState(false);
  const [notice, setNotice] = useState('Mac speakers are off.');
  const [room, setRoom] = useState({ wanted: false, canStart: false, notice: '' });
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const request = useRef<AbortController | null>(null);
  const scope = useRef('');
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const heardOnMac = useRef(new Set<string>());
  const stop = () => {
    request.current?.abort(); request.current = null;
    if (source.current) { source.current.onended = null; source.current.stop(); source.current = null; }
    replaying(false); setPlaying(null);
  };
  useLayoutEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Snapshot>).detail;
      const nextScope = next.hubId + ':' + next.sessionId;
      if (nextScope !== scope.current) {
        stop();
        heardOnMac.current.clear();
        setSpeaker(false);
        follow.current = true;
        setNotice('Mac speakers are off.');
      }
      scope.current = nextScope; setState(next);
    };
    const connection = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      setLink(next);
      if (next !== 'live') { stop(); setSpeaker(false); setNotice('Mac speakers are off.'); }
    };
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

  async function play(clip: Clip, live = false) {
    if (playing === clip.messageId) { stop(); setNotice('Replay stopped.'); return; }
    stop();
    if (state?.room?.listening && !room.wanted) {
      setNotice('Stop the room microphone in the listening tab before replaying.'); return;
    }
    const pending = new AbortController(); request.current = pending;
    const identity = scope.current;
    setPlaying(clip.messageId); setNotice('Loading the whisper…'); replaying(true);
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
      voice.onended = () => { source.current = null; replaying(false); setPlaying(null); setNotice(speaker ? 'Mac speakers on.' : 'Replay finished.'); voice.disconnect(); gain.disconnect(); limiter.disconnect(); };
      voice.start(); setNotice(live ? 'Playing live on this Mac · mic paused' : 'Replaying on this Mac · mic paused');
    } catch {
      if (!pending.signal.aborted) { stop(); setNotice('This clip is unavailable. New whispers will still appear here.'); }
    } finally {
      if (request.current === pending) request.current = null;
    }
  }
  async function toggleSpeaker() {
    if (speaker) { stop(); setSpeaker(false); setNotice('Mac speakers are off.'); return; }
    try {
      const audio = context.current ??= new AudioContext();
      await audio.resume();
      if (audio.state !== 'running') throw new Error('Audio paused');
      heardOnMac.current = new Set(state?.log.flatMap(entry => entry.messageId ? [entry.messageId] : []));
      setSpeaker(true);
      setNotice('Mac speakers on. New cues will play here.');
    } catch { setNotice('Click Mac speakers again to enable audio.'); }
  }
  useLayoutEffect(() => {
    if (!speaker || playing || request.current || link !== 'live' || state?.phase !== 'live' || state.canned) return;
    const clipMap = new Map(state.stageAudio?.map(clip => [clip.messageId, clip]));
    for (const entry of state.log) {
      if (!liveKinds.has(entry.kind) || !entry.messageId || heardOnMac.current.has(entry.messageId)) continue;
      const clip = clipMap.get(entry.messageId);
      if (!clip) continue;
      heardOnMac.current.add(entry.messageId);
      void play(clip, true);
      break;
    }
  }, [state, speaker, playing, link]);
  const events = (state?.log ?? []).filter(entry => kinds[entry.kind]);
  const rows = events.filter(entry => filter === 'All' || (filter === 'AI' ? entry.kind === 'pitch_help' : filter === 'Teammates' ? ['message', 'draft', 'confirm', 'discard', 'receipt'].includes(entry.kind) : ['signal', 'back', 'preview_playback'].includes(entry.kind)));
  const clips = new Map(state?.stageAudio?.map(clip => [clip.messageId, clip]));
  const name = (seat?: string) => seat ? state?.seats?.[seat]?.name || 'Seat ' + seat : 'Telepath';
  const whispers = events.filter(entry => ['message', 'pitch_help'].includes(entry.kind));
  const playedCount = whispers.filter(entry => entry.playedAt != null).length;
  return <div className="demo-stage">
    <header className="demo-nav"><a href="/stage" className="demo-brand">◈ Telepath<span>A private edge.</span></a>
      <div><span className="demo-connection" data-live={link === 'live'}>{link === 'live' ? state?.canned ? 'Scripted demo' : 'Hub connected' : link === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>
        <button className="demo-speaker" aria-pressed={speaker} disabled={link !== 'live'} onClick={() => void toggleSpeaker()}>Mac speakers {speaker ? 'on' : 'off'}</button>
        <button onClick={() => setSetup(value => !value)}>{setup ? 'Back to demo' : 'Setup & controls'} <span aria-hidden="true">↗</span></button></div></header>
    {!setup && <>
      <section className="demo-intro"><h1>{state?.phase === 'reveal' ? 'Session recap' : 'Live signal exchange'}</h1>
        <div className="demo-intro-right"><div className="demo-scenarios" aria-label="Conversation scenario">{scenarios.map(([id, label]) => <button key={id} aria-pressed={state?.coachScenario === id} disabled={link !== 'live' || !!state?.canned || state?.phase === 'reveal'} onClick={() => action('coach_scenario', { scenario: id })}>{label}</button>)}</div></div></section>
      <section className="demo-grid">
        <div className="demo-channel"><header className="demo-channel-head"><h2>Signal timeline</h2><span>{whispers.filter(entry => entry.messageId).length} sent <span aria-hidden="true">/</span> {playedCount} playback started</span></header>
          <div className="demo-filters" aria-label="Filter timeline">{['All', 'Teammates', 'AI', 'Gestures'].map(item => <button key={item} aria-pressed={filter === item} onClick={() => { setFilter(item); follow.current = true; }}>{item}</button>)}<span>{state?.phase === 'live' ? '● LIVE SESSION' : state?.phase === 'reveal' ? 'SESSION RECAP' : 'READY WHEN YOU ARE'}</span></div>
          <ol className="demo-timeline" ref={list} aria-label="Private message timeline" tabIndex={0} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {!rows.length && <li className="demo-empty"><span aria-hidden="true">⌁</span><h3>{filter === 'All' ? 'The conversation comes first.' : 'Nothing here yet.'}</h3><p>{filter === 'All' ? 'Your teammate’s signals and Telepath’s whispers appear here as they happen. Keep talking. We’ll keep the thread.' : 'Matching events will appear as the session unfolds.'}</p><div>Listen <span>→</span> Understand <span>→</span> Whisper</div></li>}
            {rows.map(entry => {
              const clipId = entry.messageId || entry.draftId;
              const clip = clipId && entry.kind !== 'draft' ? clips.get(clipId) : undefined;
              const isWhisper = liveKinds.has(entry.kind) || entry.kind === 'draft';
              const status = entry.kind === 'draft' ? 'Private preview · approval required' : entry.source === 'canned' ? 'Scripted' : entry.playedAt != null ? 'Playback confirmed' : isWhisper ? entry.messageId ? 'Sent · awaiting playback' : 'Text cue · no audio' : kinds[entry.kind];
              return <li key={entry.id} className={'demo-event ' + (isWhisper ? 'demo-whisper' : 'demo-gesture')} data-ai={entry.kind === 'pitch_help'}>
                <span className="demo-avatar" data-seat={entry.seat}>{entry.kind === 'pitch_help' ? '✦' : entry.seat || 'T'}</span>
                <div className="demo-event-content"><div className="demo-event-meta"><strong>{entry.kind === 'pitch_help' ? 'Telepath → ' + name(entry.seat) : entry.to ? name(entry.seat) + ' → ' + name(entry.to) : name(entry.seat)}</strong><span>{kinds[entry.kind]}</span><time>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
                  <p>{entry.kind === 'draft' ? 'Awaiting approval on the sender’s phone.' : entry.text || gestures[entry.signal || ''] || kinds[entry.kind]}</p>
                  {isWhisper && <div className="demo-event-footer"><span>{status}{entry.signal ? ' · ' + (gestures[entry.signal] || entry.signal) : ''}</span>{clip ? <button className="demo-play" disabled={link !== 'live'} aria-label={(playing === clip.messageId ? 'Stop' : 'Replay') + ' whisper: ' + entry.text} onClick={() => void play(clip)}><span aria-hidden="true">{playing === clip.messageId ? '■' : '▶'}</span> {playing === clip.messageId ? 'Playing' : 'Hear it'}</button> : <span>Replay unavailable</span>}</div>}
                </div>
              </li>;
            })}
          </ol><footer className="demo-channel-footer"><span role="status">{notice}</span><button onClick={() => { follow.current = true; list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }}>Latest ↓</button></footer>
        </div>
        <aside className="demo-context"><section><h2>{state?.coachScenario === 'social' ? 'Interviewer' : 'Seats'}</h2><div className="demo-seats">{(state?.coachScenario === 'social' && !state.seats?.B?.online ? ['A'] : ['A', 'B']).map(seat => <div key={seat}><span className="demo-avatar" data-seat={seat}>{seat}</span><div><b>{name(seat)}</b><small>{state?.seats?.[seat]?.ready ? 'Ready' : state?.seats?.[seat]?.online ? 'Connected · setting up' : 'Waiting to join'}</small></div></div>)}</div>
          <button className="demo-primary" disabled={link !== 'live' || (state?.phase !== 'live' && !state?.canBegin) || state?.phase === 'reveal' || !!state?.canned} onClick={() => action(state?.phase === 'live' ? 'reveal' : 'begin')}>{state?.phase === 'live' ? 'End & reveal session' : state?.phase === 'reveal' ? 'Session complete' : 'Begin session'}</button><button className="demo-mic" disabled={!room.wanted && !room.canStart} onClick={() => document.getElementById(room.wanted ? 'room-mic-stop' : 'room-mic-start')?.click()}>{room.wanted ? '● Stop listening' : 'Start listening'}</button><p className="demo-hint">{room.wanted ? playing ? 'Room capture paused for speaker audio.' : 'Listening to the room.' : room.notice || (state?.coachScenario === 'social' ? 'Connect Seat A to begin.' : 'Connect both seats in Setup to begin.')}</p></section>
          <section className="demo-memory"><h3>Room transcript</h3>{state?.coachScenario === 'social'
            ? <p>OpenAI suggests follow-ups from the conversation.</p>
            : <p>{state?.references?.length || 0} uploads <span>·</span> {state?.research?.retained || 0} research notes</p>}
            <RoomTranscript turns={state?.room?.transcript} seats={state?.seats} />
            {state?.room?.partial && <p>Hearing: {state.room.partial}</p>}
            {!state?.room?.partial && !state?.room?.transcript?.length && (
              <p>{state?.room?.transcription === 'live' ? 'Mic connected. Say a test sentence before asking for a cue.'
                : 'Start listening on this Mac before asking for a cue.'}</p>
            )}
          </section>
          <p className="demo-footnote">A whisper in your ear.<br />A little more confidence in the room.</p>
        </aside>
      </section>
    </>}
  </div>;
}
