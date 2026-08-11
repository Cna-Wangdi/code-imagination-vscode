import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getAnalysisScope, importResolutionPrefix } = require('../.test-dist/analysisMode.cjs');

test('keeps ordinary live analysis syntax-only', () => {
  assert.equal(getAnalysisScope(new Set(), 0), 'syntax');
  assert.equal(getAnalysisScope(new Set(['request:12']), 0), 'syntax');
});

test('loads imported dependencies only when an imported call is expanded', () => {
  assert.equal(getAnalysisScope(new Set([`${importResolutionPrefix}42`]), 0), 'imports');
});

test('uses the full project only for usage searches', () => {
  assert.equal(getAnalysisScope(new Set([`${importResolutionPrefix}42`]), 1), 'project');
});
