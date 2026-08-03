import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculateNodePositions } = require('../.test-dist/graphLayout.cjs');

const model = {
  fileName: 'Example.tsx',
  languageId: 'typescriptreact',
  nodes: [
    { id: 'event', kind: 'event', label: 'Button click' },
    { id: 'function', kind: 'function', label: 'load()' },
    { id: 'async', kind: 'async', label: 'fetch()' },
    { id: 'success', kind: 'success', label: 'Success' },
    { id: 'error', kind: 'error', label: 'Error' },
    { id: 'render', kind: 'render', label: 'UI re-renders' }
  ],
  edges: [
    { id: '1', source: 'event', target: 'function' },
    { id: '2', source: 'function', target: 'async' },
    { id: '3', source: 'async', target: 'success' },
    { id: '4', source: 'async', target: 'error' },
    { id: '5', source: 'success', target: 'render' },
    { id: '6', source: 'error', target: 'render' }
  ]
};

test('lays dependencies out left-to-right without overlapping branches', () => {
  const positions = calculateNodePositions(model);
  assert.ok(positions.get('event').x < positions.get('function').x);
  assert.ok(positions.get('function').x < positions.get('async').x);
  assert.ok(positions.get('async').x < positions.get('success').x);
  assert.equal(positions.get('success').x, positions.get('error').x);
  assert.notEqual(positions.get('success').y, positions.get('error').y);
});

test('produces deterministic positions for an unchanged model', () => {
  assert.deepEqual([...calculateNodePositions(model)], [...calculateNodePositions(model)]);
});
