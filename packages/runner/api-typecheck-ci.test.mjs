import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_API, verifyPrismaReceipt, verifyTypecheckRecipe } from './api-typecheck-ci.mjs';

function validReceipt() {
  return {
    protocol: 1,
    event: 'pinned-prisma-client-generated-in-private-overlay',
    sourceCommit: PINNED_API.commit,
    sourceTree: PINNED_API.tree,
    sourceManifestSha256: PINNED_API.manifest,
    prismaVersion: '7.10.1',
    schemaEngineSha256: PINNED_API.engineSha,
    schemaEnginePlatform: 'linux-musl-openssl-3.0.x',
    outputPath: 'apps/api/src/infra/database/generated/prisma',
    generatedFiles: 12,
    generatedBytes: 20000,
    networkEnabled: false,
    sourceReadOnly: true,
    privateProjectCopy: true,
    fullOfflineDependenciesInstalled: true,
    dependencyLifecycleScriptsExecuted: false,
    nativeLifecycleScriptsExecuted: false,
    prismaClientGeneratorExecuted: true,
    apiTypecheckExecuted: false,
    operatorGrantConsumed: false,
    taskExecutionEnabled: false,
  };
}

describe('fixed CI-only API typecheck gate', () => {
  it('accepts only the complete existing Prisma offline proof', () => {
    assert.doesNotThrow(() => verifyPrismaReceipt(validReceipt()));
  });

  const denied = [
    ['wrong commit', { sourceCommit: '0'.repeat(40) }],
    ['wrong manifest', { sourceManifestSha256: '0'.repeat(64) }],
    ['wrong Prisma engine', { schemaEngineSha256: '0'.repeat(64) }],
    ['different generated client', { outputPath: 'unreviewed' }],
    ['generation did not happen', { prismaClientGeneratorExecuted: false }],
    ['scripts were enabled', { dependencyLifecycleScriptsExecuted: true }],
    ['host source became mutable', { sourceReadOnly: false }],
    ['cache not fully staged', { fullOfflineDependenciesInstalled: false }],
    ['unexpected network', { networkEnabled: true }],
    ['task runner unexpectedly enabled', { taskExecutionEnabled: true }],
    ['grant unexpectedly consumed', { operatorGrantConsumed: true }],
    ['API code already executed', { apiTypecheckExecuted: true }],
  ];
  for (const [name, patch] of denied) {
    it('rejects ' + name, () => {
      assert.throws(() => verifyPrismaReceipt({ ...validReceipt(), ...patch }), /unverified/);
    });
  }

  it('rejects incomplete or missing prerequisite receipts', () => {
    assert.throws(() => verifyPrismaReceipt(null), /unverified/);
    assert.throws(
      () => verifyPrismaReceipt({ ...validReceipt(), generatedFiles: 0 }),
      /unverified/,
    );
  });

  it('permits only the pinned API script mapping and build config', () => {
    const pkg = { name: '@gym/api', scripts: { typecheck: 'tsc --noEmit -p tsconfig.build.json' } };
    const config = {
      extends: './tsconfig.json',
      compilerOptions: { rootDir: './src' },
      include: ['src'],
    };
    assert.doesNotThrow(() => verifyTypecheckRecipe(pkg, config));
    assert.throws(
      () =>
        verifyTypecheckRecipe(
          { ...pkg, scripts: { typecheck: 'sh -c "unreviewed command"' } },
          config,
        ),
      /reviewed fixed command/,
    );
    assert.throws(
      () => verifyTypecheckRecipe(pkg, { ...config, include: ['src', 'test'] }),
      /reviewed fixed command/,
    );
    assert.throws(
      () => verifyTypecheckRecipe(pkg, { ...config, extends: '../tsconfig.json' }),
      /reviewed fixed command/,
    );
  });
});
