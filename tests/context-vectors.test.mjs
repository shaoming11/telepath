import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retrieveVectorReferences } from '../hub/context-vectors.mjs';

test('SQLite retrieves the closest reference vectors and refreshes on a new corpus', () => {
  const corpus = [{ kind: 'document', chunks: [
    { id: 'mic', text: 'The microphone captures sound in the room.' },
    { id: 'ui', text: 'Wasp generates React routes for the Safari phone client.' },
  ] }];
  const found = retrieveVectorReferences(corpus, 'Wasp React routes', 1);
  assert.equal(found[0].passage.id, 'ui');
  assert.ok(found[0].score > 0.4);
  assert.equal(retrieveVectorReferences([{ kind: 'document', chunks: [{ id: 'replacement',
    text: 'Wasp React routes' }] }], 'Wasp React routes', 1)[0].passage.id, 'replacement');
});
