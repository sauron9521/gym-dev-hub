/**
 * Private host-side ownership journal for provisioning crash recovery.
 * Never put ownership records inside /bundle: the networked container may write
 * there. No agent/API endpoint can create or clean these records.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';

const PROTOCOL = 1;
const SCOPE = 'pinned-api-v1';
const ENTRY = /^stage-[A-Za-z0-9_-]{6}$/;
const LOCK = '.pinned-provision.lock';
const JOURNAL = '.stage-ledgers';
export const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 128;
const MAX_FILES = 90000;
const MAX_BYTES = 1900 * 1024 * 1024;

async function folder(path) {
  let cursor = resolve(path);
  let result;
  while (true) {
    const s = await lstat(cursor);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe staging ownership folder');
    if (cursor === resolve(path)) result = s;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return result;
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(a, b) {
  return a.dev === String(b.dev) && a.ino === String(b.ino);
}

export function isLivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function isOwned(record, name, now, checkout) {
  if (
    !record ||
    record.protocol !== PROTOCOL ||
    record.scope !== SCOPE ||
    record.checkout !== checkout ||
    record.stageName !== name ||
    !ENTRY.test(name) ||
    typeof record.runId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.runId) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !/^\d+$/.test(record.dev ?? '') ||
    !/^\d+$/.test(record.ino ?? '')
  )
    return false;
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) && now >= created && now - created >= STALE_MS;
}

async function readBoundedJson(path) {
  const meta = await lstat(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 2048 || meta.size < 30) {
    throw new Error('Unsafe private provisioning journal');
  }
  const data = await readFile(path, 'utf8');
  if (Buffer.byteLength(data) > 2048) throw new Error('Oversized provisioning journal');
  return { value: JSON.parse(data), stat: meta };
}

async function noLinksOrSpecialFiles(path, counts, depth = 0) {
  if (depth > 20) throw new Error('Staging tree nesting unsafe');
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    counts.dirs++;
    if (counts.dirs > MAX_FILES) throw new Error('Staging directory count exceeded');
    const names = await readdir(path);
    if (names.length > MAX_FILES) throw new Error('Staging directory too wide');
    for (const name of names) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe staging entry');
      }
      await noLinksOrSpecialFiles(join(path, name), counts, depth + 1);
    }
  } else if (info.isFile() && !info.isSymbolicLink()) {
    counts.files++;
    counts.bytes += info.size;
    if (counts.files > MAX_FILES || counts.bytes > MAX_BYTES) {
      throw new Error('Staging file count or bytes exceeded');
    }
  } else throw new Error('Symlink, junction, or special file in staging tree');
}

/** Called BEFORE chmod 0777 /bundle. Acquires a one-run lock. */
export async function beginPinnedStage(root, checkout) {
  await folder(root);
  const lock = join(root, LOCK);
  const id = randomUUID();
  const run = {
    protocol: PROTOCOL,
    scope: SCOPE,
    checkout,
    runId: id,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  // Atomic local single-flight: refuse parallel runs or old crash locks.
  await writeFile(lock, JSON.stringify(run) + '\n', { flag: 'wx', mode: 0o600 });
  let stage;
  try {
    const journalDir = join(root, JOURNAL);
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    await folder(journalDir);
    stage = await mkdtemp(join(root, 'stage-'));
    const stageName = basename(stage);
    if (!ENTRY.test(stageName)) throw new Error('Unexpected staging path');
    const record = { ...run, ...identity(await folder(stage)), stageName };
    const recordPath = join(journalDir, stageName + '.json');
    await writeFile(recordPath, JSON.stringify(record) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return { stage, root, checkout, run, recordPath, record };
  } catch (error) {
    let scratchRemoved = !stage;
    if (stage) {
      try {
        await rm(stage, { recursive: true, force: false });
        scratchRemoved = true;
      } catch {
        // Keep the run lock if scratch cleanup could not be proved.
      }
    }
    if (scratchRemoved) {
      const observed = await readBoundedJson(lock).catch(() => null);
      if (observed?.value?.runId === id) await rm(lock);
    }
    throw error;
  }
}

/** Never erase ownership evidence while a staging directory still exists. */
export async function finishPinnedStage(ctx) {
  const lock = join(ctx.root, LOCK);
  const seen = await readBoundedJson(ctx.recordPath);
  if (seen.value.runId !== ctx.run.runId || seen.value.stageName !== ctx.record.stageName) {
    throw new Error('Stage journal changed during provisioning');
  }
  try {
    await lstat(ctx.stage);
    throw new Error('Staging directory still exists; refusing journal removal');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rm(ctx.recordPath);
  const lockState = await readBoundedJson(lock);
  if (lockState.value.runId !== ctx.run.runId) throw new Error('Stage run lock was replaced');
  await rm(lock);
}

export async function stageRecoveryReport(root, checkout, now = Date.now()) {
  await folder(root);
  const journalDir = join(root, JOURNAL);
  let records = [];
  try {
    await folder(journalDir);
    records = (await readdir(journalDir)).sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (records.length > MAX_ENTRIES) throw new Error('Excessive staging ownership records');
  const entries = [];
  for (const file of records) {
    if (!ENTRY.test(file.replace(/\.json$/, '')) || !file.endsWith('.json')) {
      entries.push({ name: file, removable: false, reason: 'unexpected-ledger-file' });
      continue;
    }
    const name = file.slice(0, -5);
    const recordPath = join(journalDir, file);
    let record;
    try {
      record = (await readBoundedJson(recordPath)).value;
    } catch {
      entries.push({ name, removable: false, reason: 'corrupt-journal' });
      continue;
    }
    const owned = isOwned(record, name, now, checkout);
    const live = isLivePid(record.pid);
    let matched = false;
    let missing = false;
    try {
      matched = sameIdentity(record, await folder(join(root, name)));
    } catch (error) {
      missing = error?.code === 'ENOENT';
    }
    entries.push({
      name,
      removable: owned && !live && (matched || missing),
      recordOnly: missing,
      reason: !owned
        ? 'unverified-or-recent'
        : live
          ? 'process-still-alive'
          : matched
            ? 'verified-stale'
            : missing
              ? 'verified-missing-stage'
              : 'replaced-or-unsafe-stage',
    });
  }
  return entries;
}

/**
 * Explicit cleanup only; no directory is deleted for unlabeled or legacy stages.
 * Caller must prove Docker has no active provisioning container before invoking.
 */
export async function pruneVerifiedStages(root, checkout, hasActiveContainers, now = Date.now()) {
  if (hasActiveContainers)
    throw new Error('Active provisioning Docker containers: refusing stage cleanup');
  const candidates = await stageRecoveryReport(root, checkout, now);
  const removed = [];
  const skipped = [];
  for (const candidate of candidates) {
    if (!candidate.removable) {
      skipped.push(candidate);
      continue;
    }
    const path = join(root, candidate.name);
    const recordPath = join(root, JOURNAL, candidate.name + '.json');
    const record = (await readBoundedJson(recordPath)).value;
    if (!isOwned(record, candidate.name, Date.now(), checkout) || isLivePid(record.pid)) {
      skipped.push({ name: candidate.name, reason: 'changed-since-preview' });
      continue;
    }
    if (candidate.recordOnly) {
      try {
        await lstat(path);
        skipped.push({ name: candidate.name, reason: 'stage-reappeared' });
        continue;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rm(recordPath);
      removed.push(candidate.name);
      continue;
    }
    const current = await folder(path);
    if (!sameIdentity(record, current)) {
      skipped.push({ name: candidate.name, reason: 'stage-replaced' });
      continue;
    }
    await noLinksOrSpecialFiles(path, { files: 0, dirs: 0, bytes: 0 });
    // Recheck stage root after tree audit; delete only this verified private path.
    if (!sameIdentity(record, await folder(path))) {
      throw new Error('Staging path changed during cleanup');
    }
    await rm(path, { recursive: true, force: false });
    await rm(recordPath);
    removed.push(candidate.name);
  }
  return { removed, skipped };
}

/** Separate stale lock recovery is conservative and never breaks an active PID. */
export async function pruneStaleRunLock(root, checkout, hasActiveContainers, now = Date.now()) {
  if (hasActiveContainers) return false;
  const path = join(root, LOCK);
  let record;
  try {
    record = (await readBoundedJson(path)).value;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const created = Date.parse(record.createdAt);
  if (
    record.protocol !== PROTOCOL ||
    record.scope !== SCOPE ||
    record.checkout !== checkout ||
    typeof record.runId !== 'string' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isFinite(created) ||
    now - created < STALE_MS ||
    isLivePid(record.pid)
  )
    return false;
  // Do not unlock a run that still has any owned journal, including bad ones.
  const remaining = await readdir(join(root, JOURNAL)).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    return ['unknown'];
  });
  if (remaining.length > 0) return false;
  const again = (await readBoundedJson(path)).value;
  if (again.runId !== record.runId || isLivePid(again.pid)) return false;
  await rm(path);
  return true;
}
