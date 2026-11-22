import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodec } from '../hub/codec.mjs';
import { validateAnswer } from '../hub/questions.mjs';

test('quote validation accepts omitted document emphasis and rejects altered words and code', () => {
  const result = { status: 'answer', question: 'When can I resume?', answer: 'Wait for Live and Cached.',
    sources: [{ id: 'p', quote: 'wait for Live and Cached before resuming' }] };
  const passage = { id: 'p', name: 'Guide', text: 'You can wait for **Live** and **Cached** before resuming cues.' };
  assert.equal(validateAnswer(result, [passage]).answer, result.answer);
  assert.throws(() => validateAnswer(result, [{ ...passage, kind: 'code' }]), /source does not match/);
  assert.throws(() => validateAnswer(result, [{ ...passage, text: passage.text.replace('before', 'after') }]), /source does not match/);
});

test('room cue evidence numbers resolve to an exact excerpt provided by the hub', async () => {
  const question = 'What happens if the phone disconnects?';
  const answer = 'Explain that the phone rejoins the current take.';
  const passages = [{ id: 'reconnect', name: 'Guide', text: 'If a phone disconnects, it rejoins the current take.' }];
  const codec = createCodec({ env: { OPENAI_API_KEY: 'test-only' }, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.text.format.name, 'telepath_cue');
    const { passages: excerpts } = JSON.parse(body.input);
    assert.equal(excerpts[0].evidence, 1);
    return Response.json({ status: 'completed', output: [{ content: [{
      type: 'output_text', text: JSON.stringify({ question, answer, evidence: 1 }),
    }] }] });
  } });
  const draft = await codec.pitchHelp({ passages, roomTranscript: [{ text: question }], questionHint: question });
  assert.equal(validateAnswer(draft, passages).answer, answer);
});

test('the pitch text fallback keeps a complete short lead from an overlong draft', async () => {
  const lead = 'Leave Safari open and wait for Live and Cached before sending more cues.';
  const codec = createCodec({ env: { OPENAI_API_KEY: 'test-only' }, fetchImpl: async () => Response.json({
    status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      status: 'answer', question: 'What if the phone disconnects?', answer: lead + ' The phone automatically rejoins the current take and clears any outdated messages that are no longer valid.',
      sources: [{ id: 'p', quote: lead }],
    }) }] }],
  }) });
  const cue = await codec.pitchHelp({ passages: [{ id: 'p', name: 'Guide', text: lead }] });
  assert.equal(cue.answer, lead);
});

function evaluate({ a, b, reply, requestedSeat, preset = 'Pitch' }) {
  const payload = {
    situationA: 'Presenting', situationB: 'Coaching', suggestedPreset: '',
    draftA: '', confidenceA: 0, draftB: '', confidenceB: 0, ...reply,
  };
  const fetchImpl = async () => new Response(JSON.stringify({
    status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
  }), { headers: { 'content-type': 'application/json' } });
  const codec = createCodec({ env: { OPENAI_API_KEY: 'test-only' }, fetchImpl });
  return codec.evaluate({ preset, seats: { A: { transcript: [{text:a}] }, B: { transcript: [{text:b}] } }, requestedSeat });
}

test('an automatic Pitch draft must not repeat narration or send from the presenter', async () => {
  const result = await evaluate({
    a:'That is why we send audio instead of text.',
    b:'They said they understand. Everything is on schedule.',
    reply:{draftA:'Watch the clock.',confidenceA:.95,draftB:'They said they understand. Everything is on schedule.',confidenceB:.99},
  });
  assert.deepEqual(result.candidates, {});
});

test('an explicit clock observation can become a short operator cue', async () => {
  const result = await evaluate({
    a:'Next I will introduce our entire feature roadmap.',
    b:'The timer hit zero. End the pitch.',
    reply:{draftB:'The timer hit zero. End the pitch.',confidenceB:.93},
  });
  assert.deepEqual(result.candidates, {B:{text:'Wrap up now.',confidence:.93}});
});

test('a non-echoing draft from the requested seat remains available', async () => {
  const result = await evaluate({
    a:'I need my coach to check the timing.',
    b:'I can see the clock.',
    reply:{draftA:'How much time do we have?',confidenceA:.88,draftB:'Demo now.',confidenceB:.89},
    requestedSeat:'A',
  });
  assert.deepEqual(result.candidates, {A:{text:'How much time do we have?',confidence:.88}});
});

test('a new observation about a specific judge can be passed through without inventing the judge', async () => {
  const result = await evaluate({
    a:'The buttons mimic the earbuds.',
    b:'The judge on the left looks lost.',
    reply:{draftB:'The judge on the left looks lost.',confidenceB:.93},
  });
  assert.deepEqual(result.candidates, {B:{text:'The judge on the left looks lost.',confidence:.93}});
});
