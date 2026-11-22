import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTextReference, warmReferenceIndex } from './references.mjs';

const ROOT = new URL('../', import.meta.url);
const FRONTEND_DOCS = {
  classic: ['docs/frontend-classic.md', 'Telepathy classic browser client.md', 0.3, 'frontend'],
  wasp: ['docs/wasp-ui.md', 'Telepathy Wasp frontend.md', 0.3, 'frontend'],
};
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
export const WASP_SOURCE_SNAPSHOT = 'reference-source.json';
const WASP_SOURCE_FILES = [
  'wasp-ui/main.wasp.ts',
  'wasp-ui/src/Surfaces.tsx',
  'wasp-ui/src/PhonePitchControls.tsx',
  'wasp-ui/src/CalibrationTrial.tsx',
  'wasp-ui/src/StageRoomConsole.tsx',
  'wasp-ui/src/StageAnnouncement.tsx',
  'wasp-ui/src/StageRevealHeader.tsx',
  'scripts/build-wasp-ui',
];
const MAX_PROJECT_BYTES = 325_000;
const CODE_LINES = 22;
const CODE_STEP = 17;
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[\w-]{24,}|mk_[\w-]{24,})\b/;

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function createWaspSourceSnapshot(index, root = ROOT) {
  const files = await Promise.all(WASP_SOURCE_FILES.map(async path => {
    const file = new URL(path, root);
    if (!(await lstat(file)).isFile()) throw new Error('Wasp source must be a regular file: ' + path);
    const text = await readFile(file, 'utf8');
    if (SECRET.test(text)) throw new Error('Secret-like content in project reference: ' + path);
    return [path, text];
  }));
  return JSON.stringify({ shell: hash(index), files: Object.fromEntries(files) });
}

async function readWaspSourceSnapshot(client) {
  const path = resolve(client, WASP_SOURCE_SNAPSHOT);
  const stat = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) throw new Error('Invalid Wasp source snapshot.');
  const [data, index] = await Promise.all([readFile(path), readFile(resolve(client, 'index.html'))]);
  const snapshot = JSON.parse(data);
  if (snapshot?.shell !== hash(index) || !WASP_SOURCE_FILES.every(source => typeof snapshot.files?.[source] === 'string')) {
    throw new Error('Wasp source snapshot is out of sync with the served app.');
  }
  return { files: Object.fromEntries(WASP_SOURCE_FILES.map(source => [source, snapshot.files[source]])), version: hash(data) };
}

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

export async function buildProjectReferences({ previous, root = ROOT, frontend = 'classic', waspClient } = {}) {
  const handbook = await handbookPaths('docs/handbook', root);
  const snapshot = frontend === 'wasp' && waspClient ? await readWaspSourceSnapshot(waspClient) : null;
  const source_files = frontend === 'wasp' && (!waspClient || snapshot) ? [...SOURCE_FILES, ...WASP_SOURCE_FILES] : SOURCE_FILES;
  const entries = [FRONTEND_DOCS[frontend], ...CORE_DOCS, ...handbook.map(path => [path, path, 0.1]),
    ...source_files.map(path => [path, path, 0, 'code'])];
  const file_fingerprints = await Promise.all(entries.map(async ([path]) => {
    if (typeof snapshot?.files[path] === 'string') return [path, snapshot.version];
    const stat = await lstat(new URL(path, root));
    if (!stat.isFile()) throw new Error('Project reference must be a regular file: ' + path);
    return [path, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  }));
  const fingerprint = JSON.stringify(file_fingerprints);
  if (previous?.fingerprint === fingerprint) return previous;
  let bytes = 0;
  const version = createHash('sha256');
  const documents = [];
  for (const [path, name, priority, kind = path === 'docs/spec.md' ? 'historical' : 'document'] of entries) {
    const built = snapshot?.files[path];
    const data = typeof built === 'string' ? Buffer.from(built) : await readFile(new URL(path, root));
    const text = data.toString('utf8');
    bytes += data.length;
    if (bytes > MAX_PROJECT_BYTES) throw new Error('Built-in project corpus exceeds its size budget.');
    if (SECRET.test(text)) throw new Error('Secret-like content in project reference: ' + path);
    const id = createHash('sha256').update(path + '\0').update(data).digest('hex').slice(0, 16);
    version.update(id);
    documents.push(kind === 'code' ? sourceReference(path, text, id)
      : createTextReference(name, text, { id, markdown: true, priority, kind }));
  }
  warmReferenceIndex(documents);
  return { documents, fingerprint, index: {
    version: version.digest('hex').slice(0, 12), bytes, documents: documents.length,
    codeFiles: source_files.length, passages: documents.reduce((total, doc) => total + doc.chunks.length, 0),
  } };
}
