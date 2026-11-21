import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeGitHubDraftPrService } from '../src/worktree/worktree-github-draft-pr.service.js';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  audit: vi.fn(),
  verifyRemote: vi.fn(),
  noPr: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../src/worktree/worktree-github-publisher.js', () => ({
  inspectLocalCommitForPush: mocks.inspect,
}));
vi.mock('../src/worktree/worktree-github-push-audit.js', () => ({
  auditedPublishedTaskBranch: mocks.audit,
}));
vi.mock('../src/worktree/worktree-github-draft-pr-api.js', () => ({
  verifyPublishedRemoteTask: mocks.verifyRemote,
  assertNoExistingTaskPr: mocks.noPr,
  createExactDraftPr: mocks.create,
}));

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const BRANCH = 'devhub/task-' + 'a'.repeat(32);
const COMMIT = 'b'.repeat(40);
const PARENT = 'c'.repeat(40);
const TITLE = 'fix(api): create one explicit draft pull request';
const SECRET = 'independent-draft-pr-secret-abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'github_draft_pr_credential_with_no_real_access_123456789';

describe('operator-authorized Draft PR service', () => {
  let root: string;
  let service: WorktreeGitHubDraftPrService;
  let plans: { availableForMountProbe: ReturnType<typeof vi.fn> };
  let readiness: { getReadiness: ReturnType<typeof vi.fn> };
  const authorize = () => ({
    commitSha: COMMIT,
    operatorSecret: SECRET,
    confirmation: 'I_AUTHORIZE_CREATE_ONE_DRAFT_PR_ONLY',
  });
  const execute = (grant: { grantId: string; grantToken: string }) => ({
    grantId: grant.grantId,
    grantToken: grant.grantToken,
    runId: randomUUID(),
    operatorSecret: SECRET,
    confirmation: 'I_CREATE_THIS_EXACT_GITHUB_DRAFT_PR',
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'devhub-draft-pr-'));
    process.env.DEV_HUB_COMMIT_STATE_DIR = join(root, 'audit');
    process.env.DEV_HUB_ENABLE_DRAFT_PR = 'true';
    process.env.DEV_HUB_DRAFT_PR_OPERATOR_SECRET = SECRET;
    process.env.DEV_HUB_DRAFT_PR_TOKEN = TOKEN;
    plans = {
      availableForMountProbe: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        proposedBranch: BRANCH,
        baseHeadSha: PARENT,
        targetPath: join(root, 'task'),
      }),
    };
    mocks.inspect.mockResolvedValue({
      branch: BRANCH,
      commitSha: COMMIT,
      parentSha: PARENT,
      subject: TITLE,
    });
    mocks.audit.mockResolvedValue({ parentSha: PARENT, runId: randomUUID() });
    mocks.verifyRemote.mockResolvedValue(undefined);
    mocks.noPr.mockResolvedValue(undefined);
    mocks.create.mockImplementation(async (task, _token, before, mark) => {
      await before();
      mark();
      return {
        number: 70,
        url: 'https://github.com/sauron9521/gym-dev-hub/pull/70',
        title: task.title,
        draft: true,
        headSha: COMMIT,
        headBranch: BRANCH,
        baseBranch: 'main',
      };
    });
    readiness = {
      getReadiness: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        number: 70,
        draft: true,
        headSha: COMMIT,
        baseBranch: 'main',
        checks: [],
        checksState: 'unknown',
        requiredState: 'unknown',
        verdict: 'unknown',
        unavailable: ['branch-protection'],
      }),
    };
    service = new WorktreeGitHubDraftPrService(plans as never, readiness as never);
  });
  afterEach(async () => {
    for (const key of [
      'DEV_HUB_COMMIT_STATE_DIR',
      'DEV_HUB_ENABLE_DRAFT_PR',
      'DEV_HUB_DRAFT_PR_OPERATOR_SECRET',
      'DEV_HUB_DRAFT_PR_TOKEN',
    ])
      delete process.env[key];
    await rm(root, { recursive: true, force: true });
  });

  it('uses separate secret, two manual actions, one grant and metadata-only audit', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    expect(grant).toMatchObject({
      branch: BRANCH,
      commitSha: COMMIT,
      title: TITLE,
      baseBranch: 'main',
      draft: true,
      purpose: 'CREATE_ONE_GITHUB_DRAFT_PR_ONLY',
      branchWriteEnabled: false,
      mergeEnabled: false,
    });
    expect(grant.grantToken).toHaveLength(43);
    expect(JSON.stringify(grant)).not.toContain(TOKEN);
    const request = execute(grant);
    const result = await service.execute(SESSION, PLAN, request);
    expect(result).toMatchObject({
      status: 'draft-created',
      number: 70,
      draft: true,
      branch: BRANCH,
      commitSha: COMMIT,
      baseBranch: 'main',
      branchWriteEnabled: false,
      mergeEnabled: false,
    });
    await expect(service.execute(SESSION, PLAN, request)).rejects.toThrow('використаний');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledTimes(3);
    const audit = await readFile(join(root, 'audit', 'github-draft-pr.jsonl'), 'utf8');
    expect([...audit.matchAll(/"event":"([a-z-]+)"/g)].map((x) => x[1])).toEqual([
      'issued',
      'attempted',
      'created',
    ]);
    expect(audit).toContain('"prNumber":70');
    for (const value of [TOKEN, SECRET, grant.grantToken, TITLE]) {
      expect(audit).not.toContain(value);
    }
    await expect(lstat(join(root, 'audit', PLAN + '.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires separate opt-in, independent secret and distinct Pull requests token', async () => {
    delete process.env.DEV_HUB_ENABLE_DRAFT_PR;
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_DRAFT_PR = 'true';
    await expect(
      service.authorize(SESSION, PLAN, {
        ...authorize(),
        operatorSecret: 'x'.repeat(40),
      }),
    ).rejects.toThrow('секрет');
    delete process.env.DEV_HUB_DRAFT_PR_TOKEN;
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('write');
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('cannot accept title, branch, base, merge flags, HTTP paths or arbitrary commands from browser', async () => {
    for (const invalid of [
      { title: 'evil' },
      { base: 'release' },
      { branch: 'main' },
      { merge: true },
      { draft: false },
      { remote: 'untrusted.invalid' },
      { confirmation: 'I_ALLOW_AUTOMERGE' },
    ]) {
      await expect(
        service.authorize(SESSION, PLAN, {
          ...authorize(),
          ...invalid,
        }),
      ).rejects.toThrow('Некоректний');
    }
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('denies missing published audit, a changed commit parent and an already existing PR', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('No confirmed task branch publication'));
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('No confirmed');
    mocks.audit.mockResolvedValueOnce({ parentSha: 'd'.repeat(40) });
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('audit');
    mocks.noPr.mockRejectedValueOnce(new Error('Draft PR already exists'));
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('already exists');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('burns capability before any await when session, grant ID or plan differs', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    await expect(service.execute(randomUUID(), PLAN, execute(grant))).rejects.toThrow('недійсний');
    await expect(service.execute(SESSION, PLAN, execute(grant))).rejects.toThrow('використаний');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses changed local SHA/title immediately before creating PR', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    mocks.inspect.mockResolvedValueOnce({
      branch: BRANCH,
      commitSha: COMMIT,
      parentSha: PARENT,
      subject: 'fix(api): changed title after authorization',
    });
    await expect(service.execute(SESSION, PLAN, execute(grant))).rejects.toThrow('змінилася');
    expect(mocks.create).not.toHaveBeenCalled();
    const audit = await readFile(join(root, 'audit', 'github-draft-pr.jsonl'), 'utf8');
    expect(audit).toContain('"event":"rejected"');
    await expect(lstat(join(root, 'audit', PLAN + '.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retains lock after ambiguous GitHub POST /pulls and never grants a retry', async () => {
    mocks.create.mockImplementationOnce(async (_task, _token, before, mark) => {
      await before();
      mark();
      throw Error('Lost network response from POST /pulls');
    });
    const grant = await service.authorize(SESSION, PLAN, authorize());
    const request = execute(grant);
    await expect(service.execute(SESSION, PLAN, request)).rejects.toThrow('міг бути створений');
    const lock = await lstat(join(root, 'audit', PLAN + '.lock'));
    expect(lock.isFile()).toBe(true);
    await expect(service.execute(SESSION, PLAN, request)).rejects.toThrow('використаний');
  });

  it('prevents concurrent draft PR creations for the same operator process', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.create.mockImplementationOnce(async (task, _token, before, mark) => {
      await before();
      await pending;
      mark();
      return {
        number: 70,
        url: 'https://github.com/sauron9521/gym-dev-hub/pull/70',
        title: task.title,
        draft: true,
        headSha: COMMIT,
        headBranch: BRANCH,
        baseBranch: 'main',
      };
    });
    const grant = await service.authorize(SESSION, PLAN, authorize());
    const running = service.execute(SESSION, PLAN, execute(grant));
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('уже виконується');
    release();
    await expect(running).resolves.toMatchObject({ status: 'draft-created' });
  });

  it('returns existing read-only CI evidence for this exact Draft PR, never merge authority', async () => {
    const result = await service.status(SESSION, PLAN, {
      prNumber: 70,
      commitSha: COMMIT,
    });
    expect(result).toMatchObject({
      number: 70,
      draft: true,
      headSha: COMMIT,
      verdict: 'unknown',
      checksState: 'unknown',
    });
    expect(readiness.getReadiness).toHaveBeenCalledWith('sauron9521/gym-dev-hub', '70');
    readiness.getReadiness.mockResolvedValueOnce({
      number: 70,
      draft: true,
      headSha: 'f'.repeat(40),
      baseBranch: 'main',
    });
    await expect(
      service.status(SESSION, PLAN, {
        prNumber: 70,
        commitSha: COMMIT,
      }),
    ).rejects.toThrow('не належить');
    await expect(
      service.status(SESSION, PLAN, {
        prNumber: 70,
        commitSha: COMMIT,
        merge: true,
      }),
    ).rejects.toThrow('Некоректний');
  });
});
