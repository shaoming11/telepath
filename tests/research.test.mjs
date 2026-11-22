import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearch } from '../hub/research.mjs';
import { Session } from '../hub/session.mjs';
const turns = [{ text: 'Our judge Jane Doe works at Example Ventures.' }];
test('agent tool lookup retains professional evidence and deduplicates targets', async () => {
  const calls = []; let time = 0;
  const worker = createResearch({ env: { FIBER_API_KEY: 'fiber-test', OPENAI_API_KEY: 'openai-test' }, now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (JSON.parse(options.body).text?.format?.name === 'research_usefulness') return Response.json({ output: [{ content: [{ type: 'output_text', text: '{"keep":true,"reason":"Relevant investor background"}' }] }] });
    return Response.json(url.includes('openai') ? { output: [{ type: 'function_call', name: 'research_person', arguments: JSON.stringify({ name: 'Jane Doe', company: 'Example Ventures' }) }] } : { output: { data: [{ name: 'Jane Doe', primary_slug: 'jane-doe', current_job: { company_name: 'Example Ventures', title: 'Partner' }, headline: 'Investor in infrastructure', email: 'private@example.com' }] } });
  } });
  const doc = await worker.observe(turns);
  assert.equal(doc.kind, 'research');
  assert.match(doc.chunks[0].text, /Partner/);
  assert.doesNotMatch(JSON.stringify(doc), /private@example/);
  assert.equal(calls[1].body.forceCompanyMatch, true);
  assert.equal(calls[1].body.liveFetch, false);
  time += 16000;
  assert.equal(await worker.observe(turns), null);
  assert.equal(calls.filter(c => c.url.includes('fiber')).length, 1);
});
test('missing credentials never invoke providers', async () => {
  const worker = createResearch({ env: {}, fetchImpl: () => { throw new Error('Unexpected provider call'); } });
  assert.equal(worker.enabled, false);
  assert.equal(await worker.observe(turns), null);
});
test('reset rejects late research and keeps profiles out of seat snapshots', async () => {
  let finish;
  const session = new Session({ emitSeat() {}, emitStage() {}, audio: {}, codec: {}, researchFactory: () => ({ observe: () => new Promise(resolve => { finish = resolve; }) }) });
  session.phase = 'live'; session.researchInBackground(turns);
  await session.reset();
  finish({ id: 'stale', chunks: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(session.researchReferences, []);
  assert.equal(session.snapshot('A').researchReferences, undefined);
  await session.close();
});

function fixtureTool(name, args, data, { keep = true, citations = true, fail = false } = {}) {
  const calls = [];
  const worker = createResearch({ env: { OPENAI_API_KEY: 'test', FIBER_API_KEY: 'test' }, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (fail) return new Response('', { status: 429 });
    if (body.text?.format?.name === 'research_usefulness') return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ keep, reason: 'Material to question' }) }] }] });
    if (body.tools?.[0]?.type === 'web_search') return Response.json({ output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: 'A jitter buffer absorbs variation in packet arrival time.', annotations: citations ? [{ type: 'url_citation', url: 'https://www.rfc-editor.org/rfc/rfc3550', title: 'RTP' }] : [] }] },
    ] });
    if (url.includes('fiber')) return Response.json({ output: { data }, chargeInfo: { credits: 2 } });
    return Response.json({ output: [{ type: 'function_call', name, arguments: JSON.stringify(args) }] });
  } });
  return { worker, calls };
}
test('company research uses the Fiber contract and excludes contact fields', async () => {
  const { worker, calls } = fixtureTool('research_company', { company: 'Example', purpose: 'Compare their product' }, [{ preferred_name: 'Example', li_description: 'Example builds network infrastructure for real time communication.', emails: ['secret@example.com'], linkedin_primary_slug: 'example' }]);
  const doc = await worker.observe([{ text: 'How does Example compare with our product?' }]);
  assert.match(doc.chunks[0].text, /network infrastructure/);
  assert.doesNotMatch(JSON.stringify(doc), /secret@example/);
  assert.deepEqual(calls[1].body, { companyName: { value: 'Example' }, numCompanies: 2 });
  assert.deepEqual(worker.snapshot().chargeInfo, { credits: 2 });
});
test('topic research requires a real search and citations, then reviews usefulness', async () => {
  const { worker, calls } = fixtureTool('research_topic', { topic: 'jitter buffer', purpose: 'Explain latency tradeoffs' });
  const doc = await worker.observe([{ text: 'How would a jitter buffer affect our latency?' }]);
  assert.match(doc.chunks[0].text, /rfc3550/);
  assert.deepEqual(JSON.parse(calls[1].body.input), { topic: 'jitter buffer', researchGoal: 'Explain latency tradeoffs' });
  assert.equal(calls[1].body.tool_choice, 'required');
  assert.equal(calls[2].body.text.format.name, 'research_usefulness');
});
test('uncited, low-value, ambiguous, mismatched and unmentioned findings stay out of memory', async () => {
  const cases = [
    ['research_topic', { topic: 'jitter buffer' }, undefined, { citations: false }],
    ['research_topic', { topic: 'jitter buffer' }, undefined, { keep: false }],
    ['research_company', { company: 'Example' }, [{ preferred_name: 'Example' }, { preferred_name: 'Example' }], {}],
    ['research_company', { company: 'Example' }, [{ preferred_name: 'Different Company' }], {}],
    ['research_company', { company: 'Never Mentioned' }, [{ preferred_name: 'Never Mentioned' }], {}],
  ];
  for (const [name, args, data, options] of cases) {
    const { worker } = fixtureTool(name, args, data, options);
    assert.equal(await worker.observe([{ text: 'Does Example use a jitter buffer?' }]), null);
  }
});
test('provider failures are silent and status contains no credentials', async () => {
  const { worker } = fixtureTool('research_topic', { topic: 'latency' }, null, { fail: true });
  assert.equal(await worker.observe([{ text: 'What causes latency?' }]), null);
  assert.equal(worker.snapshot().status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(worker.snapshot()), /API_KEY|Bearer/);
});
test('research context is retrieved for later pitch and interview cues without uploaded files', async () => {
  const { worker } = fixtureTool('research_topic', { topic: 'jitter buffer', purpose: 'Explain latency' });
  const doc = await worker.observe([{ text: 'Explain the jitter buffer.' }]);
  const session = new Session({ emitSeat() {}, emitStage() {}, audio: {}, codec: {} });
  session.researchReferences = [doc];
  session.room.transcript.push({ text: 'How does a jitter buffer help?', at: Date.now() });
  for (const scenario of ['pitch', 'interview']) {
    session.coachScenario = scenario;
    assert.ok(session.pitchContext('A', Date.now()).passages.some(p => p.text.includes('packet arrival')));
  }
  await session.close();
});

test('whisper value review requires matching evidence, conversational need and substantive overlap', async () => {
  const { createCodec } = await import('../hub/codec.mjs');
  let verdict;
  const codec = createCodec({ env: { OPENAI_API_KEY: 'test' }, fetchImpl: async () => Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(verdict) }] }] }) });
  const request = { text: 'The jitter buffer adds delay.', turns: [{ text: 'Does a jitter buffer add delay?' }], passages: [{ text: 'A jitter buffer adds delay to absorb packet timing variation.' }] };
  verdict = { decision: 'whisper', evidenceQuote: 'A jitter buffer adds delay', conversationQuote: 'Does a jitter buffer add delay?' };
  assert.equal(await codec.assessWhisper(request), true);
  assert.equal(await codec.assessWhisper({ ...request, text: 'Mention the logo is blue.' }), false);
  verdict.evidenceQuote = 'An invented source with buffer delay';
  assert.equal(await codec.assessWhisper(request), false);
  verdict = { decision: 'stay_silent', evidenceQuote: '', conversationQuote: '' };
  assert.equal(await codec.assessWhisper(request), false);
});
test('company aliases can resolve one exact match among unrelated search results', async () => {
  const { worker } = fixtureTool('research_company', { company: 'Fiber AI' }, [
    { preferred_name: 'Fiber AI (YC S23)', names: ['Fiber AI'], li_description: 'Company and people data APIs.' },
    { preferred_name: 'Fiber Optic Marketing', names: ['Fiber Optic Marketing'] },
  ]);
  assert.ok(await worker.observe([{ text: 'What does Fiber AI sell?' }]));
});
