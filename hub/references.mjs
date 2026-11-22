import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT = 200_000;
const STOP_WORDS = new Set('how what why where when who which the and are does can for that this with your its our was were from into have has will would about tell explain use'.split(' '));
const ALIASES = [
  [/(?:developed|built|made|build|put together) (?:the |this |your )?(?:project|app|telepathy)\b/i, 'built developed implementation safari mac hub private cues'],
  [/bluetooth|squeeze|tap|headphone|headset|airpod/i, 'earbud media nexttrack squeeze'],
  [/recogniz.*speak|speaker|who.*talk|diariz/i, 'diarization anonymous speaker clusters'],
  [/slow|lag|fast|latency|cold start|time(?:s?\s+)?out/i, 'latency partial fallback deadline budget'],
  [/sourc|citat|accurate|hallucinat|knowledge|\brag\b|embedding/i, 'retrieval grounding reference evidence cited supporting quotes'],
  [/stale|old socket|old.*(?:message|command)|new session/i, 'session hub ids scope frames stale reset'],
  [/protocol|connect|wireless|rejoin|network|hotspot|tls/i, 'websocket hotspot https reconnect'],
  [/which model|ai model|openai|voice agent/i, 'openai realtime gpt model'],
  [/calibrat|timing.*train|old(?:er)? hardware/i, 'calibration successful doubles triples retry'],
  [/who (?:can hear|gets|receives)|private.*(?:cue|voice)|generated voice/i, 'private cue requesting seat'],
  [/(?:judge|question).*(?:speak|finish|playback)|playback.*(?:judge|question)/i, 'committed transcript question partial playback'],
  [/screen reader|aria live/i, 'aria live polite status'],
  [/speech.*(?:start|begin)|(?:start|begin).*speech/i, 'speech start'],
  [/\bwasp\b.*\b(?:rebuild|refresh|refreshing|stale|build inputs)\b/i, 'fingerprint source sha256 ensure'],
];
const INDEXES = new WeakMap();
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const EVIDENCE_CHARS = 360;
const SOURCE_FILE = /\.(?:mjs|tsx?|css)$/i;

function terms(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !STOP_WORDS.has(word))
    .map(word => word.length > 4 ? word.replace(/s$/, '') : word);
}

function codeTerms(text) {
  return [...terms(text), ...terms(text.replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2'))];
}

function adjacentTerms(text) {
  const words = terms(text);
  return words.slice(0, -1).map((word, index) => ' ' + word + ' ' + words[index + 1] + ' ');
}

function codeQueryPhrases(question) {
  const aliases = ALIASES.filter(([pattern]) => pattern.test(question)).flatMap(([, expansion]) => adjacentTerms(expansion));
  return [...new Set([...adjacentTerms(question), ...aliases])];
}

function queryTerms(query, focus) {
  const key = focus || query;
  const tokens = new Map(terms(query).map(word => [word, 0.45]));
  for (const [pattern, expansion] of ALIASES) {
    if (pattern.test(key)) for (const word of terms(expansion)) if (!tokens.has(word)) tokens.set(word, 0.65);
  }
  for (const word of terms(key)) tokens.set(word, 1);
  return tokens;
}

export function recallRoomTurns(turns, question, limit = 2) {
  const query = new Set(terms(question).filter(word => word.length >= 5));
  if (!query.size) return [];
  return turns.map((turn, index) => ({
    turn, index, hits: [...new Set(terms(turn.text))].filter(word => query.has(word)).length,
  })).filter(item => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.index - a.index).slice(0, limit)
    .sort((a, b) => a.index - b.index).map(({ turn }) => ({ speaker: turn.speaker, text: turn.text.slice(0, 230) }));
}

function codeIdentifiers(text) {
  return [...new Set(text.match(/\b(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|tsx?|css)\b|\bscripts\/build-wasp-ui\b|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z][a-z\d]+[A-Z][\w$]*\b/g) ?? [])];
}

function isSourcePath(identifier) {
  return SOURCE_FILE.test(identifier) || identifier === 'scripts/build-wasp-ui';
}

function matchesSource(name, identifier) {
  const file = name.split(':', 1)[0].toLowerCase();
  const hint = identifier.toLowerCase();
  return file === hint || file.endsWith('/' + hint);
}

function codeMatch(text, name, identifiers) {
  return identifiers.reduce((score, identifier) => {
    if (isSourcePath(identifier)) return score + (matchesSource(name, identifier) ? 40 : 0);
    if (!text.includes(identifier)) return score;
    if (/^[A-Z]/.test(identifier)) return score + 2;
    const definition = text.split('\n').some(line => {
      const clean = line.trim().replace(/^(?:export )?(?:async )?(?:function )?/, '');
      return clean.startsWith(identifier + '(') && clean.includes('{');
    });
    return score + (definition ? 28 : 18);
  }, 0);
}

function bestCodeWindow(passage, tokens, identifiers, phrases) {
  const lines = passage.text.split('\n');
  let best;
  for (let index = 0; index < lines.length; index++) {
    const text = lines.slice(index, index + 4).join('\n').trim().slice(0, EVIDENCE_CHARS);
    if (text.length < 8) continue;
    const words = codeTerms(text);
    const searchable = ' ' + words.join(' ') + ' ';
    const detach = text.includes('removeEventListener') && !text.includes('addEventListener') && !tokens.has('remove') && !tokens.has('cleanup');
    const score = [...new Set(words)].reduce((sum, word) => sum + (tokens.get(word) ?? 0), 0)
      + phrases.reduce((sum, phrase) => sum + (searchable.includes(phrase) ? 3 : 0), 0)
      + codeMatch(text, passage.name, identifiers) - Number(detach);
    if (!best || score >= best.score) best = { text, score };
  }
  return best;
}

function indexChunks(document) {
  let indexed = INDEXES.get(document);
  if (!indexed) {
    const postings = new Map();
    indexed = {
      chunks: document.chunks,
      weight: document.priority ?? 0,
      postings,
    };
    const tokenize = document.kind === 'code' ? codeTerms : terms;
    for (const [index, chunk] of indexed.chunks.entries()) {
      const weights = new Map([...new Set(tokenize(chunk.text))].map(word => [word, 1]));
      for (const word of new Set(tokenize(chunk.heading ?? ''))) weights.set(word, (weights.get(word) ?? 0) + 0.75);
      for (const [word, weight] of weights) {
        if (!postings.has(word)) postings.set(word, []);
        postings.get(word).push({ index, weight });
      }
    }
    INDEXES.set(document, indexed);
  }
  return indexed;
}

export async function parseReferences(files) {
  if (!Array.isArray(files) || files.length > 8) throw new Error('Choose up to eight documents.');
  let bytes = 0, characters = 0;
  const documents = [];
  for (const file of files) {
    if (typeof file?.name !== 'string' || typeof file?.data !== 'string') throw new Error('Invalid document upload.');
    const name = file.name.split(/[\\/]/).at(-1).slice(0, 160);
    const extension = extname(name).toLowerCase();
    if (!['.txt', '.md', '.pdf', '.docx'].includes(extension)) throw new Error(`${name}: use TXT, Markdown, PDF or DOCX.`);
    const buffer = Buffer.from(file.data, 'base64');
    bytes += buffer.length;
    if (!buffer.length || buffer.length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw new Error('Limit: 5 MB per file, 8 MB total.');
    let text;
    if (extension === '.pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 100) throw new Error(`${name}: limit is 100 pages.`);
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join(''));
        }
        text = pages.join('\n\n');
      } finally { await task.destroy(); }
    } else if (extension === '.docx') {
      const { default: mammoth } = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
    text = text.replace(/\u0000/g, '').trim();
    if (!text) throw new Error(`${name}: no readable text. Scanned PDFs need OCR first.`);
    characters += text.length;
    if (characters > MAX_TEXT) throw new Error('Documents exceed 200,000 extracted characters. Upload shorter references.');
    documents.push(createTextReference(name, text, { markdown: extension === '.md' }));
  }
  return documents;
}

export function createTextReference(name, text, { id = randomUUID(), markdown = false, priority = 0, kind = 'document' } = {}) {
  const chunks = [];
  for (const section of markdown ? text.split(/\n(?=#{1,4} )/) : [text]) {
    const heading = section.match(/^#{1,4} (.+)/)?.[1];
    for (let start = 0; start < section.length; start += 1100) {
      const passage = section.slice(start, start + 1400).trim();
      if (!passage || /^#{1,4} [^\n]+$/.test(passage)) continue;
      chunks.push({ id: `${id}:${chunks.length + 1}`, name, text: passage, ...(heading && { heading }) });
    }
  }
  if (!chunks.length) chunks.push({ id: `${id}:1`, name, text });
  return { id, name, characters: text.length, chunks, priority, kind };
}

export function retrieveReferences(documents, query, limit = 10, focus = '', identifiers = []) {
  const tokens = queryTerms(query, focus);
  const focusedWords = (focus || query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const phrases = focusedWords.slice(0, -1).flatMap((word, index) => {
    const next = focusedWords[index + 1];
    return !STOP_WORDS.has(word) && !STOP_WORDS.has(next) ? [word + ' ' + next] : [];
  });
  const indexes = documents.map(indexChunks);
  const count = indexes.reduce((total, index) => total + index.chunks.length, 0);
  const rows = indexes.map(index => ({ ...index, scores: new Float64Array(index.chunks.length) }));
  for (const [word, boost] of tokens) {
    const frequency = indexes.reduce((total, index) => total + (index.postings.get(word)?.length ?? 0), 0);
    if (!frequency) continue;
    const rarity = boost * (1 + Math.log((count + 1) / (frequency + 1)));
    for (const row of rows) {
      for (const { index, weight } of row.postings.get(word) ?? []) row.scores[index] += rarity * weight;
    }
  }
  return rows.flatMap(row => row.chunks.map((chunk, index) => ({
    chunk, score: row.scores[index] * (1 + row.weight) + codeMatch(chunk.text, chunk.name, identifiers)
      + phrases.reduce((score, phrase) => score + (chunk.text.toLowerCase().includes(phrase) ? 4 : 0), 0),
  }))).sort((a, b) => b.score - a.score).slice(0, limit).map(row => row.chunk);
}

export function warmReferenceIndex(documents) {
  documents.forEach(indexChunks);
}

export function retrieveProjectReferences(documents, query, limit = 7, focus = '') {
  const question = focus || query;
  const includeHistory = /\b(?:original|historical|initial|first) (?:brief|spec(?:ification)?|design|plan)\b|\bspec\.md\b/i.test(question);
  const prose = documents.filter(document => document.kind !== 'code' && (includeHistory || document.kind !== 'historical'));
  const ranked = retrieveReferences(prose, query, limit, focus);
  const identifiers = codeIdentifiers(question);
  const paths = identifiers.filter(isSourcePath);
  const code = documents.filter(document => document.kind === 'code' && (!paths.length || paths.some(path => matchesSource(document.name, path))));
  if (!code.length || limit < 2 || (!identifiers.length && !/\b(?:code|source file|handler|module|function|class|component|implementation)\b/i.test(question))) return ranked;
  const components = identifiers.filter(identifier => /^[A-Z][\w$]*$/.test(identifier));
  const owners = paths.length ? [] : code.filter(doc => components.some(component => matchesSource(doc.name, component + '.tsx')));
  const codePool = owners.length ? owners : code;
  const initial = retrieveReferences(codePool, query, 4, focus, identifiers);
  const primary = codePool.find(document => document.chunks.includes(initial[0]));
  const additional = primary ? retrieveReferences([primary], query, 5, focus, identifiers) : [];
  const tokens = queryTerms(question);
  const phrases = codeQueryPhrases(question);
  const windowIdentifiers = identifiers.filter(identifier => !/^[A-Z][\w$]*$/.test(identifier));
  const snippets = [...new Set([...initial, ...additional])].map((passage, rank) => ({
    passage, score: (bestCodeWindow(passage, tokens, windowIdentifiers, phrases)?.score ?? 0) + 1 / (rank + 2),
  })).sort((a, b) => b.score - a.score).slice(0, Math.min(2, limit - 1)).map(row => row.passage);
  const insertAt = Math.min(3, limit - snippets.length);
  return [...ranked.slice(0, insertAt), ...snippets, ...ranked.slice(insertAt)].slice(0, limit);
}

export function packReferenceEvidence(passages, question, limit = 4) {
  const tokens = queryTerms(question);
  const code = passages.filter(passage => passage.kind === 'code');
  const candidates = passages.filter(passage => passage.kind !== 'code').flatMap((passage, rank) => {
    const body = passage.text.replace(/^#{1,4} [^\n]+\n+/, '')
      .split(/\bSources: (?=(?:hub|public|docs|scripts|maritime|wasp-ui)\/)/, 1)[0].trim();
    const sentences = [...SENTENCES.segment(body)];
    const windows = [];
    for (let i = 0; i < sentences.length; i++) {
      const start = sentences[i].index;
      const single = sentences[i].segment.trim();
      const pair = (sentences[i].segment + (sentences[i + 1]?.segment ?? '')).trim();
      for (const text of [single, ...(pair !== single && pair.length <= EVIDENCE_CHARS ? [pair] : [])]) {
        if (text.length < 8) continue;
        const excerpt = text.length <= EVIDENCE_CHARS ? text : text.slice(0, EVIDENCE_CHARS).replace(/\s+\S*$/, '');
        const words = new Set(terms(excerpt));
        const matches = [...words].reduce((score, word) => score + (tokens.get(word) ?? 0), 0);
        windows.push({ passage: { ...passage, text: excerpt }, words, start, score: matches - excerpt.length / 900 + 1 / (rank + 2) });
      }
    }
    windows.sort((a, b) => b.score - a.score || a.start - b.start);
    return windows.slice(0, 2);
  }).sort((a, b) => b.score - a.score);

  const chosen = [];
  const sections = new Set();
  for (const candidate of candidates) {
    if (chosen.length >= limit - Number(code.length > 0)) break;
    const { passage, words } = candidate;
    const section = passage.heading ? passage.name + ':' + passage.heading : passage.id;
    if (sections.has(section)) continue;
    if (chosen.some(prior => {
      const overlap = [...words].filter(word => prior.words.has(word)).length;
      return overlap / Math.min(words.size, prior.words.size) >= 0.72;
    })) continue;
    chosen.push(candidate);
    sections.add(section);
  }
  const result = chosen.map(item => item.passage);
  if (code.length && result.length < limit) {
    const identifiers = codeIdentifiers(question).filter(identifier => !/^[A-Z][\w$]*$/.test(identifier));
    const phrases = codeQueryPhrases(question);
    const best = code.map((passage, rank) => {
      const window = bestCodeWindow(passage, tokens, identifiers, phrases);
      return window && { passage, text: window.text, score: window.score + 1 / (rank + 2) };
    }).filter(Boolean).sort((a, b) => b.score - a.score)[0];
    if (best) result.push({ ...best.passage, text: best.text });
  }
  return result;
}

export function exactExcerptQuotes(sources, passages) {
  if (!Array.isArray(sources)) return sources;
  return sources.map(source => {
    const passage = passages.find(item => item.id === source?.id);
    if (!passage || typeof source.quote !== 'string') return source;
    const text = passage.text.replace(/\s+/g, ' ').trim();
    const quote = source.quote.replace(/\s+/g, ' ').trim();
    if (text.includes(quote)) return source;
    const trimmed = quote.replace(/[.!?…]+$/, '');
    if (trimmed.length < 8 || !text.includes(trimmed)) return source;
    return { ...source, quote: trimmed };
  });
}
