import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { WorktreeIntegrityReport, WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeInspectionService, inspectTreeListing } from './worktree-inspection.service.js';

const LIMIT_FILES = 5_000;
const LIMIT_TREE_BYTES = 100 * 1024 * 1024;
const KNOWN_NONEMPTY = 'У worktree вже є файли: потрібна ручна перевірка.';
const shaPattern = /^[0-9a-f]{40,64}$/;

type GitEntry = { name: string; oid: string; size: number };

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function gitTree(cwd: string, commit: string): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', [
      '--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=.devhub-disabled-hooks', '-C', cwd,
      'ls-tree', '-r', '-l', '-z', '--full-tree', commit,
    ], {
      shell: false, windowsHide: true, encoding: 'buffer',
      maxBuffer: 2 * 1024 * 1024, timeout: 12_000, env: gitEnv(),
    }, (error, output) => {
      if (error) reject(new Error('Git tree not available'));
      else resolveOutput(Buffer.isBuffer(output) ? output : Buffer.from(output));
    });
  });
}

/** Validate entries before ever addressing a target path. */
function parseTree(buffer: Buffer): GitEntry[] {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const validated = inspectTreeListing(decoded);
  if (validated.violations.length || validated.fileCount > LIMIT_FILES ||
      validated.totalBytes > LIMIT_TREE_BYTES) {
    throw new Error('Unsafe Git tree');
  }
  if (!decoded) return [];
  return decoded.split('\0').filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64}) +([0-9]+)\t(.+)$/s.exec(line);
    if (!match) throw new Error('Invalid Git record');
    return { name: match[4]!, oid: match[2]!, size: Number(match[3]) };
  });
}

/** Hash the actual file as an exact Git blob, without relying on Git filters/index. */
async function hashFile(path: string, size: number, oidLength: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== size) throw new Error('File size or type mismatch');
    const hash = createHash(oidLength === 64 ? 'sha256' : 'sha1');
    hash.update(Buffer.from(`blob ${size}\0`));
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let readTotal = 0;
    while (readTotal < size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - readTotal), null);
      if (bytesRead === 0) throw new Error('Unexpected end of file');
      hash.update(chunk.subarray(0, bytesRead));
      readTotal += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error('File changed during verification');
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

function readOnlyMount(path: string): WorktreeIntegrityReport['mount'] {
  return {
    sourcePath: path,
    targetPath: '/workspace',
    readOnly: true,
    networkEnabled: false,
    mountEnabled: false,
    executionEnabled: false,
  };
}

@Injectable()
export class WorktreeIntegrityService {
  constructor(
    private readonly plans: WorktreePlanService,
    private readonly inspection: WorktreeInspectionService,
  ) {}

  async verify(sessionId: string, planId: string): Promise<WorktreeIntegrityReport> {
    const plans = await this.plans.list(sessionId);
    const plan = plans.find((item) => item.id === planId);
    if (!plan) {
      // Use the existing strict ID / ownership semantics, never leak other sessions.
      await this.plans.getHydrationPlan(sessionId, planId);
      throw new Error('Plan not found');
    }
    return this.inspectPlan(plan);
  }

  async inspectPlan(plan: WorktreePlan): Promise<WorktreeIntegrityReport> {
    const failures: string[] = [];
    let fileCount = 0;
    let verifiedBytes = 0;
    const report = (status: WorktreeIntegrityReport['status']): WorktreeIntegrityReport => ({
      planId: plan.id,
      sessionId: plan.sessionId,
      status,
      fileCount,
      verifiedBytes,
      findings: [...new Set(failures)].slice(0, 8),
      checkedAt: new Date().toISOString(),
      mount: readOnlyMount(plan.targetPath),
    });

    if (plan.state !== 'created' || !plan.worktreeCreated ||
        plan.hydrationState !== 'completed' || !plan.baseHeadSha ||
        !shaPattern.test(plan.baseHeadSha)) {
      failures.push('Спочатку потрібне успішно завершене наповнення worktree.');
      return report('not-ready');
    }

    try {
      const initial = await this.inspection.inspect(plan);
      if (!initial.targetExists || initial.findings.some((finding) => finding !== KNOWN_NONEMPTY)) {
        failures.push('Git metadata, шляхи або вміст worktree не пройшли передперевірку.');
        return report('mismatch');
      }
      const tree = parseTree(await gitTree(plan.sourcePath, plan.baseHeadSha));
      const expected = new Map(tree.map((entry) => [entry.name, entry]));
      const expectedDirectories = new Set<string>();
      for (const entry of tree) {
        const parts = entry.name.split('/');
        for (let n = 1; n < parts.length; n++) {
          expectedDirectories.add(parts.slice(0, n).join('/'));
        }
      }

      const observed = new Set<string>();
      let traversed = 0;
      const visit = async (folder: string, prefix: string): Promise<void> => {
        for (const item of await readdir(folder)) {
          if (prefix === '' && item === '.git') continue;
          if (++traversed > LIMIT_FILES * 3) throw new Error('Too many filesystem entries');
          const relativeName = prefix ? `${prefix}/${item}` : item;
          const filePath = join(folder, item);
          const stat = await lstat(filePath);
          if (stat.isSymbolicLink()) throw new Error('Unexpected symlink or junction');
          if (stat.isDirectory()) {
            if (!expectedDirectories.has(relativeName)) throw new Error('Unknown directory');
            await visit(filePath, relativeName);
          } else if (stat.isFile()) {
            const entry = expected.get(relativeName);
            if (!entry || stat.size !== entry.size) throw new Error('Unknown or changed file');
            const actualOid = await hashFile(filePath, entry.size, entry.oid.length);
            if (actualOid !== entry.oid) throw new Error('File bytes differ from Git object');
            observed.add(relativeName);
            fileCount++;
            verifiedBytes += entry.size;
          } else {
            throw new Error('Unsupported filesystem object');
          }
        }
      };
      await visit(plan.targetPath, '');
      if (observed.size !== expected.size ||
          fileCount !== plan.hydrationFiles ||
          verifiedBytes !== plan.hydrationBytes) {
        throw new Error('Missing Git file or manifest counter mismatch');
      }
    } catch {
      failures.push('Файли або Git metadata змінилися, є зайві/відсутні об’єкти чи некоректні посилання.');
      return report('mismatch');
    }

    return report('verified');
  }
}
