import { DatabaseSync } from 'node:sqlite';

const DIMENSIONS = 512;
const STORES = new WeakMap();

function vectorize(text) {
  const vector = new Float32Array(DIMENSIONS);
  for (const term of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    let hash = 2166136261;
    for (const character of term) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    const dimension = (hash >>> 0) % DIMENSIONS;
    vector[dimension] += hash < 0 ? -1 : 1;
  }
  const magnitude = Math.hypot(...vector);
  if (magnitude) for (let i = 0; i < DIMENSIONS; i++) vector[i] /= magnitude;
  return Buffer.from(vector.buffer);
}

function dotProduct(left, right) {
  const a = Buffer.from(left.buffer, left.byteOffset, left.byteLength);
  const b = Buffer.from(right.buffer, right.byteOffset, right.byteLength);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += a.readFloatLE(i) * b.readFloatLE(i);
  return sum;
}

export function retrieveVectorReferences(documents, query, limit = 6) {
  if (!documents.length || !query.trim()) return [];
  let store = STORES.get(documents);
  if (!store) {
    const database = new DatabaseSync(':memory:');
    database.function('similarity', { deterministic: true }, dotProduct);
    database.exec('CREATE TABLE vectors (id INTEGER PRIMARY KEY, vector BLOB NOT NULL)');
    const insert = database.prepare('INSERT INTO vectors VALUES (?, ?)');
    const passages = [];
    for (const document of documents) {
      for (const passage of document.chunks) {
        insert.run(passages.length, vectorize((passage.heading ?? '') + ' ' + passage.text));
        passages.push({ ...passage, kind: document.kind });
      }
    }
    store = { database, passages };
    STORES.set(documents, store);
  }
  const matches = store.database.prepare(
    'SELECT id, similarity(vector, ?) AS score FROM vectors WHERE score > 0 ORDER BY score DESC, id LIMIT ?',
  ).all(vectorize(query), limit);
  return matches.map(({ id, score }) => ({ passage: store.passages[id], score }));
}
