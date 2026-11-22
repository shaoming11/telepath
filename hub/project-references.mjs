import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { createTextReference, warmReferenceIndex } from './references.mjs';

const ROOT = new URL('../', import.meta.url);
const CORE_DOCS = [
  ['docs/technical-reference.md', 'Telepathy technical reference.md', 0.3],
  ['docs/telepathy-pitch-brief.md', 'Telepathy pitch brief.md', 0],
  ['README.md', 'Telepathy implementation guide.md', 0],
  ['docs/protocol.md', 'Telepathy protocol.md', 0],
  ['docs/spec.md', 'Telepathy original product specification.md', -0.35],
  ['docs/maritime.md', 'docs/maritime.md', 0],
  ['docs/rehearsal.md', 'docs/rehearsal.md', 0],
  ['docs/pitch.md', 'docs/pitch.md', 0],
];
const SOURCE_FILES = [
  'hub/server.mjs', 'hub/session.mjs', 'hub/audio.mjs', 'hub/codec.mjs', 'hub/realtime-pitch.mjs',
  'public/capture.mjs', 'public/pcm-worklet.mjs', 'public/input.mjs', 'public/network.mjs',
  'public/earbuds/airpods-1/input.mjs', 'public/earbuds/airpods-pro/input.mjs',
];
const MAX_PROJECT_BYTES = 325_000;
const CODE_LINES = 22;
const CODE_STEP = 17;
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[\w-]{24,}|mk_[\w-]{24,})\b/;

async function handbookPaths(directory, root) {
  const entries = await readdir(new URL(directory + '/', root), { withFileTypes: true });
  const paths = [];
  for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[\w.-]+$/.test(item.name) || item.name.startsWith('.')) continue;
    const path = directory + '/' + item.name;
    if (item.isDirectory()) paths.push(...await handbookPaths(path, root));
    else if (item.isFile() && path.endsWith('.md')) paths.push(path);
  }
  return paths;
}

function sourceReference(path, text, id) {
  const lines = text.split('\n');
  const chunks = [];
  let symbol = '';
  for (let start = 0; start < lines.length; start += CODE_STEP) {
    for (const line of lines.slice(Math.max(0, start - CODE_STEP), start + 1)) {
      const name = line.match(/^ {0,2}(?:export )?(?:async )?(?:function )?([A-Za-z_$][\w$]*)\s*\(/)?.[1];
      if (name && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) symbol = name;
    }
    const end = Math.min(start + CODE_LINES, lines.length);
    const excerpt = lines.slice(start, end).join('\n').trim();
    if (excerpt) chunks.push({
      id: id + ':' + (start + 1), name: path + ':' + (start + 1) + '–' + end,
      heading: path + (symbol ? ' ' + symbol : ''), text: excerpt, kind: 'code',
    });
    if (end === lines.length) break;
  }
  return { id, name: path, kind: 'code', priority: 0, characters: text.length, chunks };
}

export async function buildProjectReferences({ previous, root = ROOT } = {}) {
  const handbook = await handbookPaths('docs/handbook', root);
  const entries = [...CORE_DOCS, ...handbook.map(path => [path, path, 0.1]), ...SOURCE_FILES.map(path => [path, path, 0, true])];
  const fingerprint = JSON.stringify(await Promise.all(entries.map(async ([path]) => {
    const stat = await lstat(new URL(path, root));
    if (!stat.isFile()) throw new Error('Project reference must be a regular file: ' + path);
    return [path, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  })));
  if (previous?.fingerprint === fingerprint) return previous;
  let bytes = 0;
  const version = createHash('sha256');
  const documents = [];
  for (const [path, name, priority, code] of entries) {
    const url = new URL(path, root);
    const data = await readFile(url);
    const text = data.toString('utf8');
    bytes += data.length;
    if (bytes > MAX_PROJECT_BYTES) throw new Error('Built-in project corpus exceeds its size budget.');
    if (SECRET.test(text)) throw new Error('Secret-like content in project reference: ' + path);
    const id = createHash('sha256').update(path + '\0').update(data).digest('hex').slice(0, 16);
    version.update(id);
    documents.push(code ? sourceReference(path, text, id)
      : createTextReference(name, text, { id, markdown: true, priority, kind: path === 'docs/spec.md' ? 'historical' : 'document' }));
  }
  warmReferenceIndex(documents);
  return { documents, fingerprint, index: {
    version: version.digest('hex').slice(0, 12), bytes, documents: documents.length,
    codeFiles: SOURCE_FILES.length, passages: documents.reduce((total, doc) => total + doc.chunks.length, 0),
  } };
}
