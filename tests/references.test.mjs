import assert from 'node:assert/strict';
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../hub/server.mjs';
import { test } from 'node:test';
import { exactExcerptQuotes, packReferenceEvidence, parseReferences, retrieveProjectReferences, retrieveReferences } from '../hub/references.mjs';
import { buildProjectReferences, createWaspSourceSnapshot, WASP_SOURCE_SNAPSHOT } from '../hub/project-references.mjs';
import { isFrontendStackQuestion, sourcedProjectCue } from '../hub/pitch-question.mjs';
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

test('technical RAG finds evidence for paraphrased judge questions', async () => {
  const names = ['technical-reference.md', 'telepathy-pitch-brief.md', 'protocol.md', 'spec.md'];
  const documents = await parseReferences(await Promise.all(names.map(async name =>
    file(name, await readFile(new URL('../docs/' + name, import.meta.url))))));
  documents[0].priority = 0.3;
  documents.at(-1).priority = -0.35;
  const prompts = [
    ['How do you know who is talking?', /speaker identity/i],
    ['What happens during a cold start?', /latency, failures/i],
    ['How do the iPhones connect wirelessly?', /WebSockets and private routing/i],
    ['How do you avoid hallucinations?', /retrieval, grounding/i],
    ['Which OpenAI model is used for the voice agent?', /streaming inference/i],
    ['How many squeezes does the older hardware learn?', /AirPods and control routing/i],
  ];
  for (const [question, heading] of prompts) {
    const results = retrieveReferences(documents, question, 4);
    assert.ok(results.some(passage => heading.test(passage.heading ?? '')), question);
  }
  const results = retrieveReferences(documents, 'Tell me about the microphone. What do you do about hallucinations?', 4, 'What do you do about hallucinations?');
  assert.match(results[0].heading, /grounding/i);
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

test('Realtime evidence packing preserves judge-answer facts inside a smaller grounding payload', async t => {
  const sources = [
    ['Telepathy technical reference.md', '../docs/technical-reference.md', 0.3],
    ['Telepathy pitch brief.md', '../docs/telepathy-pitch-brief.md', 0],
    ['Telepathy implementation guide.md', '../README.md', 0],
    ['Telepathy protocol.md', '../docs/protocol.md', 0],
    ['Telepathy original product specification.md', '../docs/spec.md', -0.35],
  ];
  const docs = await parseReferences(await Promise.all(sources.map(async ([name, path]) =>
    file(name, await readFile(new URL(path, import.meta.url))))));
  docs.forEach((doc, i) => { doc.priority = sources[i][2]; });
  const cases = [
    ['Can you verify a speaker’s real identity?', /anonymous speaker clusters, not voice recognition/i],
    ['What happens when OpenAI times out?', /if openai misses the budget/i],
    ['Why won’t an old socket message change a new session?', /scope frames and prevent stale commands/i],
    ['Does OpenAI receive the raw mic recording?', /ElevenLabs alone receives raw mic audio/i],
    ['How do you verify the citation?', /cited IDs (?:were supplied )?and supporting quotes appear/i],
    ['What does the first squeeze before a judge question do?', /arms Question Mode|toggles Question Mode|Question Mode is armed[^.]+single earbud action/i],
    ['Which model is behind the persistent socket?', /gpt-realtime-mini/i],
    ['How do iPhones connect wirelessly?', /hotspot using HTTPS and WebSockets/i],
    ['How is AirPods 1 timing trained?', /two successful doubles and two successful triples/i],
    ['Who receives the generated voice?', /only to the (?:requesting seat|seat that asked)|to the requesting seat only/i],
    ['Can a second Stage tab capture the room?', /(?:only one stage tab owns the capture|only the mac stage owns)/i],
    ['Does the cue play while the judge is still speaking?', /waits for a committed transcript|after the question commits/i],
  ];
  let baselineBytes = 0;
  let packedBytes = 0;
  let baselineHits = 0;
  let baselineFirst = 0;
  let packedFirst = 0;
  const { documents: project } = await buildProjectReferences();
  for (const [question, fact] of cases) {
    const ranked = retrieveReferences(docs, question, 7, question);
    const packed = packReferenceEvidence(ranked, question);
    baselineBytes += Buffer.byteLength(JSON.stringify(ranked.slice(0, 4)));
    packedBytes += Buffer.byteLength(JSON.stringify(packed));
    baselineHits += Number(ranked.slice(0, 4).some(passage => fact.test(passage.text)));
    baselineFirst += Number(fact.test(ranked[0]?.text ?? ''));
    packedFirst += Number(fact.test(packed[0]?.text ?? ''));
    assert.ok(packed.length <= 4);
    assert.equal(new Set(packed.map(passage => passage.name + ':' + (passage.heading ?? passage.id))).size, packed.length);
    assert.ok(packed.some(passage => fact.test(passage.text)), question);
    const expanded = packReferenceEvidence(retrieveProjectReferences(project, question), question);
    assert.ok(expanded.some(passage => fact.test(passage.text)), 'Expanded corpus: ' + question);
    assert.ok(packed.every(passage => ranked.some(parent => parent.id === passage.id && parent.text.includes(passage.text))));
  }
  assert.ok(packedBytes < baselineBytes * 0.35, { baselineBytes, packedBytes });
  t.diagnostic(JSON.stringify({ questions: cases.length, baselineHits, packedHits: cases.length,
    baselineFirst, packedFirst, baselineBytes, packedBytes }));
});

test('Realtime evidence can recover added terminal punctuation and rejects altered words', () => {
  const passages = [{ id: 'audio', name: 'Audio', text: 'OpenAI receives transcript snapshots, recent speaker-labelled turns, and project evidence.' }];
  const answer = { status: 'answer', question: 'What goes to OpenAI?', answer: 'Transcript snapshots. Raw audio stays separate.' };
  const valid = exactExcerptQuotes([{ id: 'audio', quote: 'OpenAI receives transcript snapshots, recent speaker-labelled turns.' }], passages);
  assert.equal(validateAnswer({ ...answer, sources: valid }, passages).sources[0].quote,
    'OpenAI receives transcript snapshots, recent speaker-labelled turns');
  const altered = exactExcerptQuotes([{ id: 'audio', quote: 'OpenAI receives raw audio recordings.' }], passages);
  assert.throws(() => validateAnswer({ ...answer, sources: altered }, passages), /source/);
});

test('the rebuilt project index includes recursive docs and selects exact source code when asked', async () => {
  const { documents, index } = await buildProjectReferences();
  assert.equal(index.version, (await buildProjectReferences()).index.version);
  assert.ok(index.bytes >= 230_000 && index.bytes <= 325_000, index.bytes);
  assert.ok(index.codeFiles >= 8 && index.passages >= 300);
  assert.ok(documents.some(doc => doc.name.startsWith('docs/handbook/architecture/')));
  assert.ok(documents.some(doc => doc.name.startsWith('docs/handbook/operations/')));
  assert.ok(documents.every(doc => !doc.name.includes('.env') && !doc.name.includes('.runtime')));
  for (const [question, file, literal] of [
    ['Which handler implements stopQuestionMode in hub/session.mjs?', /^hub\/session\.mjs:\d+/, 'stopQuestionMode(seat) {'],
    ['Which source file sends Realtime response.create?', /^hub\/realtime-pitch\.mjs:\d+/, "type: 'response.create'"],
  ]) {
    const evidence = packReferenceEvidence(retrieveProjectReferences(documents, question), question);
    const snippet = evidence.find(passage => passage.kind === 'code');
    assert.match(snippet?.name ?? '', file);
    assert.ok(snippet.text.includes(literal));
    assert.ok(documents.some(doc => doc.chunks.some(chunk => chunk.id === snippet.id && chunk.text.includes(snippet.text))));
    assert.ok(evidence.filter(passage => passage.kind === 'code').length <= 1);
  }
  const question = 'How do you tell who is talking?';
  const packed = packReferenceEvidence(retrieveProjectReferences(documents, question), question);
  assert.ok(packed.some(passage => /speaker clusters/i.test(passage.text)));
  assert.ok(!packed.some(passage => passage.kind === 'code' || /original product specification/.test(passage.name)));
});

test('a running Wasp hub refreshes notes and only cites component code from the served build', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'telepathy-index-test-'));
  const root = pathToFileURL(temp + '/');
  const waspClient = join(temp, 'client');
  const hub = createHub({ env: {}, lan: '127.0.0.1', projectRoot: root, projectRefreshMs: 15, waspClient });
  t.after(async () => {
    await hub.close();
    await rm(temp, { recursive: true, force: true });
  });
  const { documents } = await buildProjectReferences({ frontend: 'wasp' });
  await mkdir(waspClient);
  const index = '<title>Fixture client</title>';
  await writeFile(join(waspClient, 'index.html'), index);
  await cp(new URL('../docs/', import.meta.url), join(temp, 'docs'), {
    recursive: true, filter: path => !path.includes('/screens'),
  });
  await copyFile(new URL('../README.md', import.meta.url), join(temp, 'README.md'));
  for (const doc of documents.filter(doc => doc.kind === 'code')) {
    const dest = join(temp, doc.name);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(new URL('../' + doc.name, import.meta.url), dest);
  }
  await writeFile(join(waspClient, WASP_SOURCE_SNAPSHOT), await createWaspSourceSnapshot(index, root));
  const info = await hub.start({ host: '127.0.0.1', port: 0 });
  const originalVersion = info.referenceIndex.version;
  const utterance = 'Where does the StageAnnouncement component render per-seat receipts?';
  const at = Date.now();
  hub.session.room.transcript.push({ text: utterance, at });
  const cue = await hub.session.composePitchCue(hub.session.pitchContext('A', at), AbortSignal.timeout(1000), performance.now(), {
    async generate(input) {
      const source = input.passages.find(item => item.kind === 'code');
      assert.match(source?.name ?? '', /^wasp-ui\/src\/StageAnnouncement\.tsx:/);
      return { status: 'answer', question: utterance, answer: 'StageAnnouncement maps the receipt to one row per seat.',
        sources: [{ id: source.id, quote: 'receipt.seats.map(row => (' }] };
    },
  });
  assert.equal(cue?.source, 'openai-realtime');
  assert.match(cue.sources[0].name, /^wasp-ui\/src\/StageAnnouncement\.tsx:/);
  hub.session.room.transcript.length = 0;
  const infoURL = new URL('/info', info.stageUrl);
  assert.equal((await fetch(new URL('/' + WASP_SOURCE_SNAPSHOT, info.stageUrl))).status, 404);
  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const status = await fetch(infoURL).then(response => response.json());
      if (predicate(status)) return status;
      await delay(18);
    }
    assert.fail('Reference refresh did not become visible');
  }
  const path = join(temp, 'docs/handbook/operations/demo-note.md');
  await writeFile(path, '# Rehearsal detail\n\nThe lighthouse calibration uses a six-step procedure.');
  const updated = await waitFor(status => status.referenceIndex.version !== originalVersion);
  const question = 'How many steps are in lighthouse calibration?';
  assert.ok(retrieveProjectReferences(hub.session.pitchReferences, question, 4).some(passage => /lighthouse calibration uses a six-step/.test(passage.text)));
  const component = join(temp, 'wasp-ui/src/StageAnnouncement.tsx');
  await appendFile(component, '\nexport const fixtureNotice = "The lighthouse receipt is printed in cyan.";\n');
  await delay(45);
  assert.equal((await fetch(infoURL).then(response => response.json())).referenceIndex.version, updated.referenceIndex.version);
  assert.ok(!hub.session.pitchReferences.find(doc => doc.name === 'wasp-ui/src/StageAnnouncement.tsx')
    .chunks.some(chunk => chunk.text.includes('fixtureNotice')));
  const rebuilt = '<title>Updated fixture client</title>';
  await writeFile(join(waspClient, WASP_SOURCE_SNAPSHOT), await createWaspSourceSnapshot(rebuilt, root));
  const mismatched = await waitFor(status => status.referenceRefresh === 'using-last-good-index');
  assert.equal(mismatched.referenceIndex.version, updated.referenceIndex.version);
  await writeFile(join(waspClient, 'index.html'), rebuilt);
  const refreshed = await waitFor(status => status.referenceIndex.version !== updated.referenceIndex.version && status.referenceRefresh === 'ready');
  const codeQuestion = 'Where does wasp-ui/src/StageAnnouncement.tsx declare fixtureNotice?';
  const codeEvidence = packReferenceEvidence(retrieveProjectReferences(hub.session.pitchReferences, codeQuestion), codeQuestion);
  assert.ok(codeEvidence.some(passage => passage.kind === 'code' && passage.text.includes('The lighthouse receipt is printed in cyan.')));
  await appendFile(path, '\n-----BEGIN PRIVATE KEY-----\n');
  const rejected = await waitFor(status => status.referenceRefresh === 'using-last-good-index');
  assert.equal(rejected.referenceIndex.version, refreshed.referenceIndex.version);
  assert.ok(retrieveProjectReferences(hub.session.pitchReferences, question, 4).some(passage => /lighthouse calibration uses a six-step/.test(passage.text)));
});

test('specific raw-audio and Realtime event questions use matching project facts', async () => {
  const { documents } = await buildProjectReferences();
  for (const [question, expectedFile, words] of [
    ['Does OpenAI receive the raw mic recording?', /technical reference/, /transcript text only/],
    ['Which source file sends Realtime response.create?', /^hub\/realtime-pitch\.mjs:/, /WebSocket/],
  ]) {
    const passages = retrieveProjectReferences(documents, question);
    const cue = validateAnswer(sourcedProjectCue(question, passages), passages);
    assert.match(cue.sources[0].name, expectedFile);
    assert.match(cue.answer, words);
  }
});

test('the loaded frontend owns the stack passage and corpus fingerprint', async () => {
  const classic = await buildProjectReferences();
  const wasp = await buildProjectReferences({ frontend: 'wasp', previous: classic });
  const question = 'What frontend framework do you use?';
  assert.notEqual(wasp.index.version, classic.index.version);
  assert.equal(await buildProjectReferences({ frontend: 'wasp', previous: wasp }), wasp);
  for (const [index, current, inactive] of [[wasp, /Wasp builds React/, /classic browser client/],
    [classic, /HTML, CSS, and JavaScript/, /Wasp frontend/]]) {
    assert.ok(index.documents.every(doc => !inactive.test(doc.name)));
    const top = retrieveProjectReferences(index.documents, question, 4);
    assert.ok(top.some(passage => current.test(passage.text)), question);
  }
  for (const text of ['What frontend framework do you use?', 'How did you build the UI?', 'Are you using React?']) {
    assert.ok(isFrontendStackQuestion(text), text);
  }
  for (const text of ['How does the UI use the microphone?', 'Why did you choose Wasp?', 'How did you build the project?']) {
    assert.ok(!isFrontendStackQuestion(text), text);
  }
});

test('the Wasp frontend retrieves compact implementation excerpts while classic omits Wasp code', async t => {
  const { documents, index } = await buildProjectReferences({ frontend: 'wasp' });
  const { documents: classic } = await buildProjectReferences();
  const checks = [
    ['Where are the Wasp PhoneRoute and StageRoute declared?', 'wasp-ui/main.wasp.ts', "route('PhoneRoute'"],
    ['Where does the React PhoneSurface insert the media controller script?', 'wasp-ui/src/Surfaces.tsx', 'controller.src'],
    ['In PhonePitchControls, what event triggers the highlight when speech begins?', 'wasp-ui/src/PhonePitchControls.tsx',
      "document.addEventListener('telepathy:pitch-speech-start'"],
    ['Which React component keeps the microphone input meter from rebuilding the transcript?', 'wasp-ui/src/StageRoomConsole.tsx', 'function RoomInputMeter'],
    ['Where does the StageAnnouncement component render per-seat receipts?', 'wasp-ui/src/StageAnnouncement.tsx', 'receipt.seats.map'],
    ['What does CalibrationTrial display while it is checking the timing?', 'wasp-ui/src/CalibrationTrial.tsx', 'Checking timing'],
    ['Where is the StageRevealHeader score announced for screen readers?', 'wasp-ui/src/StageRevealHeader.tsx', 'aria-live="polite"'],
    ['What source file checks whether a Wasp build needs refreshing?', 'scripts/build-wasp-ui', 'source.sha256'],
  ];
  let bytes = 0;
  for (const [question, source, mechanism] of checks) {
    const candidates = retrieveProjectReferences(documents, question);
    const evidence = packReferenceEvidence(candidates, question);
    const snippets = evidence.filter(passage => passage.kind === 'code');
    assert.equal(snippets.length, 1, question);
    const [snippet] = snippets;
    assert.ok(snippet.name.startsWith(source + ':') && snippet.text.includes(mechanism), question);
    assert.ok(snippet.text.length <= 360 && candidates.some(passage => passage.id === snippet.id && passage.text.includes(snippet.text)));
    bytes += Buffer.byteLength(JSON.stringify(evidence));
  }
  assert.ok(classic.every(doc => !doc.name.startsWith('wasp-ui/') && doc.name !== 'scripts/build-wasp-ui'));
  assert.ok(documents.every(doc => !/\/generated\/|node_modules|\.runtime|\.env/.test(doc.name)));
  assert.equal(retrieveProjectReferences(classic, 'Where are the seat receipts in wasp-ui/src/StageAnnouncement.tsx?')
    .some(passage => passage.kind === 'code'), false);
  t.diagnostic(JSON.stringify({ queries: checks.length, recoveredFacts: checks.length, packedBytes: bytes, indexedBytes: index.bytes }));
});
