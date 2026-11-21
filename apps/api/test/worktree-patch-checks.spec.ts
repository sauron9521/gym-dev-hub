import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorktreePatchChecksService } from '../src/worktree/worktree-patch-checks.service.js';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../src/worktree/worktree-patch-checks-docker.js', () => ({
  preparePatchCheckRunner: mocks.prepare,
  runPatchChecksDocker: mocks.execute,
}));

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const SOURCE_SHA = 'c'.repeat(64);
const AFTER_SHA = 'd'.repeat(64);
const SECRET = 'patch-check-independent-secret-abcdefghijklmnopqrstuvwxyz';
const REVIEW_SECRET = 'postapply-review-secret-abcdefghijklmnopqrstuvwxyz';

describe('operator-only post-apply Docker checks', () => {
  let base: string;
  let service: WorktreePatchChecksService;
  let plans: {
    availableForMountProbe: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  let review: { review: ReturnType<typeof vi.fn> };
  let boundary: { status: ReturnType<typeof vi.fn> };

  const fields = () => ({
    grantId: '00000000-0000-4000-8000-000000000777',
    fingerprint: FINGERPRINT,
    sourceCommit: COMMIT,
    filePath: 'apps/api/src/main.ts',
    sourceSha256: SOURCE_SHA,
    proposedSha256: AFTER_SHA,
    recipeId: 'API_TYPECHECK',
  });
  const authorize = () => ({
    ...fields(),
    confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
    reviewOperatorSecret: REVIEW_SECRET,
    operatorSecret: SECRET,
  });
  const execute = (token: string, runId = randomUUID()) => ({
    ...fields(),
    runId,
    grantToken: token,
    reviewOperatorSecret: REVIEW_SECRET,
    operatorSecret: SECRET,
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    base = await mkdtemp(join(tmpdir(), 'devhub-checks-'));
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = join(base, 'private');
    process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
    process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET = SECRET;
    plans = {
      list: vi.fn().mockResolvedValue([
        {
          id: PLAN,
          sessionId: SESSION,
          repository: 'sauron9521/gym-dev-hub',
        },
      ]),
      availableForMountProbe: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        fingerprint: FINGERPRINT,
        baseHeadSha: COMMIT,
        targetPath: join(base, 'trusted-worktree'),
      }),
    };
    review = {
      review: vi.fn().mockResolvedValue({
        status: 'verified',
        changedFiles: 1,
        sourceCommit: COMMIT,
        proposedSha256: AFTER_SHA,
        filePath: fields().filePath,
      }),
    };
    boundary = {
      status: vi.fn().mockImplementation(() => ({
        state: 'passed',
        checkedAt: new Date().toISOString(),
      })),
    };
    mocks.prepare.mockResolvedValue({
      imageId: 'sha256:' + 'a'.repeat(64),
      mounts: [{ source: '/source', target: '/source' }],
    });
    mocks.execute.mockResolvedValue({
      stdoutBytes: 12,
      stderrBytes: 0,
      stageFiles: 2,
      stageBytes: 500,
      containerRemoved: true,
    });
    service = new WorktreePatchChecksService(plans as never, review as never, boundary as never);
  });
  afterEach(async () => {
    for (const key of [
      'DEV_HUB_PATCH_CHECK_STATE_DIR',
      'DEV_HUB_ENABLE_PATCH_CHECKS',
      'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
    ])
      delete process.env[key];
    await rm(base, { recursive: true, force: true });
  });

  it('requires explicit consent, audits, issues one SHA-bound token, executes a fixed recipe and consumes it', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    expect(grant.purpose).toBe('AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK');
    expect(grant.recipeId).toBe('API_TYPECHECK');
    expect(grant.grantToken).toHaveLength(43);
    expect(review.review).toHaveBeenCalledWith(SESSION, PLAN, {
      grantId: fields().grantId,
      fingerprint: FINGERPRINT,
      sourceCommit: COMMIT,
      filePath: fields().filePath,
      sourceSha256: SOURCE_SHA,
      proposedSha256: AFTER_SHA,
      operatorSecret: REVIEW_SECRET,
    });
    const request = execute(grant.grantToken);
    const report = await service.execute(SESSION, PLAN, request);
    expect(report).toMatchObject({
      runId: request.runId,
      grantId: grant.grantId,
      recipeId: 'API_TYPECHECK',
      status: 'passed',
      readOnlySource: true,
      containerRemoved: true,
      networkEnabled: false,
      commitCreated: false,
      pushEnabled: false,
      mergeEnabled: false,
    });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.any(Object),
      'API_TYPECHECK',
      fields().filePath,
      AFTER_SHA,
      expect.any(AbortSignal),
    );
    expect(review.review).toHaveBeenCalledTimes(4);
    await expect(service.execute(SESSION, PLAN, request)).rejects.toThrow('використаний');
    const audit = await readFile(join(base, 'private', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"issued"');
    expect(audit).toContain('"event":"attempted"');
    expect(audit).toContain('"event":"passed"');
    expect(audit).not.toContain(grant.grantToken);
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toContain(REVIEW_SECRET);
  });

  it('fails closed when disabled, secret missing or wrong', async () => {
    delete process.env.DEV_HUB_ENABLE_PATCH_CHECKS;
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
    delete process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET;
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('секрет');
    process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET = SECRET;
    await expect(
      service.authorize(SESSION, PLAN, {
        ...authorize(),
        operatorSecret: 'x'.repeat(45),
      }),
    ).rejects.toThrow('секрет');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects stale Docker safety preflight', async () => {
    boundary.status.mockReturnValue({
      state: 'passed',
      checkedAt: new Date(Date.now() - 400_000).toISOString(),
    });
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('свіжий');
  });

  it('rejects running web recipe on API files and unsupported repository', async () => {
    await expect(
      service.authorize(SESSION, PLAN, {
        ...authorize(),
        recipeId: 'WEB_TEST',
      }),
    ).rejects.toThrow('Recipe');
    plans.availableForMountProbe.mockResolvedValue({
      repository: 'sauron9521/gym-platform',
      fingerprint: FINGERPRINT,
      baseHeadSha: COMMIT,
      targetPath: '/tmp/other',
    });
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('Gym Dev Hub');
  });

  it('refuses drift and failed audit before granting any token', async () => {
    review.review.mockRejectedValueOnce(new Error('postimage changed'));
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('postimage');
    await mkdir(join(base, 'private'), { recursive: true, mode: 0o700 });
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'external');
    await symlink(outside, join(base, 'private', 'audit.jsonl'));
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('audit');
  });

  it('burns tokens even for mismatched recipe, wrong plan and repeated attempts', async () => {
    const one = await service.authorize(SESSION, PLAN, authorize());
    await expect(
      service.execute(SESSION, PLAN, {
        ...execute(one.grantToken),
        recipeId: 'API_TEST',
      }),
    ).rejects.toThrow('недійсний');
    await expect(service.execute(SESSION, PLAN, execute(one.grantToken))).rejects.toThrow(
      'використаний',
    );
    const two = await service.authorize(SESSION, PLAN, authorize());
    await expect(
      service.execute('00000000-0000-4000-8000-000000000987', PLAN, execute(two.grantToken)),
    ).rejects.toThrow('недійсний');
    await expect(service.execute(SESSION, PLAN, execute(two.grantToken))).rejects.toThrow(
      'використаний',
    );
  });

  it('rejects omitted consent, unsupported args and unknown recipe', async () => {
    await expect(
      service.authorize(SESSION, PLAN, {
        ...fields(),
        operatorSecret: SECRET,
        reviewOperatorSecret: REVIEW_SECRET,
      }),
    ).rejects.toThrow('grant');
    await expect(
      service.authorize(SESSION, PLAN, {
        ...authorize(),
        recipeId: 'SHELL_EXEC',
      }),
    ).rejects.toThrow('grant');
    await expect(
      service.authorize(SESSION, PLAN, {
        ...authorize(),
        argv: ['sh', '-c', 'curl'],
      }),
    ).rejects.toThrow('grant');
  });

  it('rejects an expired one-time grant', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 46_000);
      await expect(service.execute(SESSION, PLAN, execute(grant.grantToken))).rejects.toThrow(
        'використаний',
      );
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires full post-apply revalidation before the Docker call', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    review.review.mockRejectedValueOnce(new Error('unexpected extra file'));
    await expect(service.execute(SESSION, PLAN, execute(grant.grantToken))).rejects.toThrow(
      'не пройшла',
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('fails closed on container errors and records rejection without replay', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    mocks.execute.mockRejectedValueOnce(new Error('network denied or timeout'));
    await expect(service.execute(SESSION, PLAN, execute(grant.grantToken))).rejects.toThrow(
      'не пройшла',
    );
    const audit = await readFile(join(base, 'private', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"rejected"');
    await expect(service.execute(SESSION, PLAN, execute(grant.grantToken))).rejects.toThrow(
      'використаний',
    );
  });

  it('requires the independent operator secret and only a known Gym Dev Hub plan for history', async () => {
    await expect(
      service.history(SESSION, PLAN, {
        operatorSecret: 'x'.repeat(40),
      }),
    ).rejects.toThrow('секрет');
    await expect(
      service.history(SESSION, PLAN, {
        operatorSecret: SECRET,
        other: true,
      }),
    ).rejects.toThrow('Некоректний');
    delete process.env.DEV_HUB_ENABLE_PATCH_CHECKS;
    await expect(
      service.history(SESSION, PLAN, {
        operatorSecret: SECRET,
      }),
    ).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
    plans.list.mockResolvedValue([]);
    await expect(
      service.history(SESSION, PLAN, {
        operatorSecret: SECRET,
      }),
    ).rejects.toThrow('Невідомий план');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('displays sanitized persisted results without rerunning Docker after restart', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    const request = execute(grant.grantToken);
    await service.execute(SESSION, PLAN, request);
    const before = await service.history(SESSION, PLAN, { operatorSecret: SECRET });
    expect(before).toMatchObject({
      total: 1,
      readOnly: true,
      rawLogsAvailable: false,
      commandsEnabled: false,
      items: [
        {
          status: 'passed',
          recipeId: 'API_TYPECHECK',
          runId: request.runId,
          stdoutBytes: 12,
          stderrBytes: 0,
          filePathSha256: expect.any(String),
        },
      ],
    });
    // New service instance has no in-memory grants or runs.
    const restarted = new WorktreePatchChecksService(
      plans as never,
      review as never,
      boundary as never,
    );
    const persisted = await restarted.history(SESSION, PLAN, { operatorSecret: SECRET });
    expect(persisted.items[0]).toMatchObject(before.items[0]!);
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
    expect(JSON.stringify(persisted)).not.toContain(REVIEW_SECRET);
    expect(JSON.stringify(persisted)).not.toContain(grant.grantToken);
    expect(JSON.stringify(persisted)).not.toContain(fields().filePath);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('prevents concurrent runs and allows explicit operator cancellation', async () => {
    const grant = await service.authorize(SESSION, PLAN, authorize());
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.execute.mockImplementationOnce(async (_prepared, _recipe, _file, _sha, signal) => {
      await pending;
      if (signal.aborted) throw new Error('aborted');
      return { stdoutBytes: 0, stderrBytes: 0, containerRemoved: true };
    });
    const request = execute(grant.grantToken);
    const running = service.execute(SESSION, PLAN, request);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    await expect(service.authorize(SESSION, PLAN, authorize())).rejects.toThrow('виконується');
    await expect(
      service.cancel(SESSION, PLAN, {
        runId: request.runId,
        operatorSecret: SECRET,
      }),
    ).resolves.toEqual({ runId: request.runId, status: 'cancel-requested' });
    const during = await service.history(SESSION, PLAN, { operatorSecret: SECRET });
    expect(during.items[0]?.status).toBe('cancel-requested');
    release();
    await expect(running).rejects.toThrow('не пройшла');
    const after = await service.history(SESSION, PLAN, { operatorSecret: SECRET });
    expect(after.items[0]?.status).toBe('canceled');
    const journal = await readFile(join(base, 'private', 'audit.jsonl'), 'utf8');
    expect(
      [...journal.matchAll(/"event":"(issued|attempted|cancel-requested|rejected)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['issued', 'attempted', 'cancel-requested', 'rejected']);
  });
});
