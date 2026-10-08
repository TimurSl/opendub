import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPacks } from '../web/admin/pack-filters.js';

const packs = [
  { id: 'short', metadata: { title: 'Small Story' }, characters: ['A', 'B'], characterCount: 2 },
  { id: 'medium', metadata: { title: 'Forest Tale' }, characters: ['A', 'B', 'C'], characterCount: 3 },
  { id: 'large', metadata: { title: 'Forest Saga' }, characters: ['A', 'B', 'C', 'D'], characterCount: 4 },
];

test('pack title and character-count filters combine locally and return empty results cleanly', () => {
  assert.deepEqual(filterPacks(packs, { title: ' forest ', minimum: 3, maximum: 3 }).map(pack => pack.id), ['medium']);
  assert.deepEqual(filterPacks(packs, { title: 'forest', minimum: 4, maximum: 2 }), []);
  assert.deepEqual(filterPacks(packs, { title: '', minimum: null, maximum: null }), packs);
});
