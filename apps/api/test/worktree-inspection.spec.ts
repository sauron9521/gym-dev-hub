import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { verifyLocalRepository } from '../src/worktree/worktree-plan.service.js';
import {
  inspectTreeListing,
  WorktreeInspectionService,
} from '../src/worktree/worktree-inspection.service.js';

function entry(path: string, mode = '100644', type = 'blob', size = '5') {
  return `${mode} ${type} ${'a'.repeat(40)} ${size}\t${path}\0`;
}

describe('Git tree safety validation', () => {
  it('accepts regular files and accounts for sizes', () => {
    expect(
      inspectTreeListing(entry('src/index.ts') + entry('README.md', '100755', 'blob', '12')),
    ).toEqual({ fileCount: 2, totalBytes: 17, violations: [] });
  });

  it.each([
    [entry('src/escape', '120000'), 'symlink'],
    [entry('nested/repo', '160000', 'commit', '-'), 'submodule'],
    [entry('.git/config'), 'компонент'],
    [entry('src/../secrets.txt'), 'компонент'],
    [entry('src/CON.txt'), 'компонент'],
    [entry('src/file:zone.txt'), 'компонент'],
    [entry('src/name.'), 'компонент'],
    [entry('src/\\evil.txt'), 'назва'],
    [entry('huge.dat', '100644', 'blob', String(21 * 1024 * 1024)), 'розміру'],
  ])('rejects dangerous entries without loading blob contents', (listing, reason) => {
    expect(inspectTreeListing(listing).violations.join(' ')).toContain(reason);
  });

  it('rejects case and Unicode conflicts on Windows', () => {
    expect(inspectTreeListing(entry('Readme.md') + entry('README.md')).violations).toContain(
      'Конфлікт шляхів у Git tree (регістр або Unicode).',
    );
    expect(inspectTreeListing(entry('A') + entry('a/file.txt')).violations).toContain(
      'Файл конфліктує з батьківською папкою.',
    );
  });

  it('fails closed on incomplete NUL output', () => {
    expect(inspectTreeListing(entry('README.md').slice(0, -1)).violations).toContain(
      'Неповний вивід Git tree.',
    );
  });
});

describe('read-only worktree recovery inspection (real Git fixture)', () => {
  let dir: string;
  let source: string;
  let target: string;
  let plan: WorktreePlan;
  let inspector: WorktreeInspectionService;

  function git(...args: string[]) {
    return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devhub-inspect-'));
    source = join(dir, 'repos', 'gym-platform');
    const worktreesRoot = join(dir, 'worktrees');
    await mkdir(source, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });
    execFileSync('git', ['init', '-q', source]);
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Dev Hub Fixture');
    git('remote', 'add', 'origin', 'https://github.com/sauron9521/gym-platform.git');
    await writeFile(join(source, 'proof.txt'), 'test fixture only\n');
    git('add', 'proof.txt');
    git('commit', '-qm', 'test commit');
    const id = '00000000-0000-4000-8000-000000000123';
    target = join(worktreesRoot, id);
    const proposedBranch = 'devhub/task-' + id.replaceAll('-', '');
    const head = git('rev-parse', 'HEAD');
    git('worktree', 'add', '--no-checkout', '-b', proposedBranch, '--', target, head);

    process.env.DEV_HUB_REPOS_ROOT = join(dir, 'repos');
    process.env.DEV_HUB_WORKTREES_ROOT = worktreesRoot;
    inspector = new WorktreeInspectionService();
    plan = {
      id,
      sessionId: '00000000-0000-4000-8000-000000000456',
      repository: 'sauron9521/gym-platform',
      sourcePath: source,
      targetPath: target,
      proposedBranch,
      baseHeadSha: head,
      fingerprint: 'sha256:' + 'f'.repeat(64),
      state: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      history: [],
      worktreeCreated: true,
      executionEnabled: false,
    };
  });

  afterEach(async () => {
    delete process.env.DEV_HUB_REPOS_ROOT;
    delete process.env.DEV_HUB_WORKTREES_ROOT;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('reports a verified metadata-only worktree as safe for a future hydration step', async () => {
    const resolvedRepository = await verifyLocalRepository(
      plan.repository,
      process.env.DEV_HUB_REPOS_ROOT!,
    );
    expect(resolvedRepository.toLowerCase()).toBe(source.toLowerCase());
    const before = await readdir(target);
    const result = await inspector.inspect(plan);
    expect(result.state, result.findings.join(' | ')).toBe('ready-for-hydration');
    expect(result).toMatchObject({
      state: 'ready-for-hydration',
      targetExists: true,
      metadataOnly: true,
      fileCount: 1,
      hydrationEnabled: false,
      recoveryIsReadOnly: true,
    });
    expect(await readdir(target)).toEqual(before);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('reports unknown files without deleting them', async () => {
    await writeFile(join(target, 'manual-notes.txt'), 'keep this');
    const result = await inspector.inspect(plan);
    expect(result.state).toBe('needs-review');
    expect(result.findings.join(' ')).toContain('вже є файли');
    expect(await readdir(target)).toContain('manual-notes.txt');
  });

  it('never interprets a failed or interrupted plan as ready', async () => {
    plan.state = 'failed';
    plan.worktreeCreated = false;
    const result = await inspector.inspect(plan);
    expect(result.state).toBe('needs-review');
    expect(result.findings.join(' ')).toContain('перервана');
  });

  it('fails closed on unexpected branch or commit', async () => {
    plan.baseHeadSha = 'b'.repeat(40);
    const result = await inspector.inspect(plan);
    expect(result.state).toBe('needs-review');
    expect(result.findings.join(' ')).toContain('не відповідає маніфесту');
  });
});
