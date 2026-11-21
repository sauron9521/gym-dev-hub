import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSourceAndVerify, validatePatchCheckArgs } from './patch-checks-local.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const CONTENT = 'export const answer = 42;\n';
const SHA = hash(CONTENT);

test('accepts only fixed API/Web recipes scoped to an approved source file', () => {
  for (const recipe of ['API_TYPECHECK', 'API_TEST', 'WEB_TYPECHECK', 'WEB_TEST']) {
    const path = recipe.startsWith('API_') ? 'apps/api/src/main.ts' : 'apps/web/src/app/page.tsx';
    assert.equal(validatePatchCheckArgs([recipe, path, SHA]).recipeId, recipe);
  }
  for (const args of [
    ['API_TYPECHECK', 'apps/api/src/main.ts', SHA, '--shell'],
    ['RUN_COMMAND', 'apps/api/src/main.ts', SHA],
    ['WEB_TEST', 'apps/api/src/main.ts', SHA],
    ['API_TEST', 'apps/api/src/../../.env', SHA],
    ['API_TEST', 'apps/api/src/../../.env', 'not-sha'],
    ['API_TEST', 'apps/api/src/main.ts', 'a'.repeat(65)],
    ['API_TEST', 'apps/api/src/main.ts\n--mount=/host', SHA],
    [],
  ])
    assert.throws(() => validatePatchCheckArgs(args));
});

test('copies approved worktree to private scratch but never .git metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devhub-check-stage-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(join(source, 'apps/api/src'), { recursive: true });
    await mkdir(join(source, '.git'));
    await writeFile(join(source, '.git/config'), 'should not copy');
    await writeFile(join(source, 'apps/api/src/main.ts'), CONTENT);
    const data = await stageSourceAndVerify(source, target, 'apps/api/src/main.ts', SHA);
    assert.equal(data.files, 1);
    assert.equal(data.bytes, Buffer.byteLength(CONTENT));
    assert.equal(await readFile(join(target, 'apps/api/src/main.ts'), 'utf8'), CONTENT);
    await assert.rejects(readFile(join(target, '.git/config')));
    await assert.rejects(
      stageSourceAndVerify(source, join(root, 'other'), 'apps/api/src/main.ts', 'f'.repeat(64)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses symlinks even when inside source directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devhub-check-stage-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'apps/api/src'), { recursive: true });
    await writeFile(join(source, 'apps/api/src/main.ts'), CONTENT);
    await symlink(join(source, 'apps/api/src/main.ts'), join(source, 'apps/api/src/link.ts'));
    await assert.rejects(
      stageSourceAndVerify(source, join(root, 'output'), 'apps/api/src/main.ts', SHA),
      /Symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
