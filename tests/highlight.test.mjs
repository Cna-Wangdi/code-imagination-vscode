import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getEdgePresentation } = require('../.test-dist/graphHighlight.cjs');

const edge = { source: 'condition', target: 'return' };

test('keeps edges solid unless they touch the highlighted node', () => {
  assert.deepEqual(getEdgePresentation(edge), {
    active: false,
    animated: false,
    color: '#8b949e',
    strokeWidth: 2
  });
  assert.equal(getEdgePresentation(edge, 'unrelated').animated, false);
  assert.equal(getEdgePresentation(edge, 'condition').animated, true);
  assert.equal(getEdgePresentation(edge, 'return').animated, true);
});
