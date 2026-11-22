import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReferences, retrieveReferences } from '../hub/references.mjs';
import { validateAnswer } from '../hub/questions.mjs';
import { createCodec } from '../hub/codec.mjs';

const file = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });

test('references parse text and Markdown, preserve source identity, and retrieve relevant passages', async () => {
  const documents = await parseReferences([file('brief.md', 'Our buyer is the sales team lead.'), file('notes.txt', 'The pilot runs for six weeks.')]);
  assert.equal(documents.length, 2);
  assert.notEqual(documents[0].chunks[0].id, documents[1].chunks[0].id);
  const long = await parseReferences([file('long.txt', 'Unrelated background. '.repeat(2000) + '\nThe zebra deployment is October 12.')]);
  const passages = retrieveReferences(long, 'When is the zebra deployment?', 2);
  assert.match(passages[0].text, /October 12/);
  assert.equal(documents[0].name, 'brief.md');
});

test('invalid, empty, excessive and unsupported documents are rejected', async () => {
  await assert.rejects(parseReferences([file('image.png', 'image')]), /TXT/);
  await assert.rejects(parseReferences([file('empty.md', '  ')]), /no readable text/);
  await assert.rejects(parseReferences(Array.from({ length: 9 }, () => file('a.txt', 'text'))), /eight/);
  await assert.rejects(parseReferences([file('huge.txt', 'x'.repeat(200_001))]), /200,000/);
  await assert.rejects(parseReferences([file('broken.pdf', 'not a pdf')]));
});

test('answers require a real source ID and a verbatim supporting quote', async () => {
  const docs = await parseReferences([file('brief.md', 'Our buyer is the sales team lead.')]);
  const passages = retrieveReferences(docs, 'buyer');
  const answer = { status: 'answer', question: 'Who buys it?', answer: 'The sales team lead.', sources: [{ id: passages[0].id, quote: 'Our buyer is the sales team lead.' }] };
  assert.equal(validateAnswer(answer, passages).sources[0].name, 'brief.md');
  assert.throws(() => validateAnswer({ ...answer, sources: [] }, passages), /evidence/);
  assert.throws(() => validateAnswer({ ...answer, sources: [{ id: 'invented', quote: 'Our buyer is the sales team lead.' }] }, passages), /source/);
  assert.throws(() => validateAnswer({ ...answer, sources: [{ id: passages[0].id, quote: 'We have a million paying customers.' }] }, passages), /source/);
  assert.equal(validateAnswer({ status: 'unsupported', question: 'Revenue?', answer: '', sources: [] }, passages).answer, '');
});

test('question model receives references as data and the supplied cancellation signal', async () => {
  const passages = [{ id: 'brief:1', name: 'brief.md', text: 'The pilot runs for six weeks.' }];
  const controller = new AbortController();
  let payload;
  const codec = createCodec({ env: { OPENAI_API_KEY: 'test-only' }, fetchImpl: async (url, options) => {
    assert.equal(options.signal, controller.signal);
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      status: 'answer', question: 'How long is the pilot?', answer: 'The pilot runs for six weeks.', sources: [{ id: 'brief:1', quote: 'The pilot runs for six weeks.' }],
    }) }] }] }));
  } });
  const result = await codec.answer({ signal: controller.signal, passages, requested: true, turns: [{ text: 'How long is the pilot?' }] });
  assert.equal(result.status, 'answer');
  assert.match(payload.instructions, /untrusted/);
  assert.equal(JSON.parse(payload.input).passages[0].id, 'brief:1');
  assert.equal(payload.text.format.schema.properties.status.enum.includes('resolved'), true);
  assert.equal(createCodec({ env: { TELEPATHY_LLM: 'off' } }).questionAnswering, false);
});

test('missed-point advice is grounded in both the spoken answer and an unspoken reference fact', () => {
  const passages = [{ id: 'brief:1', name: 'brief.md', text: 'The pilot lasts six weeks.' }];
  const turns = [{ text: 'How does the pilot work?' }, { text: 'We run it with one sales team.' }];
  const advice = { status: 'advice', question: 'How does the pilot work?', answer: 'You forgot to mention the six-week pilot.',
    responseQuote: 'We run it with one sales team.', sources: [{ id: 'brief:1', quote: 'The pilot lasts six weeks.' }] };
  const result = validateAnswer(advice, passages, turns);
  assert.equal(result.suggestionKind, 'advice');
  assert.equal(result.responseQuote, turns[1].text);
  assert.throws(() => validateAnswer({ ...advice, responseQuote: 'We already serve ten thousand teams.' }, passages, turns), /spoken answer/);
  assert.throws(() => validateAnswer({ ...advice, responseQuote: turns[0].text }, passages, turns), /question is not/);
  assert.throws(() => validateAnswer({ ...advice, sources: [] }, passages, turns), /evidence/);
  assert.equal(validateAnswer(advice, passages, [...turns, { text: 'The pilot lasts six weeks.' }]).status, 'resolved');
});
