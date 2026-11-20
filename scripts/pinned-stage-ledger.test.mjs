import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import {
  beginPinnedStage,
  finishPinnedStage,
  pruneStaleRunLock,
  pruneVerifiedStages,
  stageRecoveryReport,
} from './pinned-stage-ledger.mjs';

const CHECKOUT = 'a'.repeat(64);
const ANOTHER = 'b'.repeat(64);
const OLD = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const NOT_ALIVE = 2_147_483_000;
const roots = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gym-owned-stage-test-'));
  roots.push(root);
  return root;
}

async function stale(ctx, edit = {}) {
  const ledger = JSON.parse(await readFile(ctx.recordPath, 'utf8'));
  const old = { ...ledger, createdAt: OLD, pid: NOT_ALIVE, ...edit };
  await writeFile(ctx.recordPath, JSON.stringify(old) + '\n');
  const lock = join(ctx.root, '.pinned-provision.lock');
  const locked = JSON.parse(await readFile(lock, 'utf8'));
  await writeFile(lock, JSON.stringify({ ...locked, pid: NOT_ALIVE, createdAt: OLD }) + '\n');
  return old;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe('exclusive private stage ownership ledger', () => {
  it('records the exact original stage inode and releases a finished run', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    const stage = await lstat(ctx.stage);
    const ledger = JSON.parse(await readFile(ctx.recordPath, 'utf8'));
    assert.equal(ledger.stageName, ctx.record.stageName);
    assert.equal(ledger.dev, String(stage.dev));
    assert.equal(ledger.ino, String(stage.ino));
    await assert.rejects(beginPinnedStage(root, CHECKOUT), /EEXIST/);
    await rm(ctx.stage, { recursive: true });
    await finishPinnedStage(ctx);
    assert.deepEqual(await stageRecoveryReport(root, CHECKOUT), []);
    const subsequent = await beginPinnedStage(root, CHECKOUT);
    await rm(subsequent.stage, { recursive: true });
    await finishPinnedStage(subsequent);
  });

  it('never cleans the staging folder while its owner PID is still alive', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    const ledger = JSON.parse(await readFile(ctx.recordPath, 'utf8'));
    await writeFile(ctx.recordPath, JSON.stringify({ ...ledger, createdAt: OLD }) + '\n');
    const report = await stageRecoveryReport(root, CHECKOUT);
    assert.equal(report[0].removable, false);
    assert.equal(report[0].reason, 'process-still-alive');
    const outcome = await pruneVerifiedStages(root, CHECKOUT, false);
    assert.deepEqual(outcome.removed, []);
    await lstat(ctx.stage);
  });

  it('prunes only one journal-owned dead, old stage and later unlocks the run', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    await stale(ctx);
    const safeFile = join(ctx.stage, 'partial-api-archive.txt');
    await writeFile(safeFile, 'partial data');
    const unrelated = join(root, 'stage-legacy');
    await mkdir(unrelated);
    await writeFile(join(unrelated, 'keep.txt'), 'valuable');
    const listed = await stageRecoveryReport(root, CHECKOUT);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].reason, 'verified-stale');
    const outcome = await pruneVerifiedStages(root, CHECKOUT, false);
    assert.deepEqual(outcome.removed, [ctx.record.stageName]);
    await assert.rejects(lstat(ctx.stage), /ENOENT/);
    assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'valuable');
    assert.equal(await pruneStaleRunLock(root, CHECKOUT, false), true);
    const next = await beginPinnedStage(root, CHECKOUT);
    await rm(next.stage, { recursive: true });
    await finishPinnedStage(next);
  });

  it('refuses foreign checkout, incorrect inode, and symlink staging root', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    await stale(ctx);
    const foreign = await stageRecoveryReport(root, ANOTHER);
    assert.equal(foreign[0].removable, false);
    const replaced = join(root, 'somewhere-else');
    await rename(ctx.stage, replaced);
    await mkdir(ctx.stage);
    const result = await pruneVerifiedStages(root, CHECKOUT, false);
    assert.deepEqual(result.removed, []);
    await lstat(ctx.stage);
    await rm(ctx.stage, { recursive: true });
    await symlink(replaced, ctx.stage, 'dir');
    const afterLink = await stageRecoveryReport(root, CHECKOUT);
    assert.equal(afterLink[0].removable, false);
    const blocked = await pruneVerifiedStages(root, CHECKOUT, false);
    assert.deepEqual(blocked.removed, []);
    await lstat(replaced);
  });

  it('never traverses links inside a stale staging tree', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    await stale(ctx);
    const unrelated = join(root, 'other-files');
    await mkdir(unrelated);
    await writeFile(join(unrelated, 'keep.txt'), 'untouched');
    await symlink(unrelated, join(ctx.stage, 'redirect'), 'dir');
    await assert.rejects(pruneVerifiedStages(root, CHECKOUT, false), /Symlink/);
    assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'untouched');
    await lstat(ctx.stage);
  });

  it('refuses cleaning when a Docker container of this checkout is active', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    await stale(ctx);
    await assert.rejects(pruneVerifiedStages(root, CHECKOUT, true), /Active/);
    assert.equal(await pruneStaleRunLock(root, CHECKOUT, true), false);
    await lstat(ctx.stage);
  });

  it('removes only the stale journal record if a stage was already renamed away', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    await stale(ctx);
    const final = join(root, 'pinned-successful-bundle');
    await rename(ctx.stage, final);
    const outcome = await pruneVerifiedStages(root, CHECKOUT, false);
    assert.deepEqual(outcome.removed, [ctx.record.stageName]);
    await lstat(final);
    assert.equal(await pruneStaleRunLock(root, CHECKOUT, false), true);
  });

  it('retains unverified and recent journal records rather than guessing', async () => {
    const root = await fixture();
    const ctx = await beginPinnedStage(root, CHECKOUT);
    await stale(ctx, { checkout: ANOTHER });
    assert.deepEqual((await pruneVerifiedStages(root, CHECKOUT, false)).removed, []);
    await lstat(ctx.stage);
    assert.equal(await pruneStaleRunLock(root, CHECKOUT, false), false);
  });
});
