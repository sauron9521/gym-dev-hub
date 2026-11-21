import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  validatePatchCheckReceipt,
  validatePatchCheckSecurity,
  runPatchChecksDocker,
} from '../src/worktree/worktree-patch-checks-docker.js';

const path = 'apps/api/src/main.ts';
const sha = 'a'.repeat(64);
const basic = {
  protocol: 1,
  event: 'one-file-post-apply-check-executed',
  recipeId: 'API_TYPECHECK',
  filePathSha256: createHash('sha256').update(path).digest('hex'),
  proposedSha256: sha,
  stageFiles: 10,
  stageBytes: 2000,
  testsExecuted: false,
  typecheckExecuted: true,
  exitCode: 0,
  sourceReadOnly: true,
  networkEnabled: false,
  lifecycleScriptsExecuted: false,
  arbitraryCommandsEnabled: false,
  stdoutBytes: 12,
  stderrBytes: 0,
};

describe('pinned Docker one-file check receipt/security policy', () => {
  it('accepts only matching bounded immutable check receipt', () => {
    expect(
      validatePatchCheckReceipt(JSON.stringify(basic), 'API_TYPECHECK', path, sha),
    ).toMatchObject({ stdoutBytes: 12, stderrBytes: 0, stageFiles: 10 });
    const testReply = {
      ...basic,
      recipeId: 'API_TEST',
      testsExecuted: true,
      typecheckExecuted: false,
    };
    expect(
      validatePatchCheckReceipt(JSON.stringify(testReply), 'API_TEST', path, sha),
    ).toMatchObject({ stageBytes: 2000 });
  });

  it('rejects mismatched recipe, changed SHA, unexpected privileges and unbounded data', () => {
    for (const change of [
      { sourceReadOnly: false },
      { networkEnabled: true },
      { arbitraryCommandsEnabled: true },
      { lifecycleScriptsExecuted: true },
      { recipeId: 'WEB_TEST' },
      { proposedSha256: 'b'.repeat(64) },
      { filePathSha256: 'b'.repeat(64) },
      { stdoutBytes: 70_000 },
      { stageFiles: 6000 },
      { exitCode: 1 },
      { testsExecuted: true },
    ]) {
      expect(() =>
        validatePatchCheckReceipt(
          JSON.stringify({ ...basic, ...change }),
          'API_TYPECHECK',
          path,
          sha,
        ),
      ).toThrow();
    }
    expect(() => validatePatchCheckReceipt('not-json', 'API_TYPECHECK', path, sha)).toThrow();
  });

  it('requires non-root cap-drop and fixed private scratch mounts', () => {
    const good =
      JSON.stringify(['ALL']) +
      '|' +
      JSON.stringify(['no-new-privileges:true']) +
      '|' +
      JSON.stringify({
        '/workspace': 'rw,exec,nosuid,nodev,size=3072m,mode=1777',
        '/results': 'rw,nosuid,nodev,noexec,size=32m,mode=1777',
        '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777',
      });
    expect(() => validatePatchCheckSecurity(good)).not.toThrow();
    for (const bad of [
      good.replace('no-new-privileges:true', 'privileged'),
      good.replace('noexec', 'exec'),
      good.replace('rw,exec,nosuid,nodev,size=3072m', 'rw,nosuid,nodev,noexec,size=3072m'),
      good.replace('["ALL"]', '[]'),
      good.replace('/results', '/host'),
    ])
      expect(() => validatePatchCheckSecurity(bad)).toThrow();
  });

  it('rejects unapproved Docker recipe, source path and arbitrary command before Docker is called', async () => {
    const prepared = { imageId: 'sha256:' + sha, mounts: [] };
    const controller = new AbortController();
    await expect(
      runPatchChecksDocker(prepared, 'SHELL_EXEC' as never, path, sha, controller.signal),
    ).rejects.toThrow('Unsupported');
    await expect(
      runPatchChecksDocker(prepared, 'WEB_TEST', path, sha, controller.signal),
    ).rejects.toThrow('approved source');
    await expect(
      runPatchChecksDocker(prepared, 'API_TEST', 'apps/api/src/../.env', sha, controller.signal),
    ).rejects.toThrow('approved source');
  });
});
