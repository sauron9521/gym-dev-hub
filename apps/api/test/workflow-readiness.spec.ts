import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateWorkflowEnvironment,
  WorkflowReadinessService,
} from '../src/workspace/workflow-readiness.service.js';
import { parsePublicMainRef } from '../src/workspace/workflow-public-main-ref.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SECRET = 'fake-secret-for-smoke-preflight-not-real-123';
const TOKEN = 'fake-token-for-smoke-preflight-not-real-123';

const flags = [
  'DEV_HUB_ENABLE_WORKTREE_CREATION',
  'DEV_HUB_ENABLE_WORKTREE_HYDRATION',
  'DEV_HUB_ENABLE_WORKTREE_MOUNT',
  'DEV_HUB_ENABLE_SCOPED_CODE_READ',
  'DEV_HUB_ENABLE_PATCH_PREFLIGHT',
  'DEV_HUB_ENABLE_PATCH_APPLY',
  'DEV_HUB_ENABLE_PATCH_REVIEW',
  'DEV_HUB_ENABLE_PATCH_CHECKS',
  'DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW',
  'DEV_HUB_ENABLE_GIT_COMMIT',
  'DEV_HUB_ENABLE_GITHUB_PUBLISH',
  'DEV_HUB_ENABLE_DRAFT_PR',
];
const operatorSecrets = [
  'DEV_HUB_WORKTREE_OPERATOR_SECRET',
  'DEV_HUB_PATCH_APPLY_OPERATOR_SECRET',
  'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
  'DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET',
  'DEV_HUB_GIT_COMMIT_OPERATOR_SECRET',
  'DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET',
  'DEV_HUB_DRAFT_PR_OPERATOR_SECRET',
];
const allConfigured: Record<string, string> = Object.fromEntries([
  ...flags.map((key) => [key, 'true']),
  ...operatorSecrets.map((key) => [key, SECRET]),
  ['DEV_HUB_GITHUB_PUBLISH_TOKEN', TOKEN],
  ['DEV_HUB_DRAFT_PR_TOKEN', TOKEN],
  ['DEV_HUB_COMMIT_AUTHOR_NAME', 'Local Test Operator'],
  ['DEV_HUB_COMMIT_AUTHOR_EMAIL', 'operator@example.invalid'],
]);

describe('read-only full-workflow smoke readiness', () => {
  let github: { request: ReturnType<typeof vi.fn> };
  let git: { headSha: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    github = { request: vi.fn().mockResolvedValue({ object: { sha: SHA } }) };
    git = { headSha: vi.fn().mockResolvedValue(SHA) };
  });
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed with all opt-in gates missing (no implicit defaults)', () => {
    const values = evaluateWorkflowEnvironment({}, false);
    expect(values).toHaveLength(9);
    expect(values.every((x) => x.state === 'blocked')).toBe(true);
    expect(values.find((x) => x.id === 'github-publish')?.missingKeys).toEqual(
      expect.arrayContaining([
        'DEV_HUB_ENABLE_GITHUB_PUBLISH',
        'DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET',
        'DEV_HUB_GITHUB_PUBLISH_TOKEN',
      ]),
    );
    expect(values.find((x) => x.id === 'local-commit')?.missingKeys).toContain(
      'DEV_HUB_COMMIT_AUTHOR_EMAIL',
    );
  });

  it('checks exact enable=true, minimum secret size, tokens and explicit Git author', () => {
    const invalid = {
      ...allConfigured,
      DEV_HUB_ENABLE_GITHUB_PUBLISH: '1',
      DEV_HUB_PATCH_CHECK_OPERATOR_SECRET: 'x'.repeat(31),
      DEV_HUB_DRAFT_PR_TOKEN: 'contains whitespace should be rejected',
    };
    const values = evaluateWorkflowEnvironment(invalid, false);
    expect(values.find((x) => x.id === 'github-publish')?.missingKeys).toContain(
      'DEV_HUB_ENABLE_GITHUB_PUBLISH',
    );
    expect(values.find((x) => x.id === 'docker-check')?.missingKeys).toContain(
      'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
    );
    expect(values.find((x) => x.id === 'draft-pr')?.missingKeys).toContain(
      'DEV_HUB_DRAFT_PR_TOKEN',
    );
    expect(values.find((x) => x.id === 'local-commit')?.missingKeys).toContain(
      'DEV_HUB_COMMIT_AUTHOR_NAME',
    );
  });

  it('returns only environment KEY names; never token values or secret fragments', () => {
    const environment = { ...allConfigured, DEV_HUB_ENABLE_DRAFT_PR: 'false' };
    const values = evaluateWorkflowEnvironment(environment, true);
    expect(values.find((x) => x.id === 'draft-pr')?.missingKeys).toEqual([
      'DEV_HUB_ENABLE_DRAFT_PR',
    ]);
    const json = JSON.stringify(values);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('operator@example.invalid');
    expect(json).toContain('DEV_HUB_ENABLE_DRAFT_PR');
  });

  it('reports configured preconditions but never claims real E2E, Docker or GitHub permission success', async () => {
    for (const [key, value] of Object.entries(allConfigured)) vi.stubEnv(key, value);
    const service = new WorkflowReadinessService(github as never, git as never);
    const result = await service.report();
    expect(result).toMatchObject({
      repository: 'sauron9521/gym-dev-hub',
      configuredCount: 11,
      totalCount: 11,
      preconditionsSatisfied: true,
      readOnly: true,
      writesPerformed: false,
      mutatingCommandsExecuted: false,
      githubPermissionsVerified: false,
      dockerExecutionVerified: false,
      endToEndVerified: false,
      source: { state: 'configured', localHeadSha: SHA, githubMainSha: SHA },
    });
    expect(github.request).toHaveBeenCalledExactlyOnceWith(
      '/repos/sauron9521/gym-dev-hub/git/ref/heads/main',
    );
    expect(git.headSha).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('blocks stale local HEAD and does not mutate or fetch Git branches', async () => {
    for (const [key, value] of Object.entries(allConfigured)) vi.stubEnv(key, value);
    git.headSha.mockResolvedValue(OTHER);
    const service = new WorkflowReadinessService(github as never, git as never);
    const result = await service.report();
    expect(result.preconditionsSatisfied).toBe(false);
    expect(result.source).toEqual({
      localHeadSha: OTHER,
      githubMainSha: SHA,
      state: 'blocked',
    });
    expect(result.gates.find((x) => x.id === 'source')?.note).toContain('відстає');
    expect(git.headSha).toHaveBeenCalledTimes(1);
  });

  it('treats unavailable GitHub as UNKNOWN, never success', async () => {
    for (const [key, value] of Object.entries(allConfigured)) vi.stubEnv(key, value);
    github.request.mockRejectedValueOnce(new Error('403 with credential details'));
    const service = new WorkflowReadinessService(github as never, git as never);
    const publicHead = vi.spyOn(service, 'readPublicMainHead').mockResolvedValue(null);
    const result = await service.report();
    expect(publicHead).toHaveBeenCalledExactlyOnceWith();
    expect(result.source).toMatchObject({ state: 'unknown', githubMainSha: null });
    expect(result.preconditionsSatisfied).toBe(false);
    expect(result.gates.find((x) => x.id === 'ci')?.state).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('credential details');
  });

  it('recovers public main source SHA from credential-free git when GitHub REST is 403, not CI', async () => {
    for (const [key, value] of Object.entries(allConfigured)) vi.stubEnv(key, value);
    github.request.mockRejectedValueOnce(new Error('403 and private details must not leak'));
    const service = new WorkflowReadinessService(github as never, git as never);
    const publicHead = vi.spyOn(service, 'readPublicMainHead').mockResolvedValue(SHA);
    const result = await service.report();
    expect(publicHead).toHaveBeenCalledOnce();
    expect(result.source).toEqual({
      localHeadSha: SHA,
      githubMainSha: SHA,
      state: 'configured',
    });
    expect(result.gates.find((x) => x.id === 'source')?.note).toContain('read-only');
    expect(result.gates.find((x) => x.id === 'ci')?.state).toBe('unknown');
    expect(result.configuredCount).toBe(10);
    expect(result.totalCount).toBe(11);
    expect(result.preconditionsSatisfied).toBe(false);
    expect(result.githubPermissionsVerified).toBe(false);
    expect(result.dockerExecutionVerified).toBe(false);
    expect(result.endToEndVerified).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private details');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('blocks a stale main even when recovered from public Git ref; CI remains unknown', async () => {
    github.request.mockRejectedValueOnce(new Error('HTTP 403'));
    const service = new WorkflowReadinessService(github as never, git as never);
    vi.spyOn(service, 'readPublicMainHead').mockResolvedValue(OTHER);
    const result = await service.report();
    expect(result.source).toEqual({ localHeadSha: SHA, githubMainSha: OTHER, state: 'blocked' });
    expect(result.gates.find((x) => x.id === 'ci')?.state).toBe('unknown');
    expect(result.preconditionsSatisfied).toBe(false);
  });

  it('treats malformed public fallback or missing local HEAD as blocked/unknown', async () => {
    github.request.mockRejectedValue(new Error('GitHub API not available'));
    const service = new WorkflowReadinessService(github as never, git as never);
    const publicHead = vi.spyOn(service, 'readPublicMainHead').mockResolvedValue('bad-sha');
    const first = await service.report();
    expect(first.source).toMatchObject({ state: 'unknown', githubMainSha: null });
    publicHead.mockResolvedValue(SHA);
    git.headSha.mockRejectedValueOnce(new Error('private local worktree path'));
    const second = await service.report();
    expect(second.source).toMatchObject({
      state: 'blocked',
      githubMainSha: SHA,
      localHeadSha: null,
    });
    expect(JSON.stringify(second)).not.toContain('private local worktree path');
  });

  it('does not run fallback on a well-formed authoritative GitHub REST main SHA', async () => {
    const service = new WorkflowReadinessService(github as never, git as never);
    const publicHead = vi
      .spyOn(service, 'readPublicMainHead')
      .mockRejectedValue(new Error('should not run'));
    const result = await service.report();
    expect(publicHead).not.toHaveBeenCalled();
    expect(result.source.state).toBe('configured');
    expect(result.gates.find((x) => x.id === 'ci')?.state).toBe('configured');
  });

  it('blocks missing/invalid local repo and never exposes filesystem paths', async () => {
    git.headSha.mockRejectedValue(new Error('/home/private/secret-repo'));
    const service = new WorkflowReadinessService(github as never, git as never);
    const result = await service.report();
    expect(result.source.localHeadSha).toBeNull();
    expect(result.source.state).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('/home/private');
  });
});

describe('fixed public main Git ref parser', () => {
  it('trusts only one exact lowercase GitHub main SHA + ref', () => {
    expect(parsePublicMainRef(SHA + '\trefs/heads/main\n')).toBe(SHA);
    expect(parsePublicMainRef(SHA + '\trefs/heads/main')).toBe(SHA);
    for (const output of [
      null,
      undefined,
      123,
      '',
      'malformed',
      SHA.toUpperCase() + '\trefs/heads/main\n',
      SHA + '\trefs/heads/feature\n',
      SHA + '\trefs/heads/main\n' + OTHER + '\trefs/heads/main\n',
      SHA + ' refs/heads/main\n',
      SHA + '\trefs/heads/main\nextra',
      'TOKEN=' + TOKEN,
    ])
      expect(parsePublicMainRef(output)).toBeNull();
  });
});
