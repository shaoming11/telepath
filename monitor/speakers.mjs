const SPEAKER_ID = /^speaker_\d+$/;

function validSpeaker(value) {
  return typeof value === 'string' && SPEAKER_ID.test(value) ? value : null;
}

export function splitDiarizedSegment(message) {
  if (!Number.isInteger(message?.segment_index) || message.segment_index < 0 || !Array.isArray(message.words)) return null;
  const runs = [];
  for (const word of message.words) {
    if (typeof word?.text !== 'string' || word.type === 'audio_event') continue;
    const prior = runs.at(-1);
    if ((word.type === 'spacing' || /^\s+$/.test(word.text)) && prior) {
      prior.text += word.text;
      continue;
    }
    const speaker = validSpeaker(word.speaker_id);
    if (prior?.speaker === speaker) prior.text += word.text;
    else runs.push({ speaker, text: word.text });
  }
  return {
    index: message.segment_index,
    runs: runs.map(run => ({ ...run, text: run.text.trim() })).filter(run => run.text),
  };
}

// Speaker IDs and names belong to one transcription stream. A reconnect starts fresh.
export function createSpeakerBindings() {
  const aliases = new Map();
  const numbers = new Map();
  const seats = new Map();

  function canonical(speaker) {
    let id = validSpeaker(speaker);
    while (aliases.has(id)) id = aliases.get(id);
    return id;
  }

  function merge(from, to) {
    const source = canonical(from);
    const target = canonical(to);
    if (!source || !target || source === target) return false;
    if (!numbers.has(target) && numbers.has(source)) numbers.set(target, numbers.get(source));
    const seat = seats.get(target) ?? seats.get(source);
    if (seat) seats.set(target, seat);
    seats.delete(source);
    aliases.set(source, target);
    return true;
  }

  function describe(speaker) {
    const id = canonical(speaker);
    if (!id) return { speaker: null, label: 'Unassigned speaker' };
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    const seat = seats.get(id) ?? null;
    return { speaker: id, seat, label: seat ? 'Seat ' + seat : 'Speaker ' + numbers.get(id) };
  }

  function assign(speaker, seat) {
    const id = canonical(speaker);
    if (!numbers.has(id) || ![null, 'A', 'B'].includes(seat)) return false;
    const previous = seats.get(id);
    for (const [other, assigned] of seats) {
      if (other === id || assigned !== seat) continue;
      seats.delete(other);
      if (previous) seats.set(other, previous);
      break;
    }
    seats.delete(id);
    if (seat) seats.set(id, seat);
    return true;
  }

  return { assign, describe, merge };
}
