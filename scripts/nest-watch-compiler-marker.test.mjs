import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNestCompilerMarker } from './nest-watch-compiler-marker.mjs';

const TRIGGER = 'File change detected. Starting incremental compilation...';

test('recognizes a real TypeScript watch rebuild message across chunks exactly once', () => {
  const seen = [];
  const observe = createNestCompilerMarker(() => seen.push('rebuild'));
  observe('12:03:12 - Starting compilation in watch mode...\n');
  observe(Buffer.from('12:03:17 - File chan'));
  assert.deepEqual(seen, []);
  observe(Buffer.from('ge detected. Starting incremental compilation...\n'));
  assert.deepEqual(seen, ['rebuild']);
  observe('Found 0 errors. Watching for file changes.\n');
  assert.deepEqual(seen, ['rebuild']);
});

test('detects consecutive messages without duplicates when repeating tail', () => {
  let calls = 0;
  const observe = createNestCompilerMarker(() => calls++);
  observe(TRIGGER + ' ' + TRIGGER + '\n');
  assert.equal(calls, 2);
  observe('No change.');
  assert.equal(calls, 2);
  observe('File change dete');
  observe('cted. Starting incremental compilation...');
  assert.equal(calls, 3);
});

test('ignores terminal output that does not prove a TypeScript rebuild', () => {
  let calls = 0;
  const observe = createNestCompilerMarker(() => calls++);
  observe('Nest application successfully started.');
  observe('File updated by operator, but no build.');
  observe('Found 0 errors. Watching for file changes.');
  assert.equal(calls, 0);
});

test('rejects invalid callbacks', () => {
  assert.throws(() => createNestCompilerMarker(null), TypeError);
});
