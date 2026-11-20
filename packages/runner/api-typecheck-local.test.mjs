import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFixedCompilerReceipt } from './api-typecheck-local.mjs';

const valid = () => ({
  protocol: 1,
  event: 'pinned-api-typecheck-ci-only',
  recipe: 'API_TYPECHECK',
  sourceCommit: '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a',
  sourceTree: '2c140e1e740b3dd8cc7582db726f46b54b73b334',
  sourceManifestSha256: 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b',
  typescriptVersion: '6.0.3',
  prismaGenerated: true,
  apiTypecheckExecuted: true,
  typecheckExitCode: 0,
  networkEnabled: false,
  sourceReadOnly: true,
  privateProjectCopy: true,
  dependencyLifecycleScriptsExecuted: false,
  operatorGrantConsumed: false,
  hubTaskExecutionEnabled: false,
  arbitraryCommandsEnabled: false,
  stdoutBytes: 0,
  stderrBytes: 0,
});

describe('local operator path wraps the already-proven exact CI recipe', () => {
  it('accepts only the unchanged offline compiler proof', () => {
    assert.doesNotThrow(() => verifyFixedCompilerReceipt(valid()));
  });
  for (const [label, change] of [
    ['unreviewed commit', { sourceCommit: 'a'.repeat(40) }],
    ['wrong recipe', { recipe: 'API_TEST' }],
    ['unreviewed script enabled', { dependencyLifecycleScriptsExecuted: true }],
    ['unexpected network', { networkEnabled: true }],
    ['forged operator grant', { operatorGrantConsumed: true }],
    ['runner-enabled command', { hubTaskExecutionEnabled: true }],
    ['nonzero compiler result', { typecheckExitCode: 1 }],
    ['missing generated Prisma client', { prismaGenerated: false }],
    ['oversized stdout', { stdoutBytes: 100000 }],
  ]) {
    it('rejects ' + label, () => {
      assert.throws(() => verifyFixedCompilerReceipt({ ...valid(), ...change }), /mismatch/);
    });
  }
});
