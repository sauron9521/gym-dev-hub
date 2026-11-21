import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeCommitCandidateService } from '../src/worktree/worktree-commit-candidate.service.js';
import { appendPatchCheckAudit } from '../src/worktree/worktree-patch-check-audit.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const GRANT = '00000000-0000-4000-8000-000000000777';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const COMMIT = 'a'.repeat(40);
const SOURCE = 'c'.repeat(64);
const PROPOSED = 'd'.repeat(64);
const FILE = 'apps/api/src/main.ts';
const REVIEW_SECRET = 'postapply-review-secret-abcdefghijklmnopqrstuvwxyz';
const SECRET = 'commit-candidate-independent-secret-abcdefghijklmnopqrstuvwxyz';
const DIFF = 'diff --git a/apps/api/src/main.ts b/apps/api/src/main.ts\n@@ -1 +1 @@\n-one\n+two\n';

describe('operator-reviewed read-only Git commit candidate', () => {
  let folder: string;
  let plans: { availableForMountProbe: ReturnType<typeof vi.fn> };
  let review: { review: ReturnType<typeof vi.fn> };
  let service: WorktreeCommitCandidateService;
  const request = () => ({
    grantId: GRANT,
    fingerprint: FINGERPRINT,
    sourceCommit: COMMIT,
    filePath: FILE,
    sourceSha256: SOURCE,
    proposedSha256: PROPOSED,
    commitSubject: 'fix(api): validate reviewed worktree change',
    reviewOperatorSecret: REVIEW_SECRET,
    operatorSecret: SECRET,
  });
  async function recordPassed(recipeId: 'API_TYPECHECK' | 'API_TEST', options = {}) {
    const checkGrant = {
      id: randomUUID(),
      sessionId: SESSION,
      planId: PLAN,
      sourceCommit: COMMIT,
      fingerprint: FINGERPRINT,
      filePath: FILE,
      sourceSha256: SOURCE,
      proposedSha256: PROPOSED,
      recipeId,
      ...options,
    };
    const runId = randomUUID();
    await appendPatchCheckAudit('issued', checkGrant);
    await appendPatchCheckAudit('attempted', checkGrant, runId);
    await appendPatchCheckAudit('passed', checkGrant, runId, {
      stdoutBytes: 42,
      stderrBytes: 0,
      containerRemoved: true,
      durationMs: 1000,
    });
  }
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'devhub-candidate-'));
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = join(folder, 'check-audit');
    process.env.DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW = 'true';
    process.env.DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET = SECRET;
    plans = {
      availableForMountProbe: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        fingerprint: FINGERPRINT,
        baseHeadSha: COMMIT,
      }),
    };
    review = {
      review: vi.fn().mockResolvedValue({
        status: 'verified',
        changedFiles: 1,
        sourceCommit: COMMIT,
        filePath: FILE,
        proposedSha256: PROPOSED,
        diff: DIFF,
        checkedAt: new Date().toISOString(),
      }),
    };
    service = new WorktreeCommitCandidateService(plans as never, review as never);
  });
  afterEach(async () => {
    for (const key of [
      'DEV_HUB_PATCH_CHECK_STATE_DIR',
      'DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW',
      'DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET',
    ])
      delete process.env[key];
    await rm(folder, { recursive: true, force: true });
  });

  it('refuses a candidate without matching successful fixed Docker checks', async () => {
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('Docker-перевірка');
    await recordPassed('API_TYPECHECK', { proposedSha256: 'e'.repeat(64) });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('Docker-перевірка');
  });

  it('previews exact Git diff, warns about missing recipe and separately acknowledges once', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    expect(candidate).toMatchObject({
      sessionId: SESSION,
      planId: PLAN,
      sourceCommit: COMMIT,
      filePath: FILE,
      proposedSha256: PROPOSED,
      diff: DIFF,
      commitSubject: request().commitSubject,
      status: 'review-required',
      verifiedRecipes: ['API_TYPECHECK'],
      missingRecipes: ['API_TEST'],
      readOnly: true,
      commitCreated: false,
      stagingEnabled: false,
      pushEnabled: false,
      mergeEnabled: false,
    });
    expect(candidate.candidateSha256).toMatch(/^[a-f0-9]{64}$/);
    const approval = {
      ...request(),
      candidateId: candidate.candidateId,
      candidateSha256: candidate.candidateSha256,
      confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
    };
    const confirmed = await service.acknowledge(SESSION, PLAN, approval);
    expect(confirmed).toMatchObject({
      candidateId: candidate.candidateId,
      status: 'operator-reviewed',
      previewOnly: true,
      commitCreated: false,
      stagingEnabled: false,
      pushEnabled: false,
      mergeEnabled: false,
    });
    expect(review.review).toHaveBeenCalledTimes(2);
    await expect(service.acknowledge(SESSION, PLAN, approval)).rejects.toThrow('вже підтверджений');
  });

  it('preserves only a short-lived, one-time human review proof for a separate Git grant', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    const proof = {
      ...request(),
      candidateId: candidate.candidateId,
      candidateSha256: candidate.candidateSha256,
      confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
    };
    await service.acknowledge(SESSION, PLAN, proof);
    const evidence = await service.takeReviewedForCommit(
      SESSION,
      PLAN,
      candidate.candidateId,
      candidate.candidateSha256,
      SECRET,
      REVIEW_SECRET,
    );
    expect(evidence).toMatchObject({
      candidateSha256: candidate.candidateSha256,
      request: {
        sourceCommit: COMMIT,
        proposedSha256: PROPOSED,
        filePath: FILE,
        commitSubject: request().commitSubject,
      },
    });
    await expect(
      service.takeReviewedForCommit(
        SESSION,
        PLAN,
        candidate.candidateId,
        candidate.candidateSha256,
        SECRET,
        REVIEW_SECRET,
      ),
    ).rejects.toThrow('відсутній');
  });

  it('rejects an unreviewed candidate, wrong SHA and changed diff at Git grant time', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    await expect(
      service.takeReviewedForCommit(
        SESSION,
        PLAN,
        candidate.candidateId,
        candidate.candidateSha256,
        SECRET,
        REVIEW_SECRET,
      ),
    ).rejects.toThrow('відсутній');
    const reviewed = await service.preview(SESSION, PLAN, request());
    await service.acknowledge(SESSION, PLAN, {
      ...request(),
      candidateId: reviewed.candidateId,
      candidateSha256: reviewed.candidateSha256,
      confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
    });
    await expect(
      service.takeReviewedForCommit(
        SESSION,
        PLAN,
        reviewed.candidateId,
        'f'.repeat(64),
        SECRET,
        REVIEW_SECRET,
      ),
    ).rejects.toThrow('змінився');
    const another = await service.preview(SESSION, PLAN, request());
    await service.acknowledge(SESSION, PLAN, {
      ...request(),
      candidateId: another.candidateId,
      candidateSha256: another.candidateSha256,
      confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
    });
    review.review.mockResolvedValueOnce({
      status: 'verified',
      changedFiles: 1,
      sourceCommit: COMMIT,
      filePath: FILE,
      proposedSha256: PROPOSED,
      diff: DIFF + '+not-reviewed\n',
    });
    await expect(
      service.takeReviewedForCommit(
        SESSION,
        PLAN,
        another.candidateId,
        another.candidateSha256,
        SECRET,
        REVIEW_SECRET,
      ),
    ).rejects.toThrow('Docker-докази змінилися');
  });

  it('reports both verified checks without running tests or Git writes', async () => {
    await recordPassed('API_TYPECHECK');
    await recordPassed('API_TEST');
    const preview = await service.preview(SESSION, PLAN, request());
    expect(preview.verifiedRecipes).toEqual(['API_TYPECHECK', 'API_TEST']);
    expect(preview.missingRecipes).toEqual([]);
    expect(review.review).toHaveBeenCalledWith(SESSION, PLAN, {
      grantId: GRANT,
      fingerprint: FINGERPRINT,
      sourceCommit: COMMIT,
      filePath: FILE,
      sourceSha256: SOURCE,
      proposedSha256: PROPOSED,
      operatorSecret: REVIEW_SECRET,
    });
  });

  it('denies off-scope repos, incorrect source SHA and changed HEAD', async () => {
    await recordPassed('API_TYPECHECK');
    plans.availableForMountProbe.mockResolvedValueOnce({
      repository: 'sauron9521/gym-platform',
      baseHeadSha: COMMIT,
      fingerprint: FINGERPRINT,
    });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('repo');
    plans.availableForMountProbe.mockResolvedValueOnce({
      repository: 'sauron9521/gym-dev-hub',
      baseHeadSha: 'f'.repeat(40),
      fingerprint: FINGERPRINT,
    });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('Git commit');
    await expect(
      service.preview(SESSION, PLAN, {
        ...request(),
        sourceSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow('Docker-перевірка');
  });

  it('refuses subject injection, extra arguments, stale opt-in and wrong secret', async () => {
    for (const bad of [
      { commitSubject: 'git commit -am test' },
      { commitSubject: 'fix(api): okay\n$(sh)' },
      { commitSubject: 'fix(api): okay', command: 'git commit' },
      { commitSubject: 'x'.repeat(73) },
    ]) {
      await expect(service.preview(SESSION, PLAN, { ...request(), ...bad })).rejects.toThrow(
        'Некоректний',
      );
    }
    delete process.env.DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW;
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW = 'true';
    await expect(
      service.preview(SESSION, PLAN, {
        ...request(),
        operatorSecret: 'x'.repeat(48),
      }),
    ).rejects.toThrow('секрет');
  });

  it('burns the acknowledgement on payload mismatch, wrong plan and replay', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    const approval = {
      ...request(),
      candidateId: candidate.candidateId,
      candidateSha256: candidate.candidateSha256,
      confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
    };
    await expect(
      service.acknowledge(SESSION, PLAN, {
        ...approval,
        commitSubject: 'fix(api): substitute approved subject',
      }),
    ).rejects.toThrow('Кандидат змінений');
    await expect(service.acknowledge(SESSION, PLAN, approval)).rejects.toThrow('вже підтверджений');
    const second = await service.preview(SESSION, PLAN, request());
    await expect(
      service.acknowledge(SESSION, randomUUID(), {
        ...approval,
        candidateId: second.candidateId,
        candidateSha256: second.candidateSha256,
      }),
    ).rejects.toThrow('Кандидат змінений');
  });

  it('fails closed if actual Git diff changes between preview and acknowledgement', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    review.review.mockResolvedValueOnce({
      status: 'verified',
      changedFiles: 1,
      filePath: FILE,
      sourceCommit: COMMIT,
      proposedSha256: PROPOSED,
      diff: DIFF + '\n+unapproved',
      checkedAt: new Date().toISOString(),
    });
    await expect(
      service.acknowledge(SESSION, PLAN, {
        ...request(),
        candidateId: candidate.candidateId,
        candidateSha256: candidate.candidateSha256,
        confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
      }),
    ).rejects.toThrow('змінився');
    expect(review.review).toHaveBeenCalledTimes(2);
  });

  it('fails closed when check coverage changes while candidate is awaiting review', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    await recordPassed('API_TEST');
    await expect(
      service.acknowledge(SESSION, PLAN, {
        ...request(),
        candidateId: candidate.candidateId,
        candidateSha256: candidate.candidateSha256,
        confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
      }),
    ).rejects.toThrow('змінився');
  });

  it('rejects acknowledgement without the exact independent human confirmation', async () => {
    await recordPassed('API_TYPECHECK');
    const candidate = await service.preview(SESSION, PLAN, request());
    await expect(
      service.acknowledge(SESSION, PLAN, {
        ...request(),
        candidateId: candidate.candidateId,
        candidateSha256: candidate.candidateSha256,
        confirmation: 'I_APPROVE_GIT_COMMIT',
      }),
    ).rejects.toThrow('Некоректне');
  });
});
