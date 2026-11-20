import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTypecheckService } from '../src/worktree/task-typecheck.service.js';
import {
  prepareTypecheckRunner,
  runPinnedTypecheckDocker,
} from '../src/worktree/task-typecheck-docker.js';

vi.mock('../src/worktree/task-typecheck-docker.js', () => ({
  prepareTypecheckRunner: vi.fn(),
  runPinnedTypecheckDocker: vi.fn(),
}));

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const RUN = '00000000-0000-4000-8000-000000000999';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const SECRET = 'operator-grant-secret-abcdefghijklmnopqrstuvwxyz';

const request = () => ({
  runId: RUN,
  grantToken: 'a'.repeat(43),
  recipeId: 'API_TYPECHECK',
  fingerprint: FINGERPRINT,
  sourceCommit: COMMIT,
  sourceTree: TREE,
  sourceManifestSha256: MANIFEST,
});
const boundary = { status: vi.fn() };
const grants = {
  consumeForExecution: vi.fn(),
  authenticateForCancellation: vi.fn(),
};

describe('operator-gated single-flight API_TYPECHECK route', () => {
  let service: TaskTypecheckService;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEV_HUB_ENABLE_TASK_EXECUTION = 'true';
    boundary.status.mockReturnValue({ state: 'passed', checkedAt: new Date().toISOString() });
    grants.consumeForExecution.mockResolvedValue({
      grantId: 'fixed-grant',
      recipeId: 'API_TYPECHECK',
    });
    vi.mocked(prepareTypecheckRunner).mockResolvedValue({
      imageId: 'sha256:' + 'a'.repeat(64),
      mounts: [],
    });
    vi.mocked(runPinnedTypecheckDocker).mockResolvedValue({
      stdoutBytes: 0,
      stderrBytes: 0,
      containerRemoved: true,
    });
    service = new TaskTypecheckService(grants as never, boundary as never);
  });

  afterEach(() => {
    delete process.env.DEV_HUB_ENABLE_TASK_EXECUTION;
    vi.restoreAllMocks();
  });

  it('runs only after fresh preflight and atomic grant consumption', async () => {
    const result = await service.execute(SESSION, PLAN, request());
    expect(result).toMatchObject({
      runId: RUN,
      grantId: 'fixed-grant',
      recipeId: 'API_TYPECHECK',
      sourceCommit: COMMIT,
      status: 'succeeded',
      exitCode: 0,
      containerRemoved: true,
      arbitraryCommandsEnabled: false,
    });
    expect(grants.consumeForExecution).toHaveBeenCalledWith(SESSION, PLAN, {
      grantToken: 'a'.repeat(43),
      recipeId: 'API_TYPECHECK',
      fingerprint: FINGERPRINT,
      sourceCommit: COMMIT,
      sourceManifestSha256: MANIFEST,
    });
    expect(prepareTypecheckRunner).toHaveBeenCalledOnce();
    expect(runPinnedTypecheckDocker).toHaveBeenCalledOnce();
  });

  it('is disabled by default and never burns tokens or starts Docker', async () => {
    delete process.env.DEV_HUB_ENABLE_TASK_EXECUTION;
    await expect(service.execute(SESSION, PLAN, request())).rejects.toThrow('вимкнене');
    expect(grants.consumeForExecution).not.toHaveBeenCalled();
    expect(prepareTypecheckRunner).not.toHaveBeenCalled();
  });

  it('rejects arbitrary commands, a forged commit, or a changed recipe', async () => {
    for (const invalid of [
      { ...request(), command: 'rm -rf /' },
      { ...request(), argv: ['sh', '-c', 'id'] },
      { ...request(), recipeId: 'API_TEST' },
      { ...request(), sourceCommit: 'f'.repeat(40) },
      { ...request(), sourceTree: 'd'.repeat(40) },
      { ...request(), fingerprint: 'not-a-sha' },
    ]) {
      await expect(service.execute(SESSION, PLAN, invalid)).rejects.toThrow('Недозволений');
    }
    expect(prepareTypecheckRunner).not.toHaveBeenCalled();
    expect(grants.consumeForExecution).not.toHaveBeenCalled();
  });

  it('requires recent Docker safety status before grant consumption', async () => {
    boundary.status.mockReturnValue({ state: 'passed', checkedAt: '2020-01-01T00:00:00Z' });
    await expect(service.execute(SESSION, PLAN, request())).rejects.toThrow('свіжий');
    expect(grants.consumeForExecution).not.toHaveBeenCalled();
  });

  it('rejects missing preprovisioned artifacts before burning the grant', async () => {
    vi.mocked(prepareTypecheckRunner).mockRejectedValueOnce(new Error('No pinned cache'));
    await expect(service.execute(SESSION, PLAN, request())).rejects.toThrow('відхилений');
    expect(grants.consumeForExecution).not.toHaveBeenCalled();
  });

  it('does not spawn Docker when the one-use grant fails verification', async () => {
    grants.consumeForExecution.mockRejectedValueOnce(new Error('replay'));
    await expect(service.execute(SESSION, PLAN, request())).rejects.toThrow('відхилений');
    expect(runPinnedTypecheckDocker).not.toHaveBeenCalled();
  });

  it('serializes concurrent tasks so a second request cannot run', async () => {
    let release: (() => void) | undefined;
    vi.mocked(runPinnedTypecheckDocker).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stdoutBytes: 0, stderrBytes: 0, containerRemoved: true });
        }),
    );
    const pending = service.execute(SESSION, PLAN, request());
    await vi.waitFor(() => expect(runPinnedTypecheckDocker).toHaveBeenCalledOnce());
    await expect(service.execute(SESSION, PLAN, request())).rejects.toThrow('вже виконується');
    release?.();
    await pending;
    expect(grants.consumeForExecution).toHaveBeenCalledTimes(1);
  });

  it('requires operator secret for cancellation and never claims cleanup synchronously', async () => {
    vi.mocked(runPinnedTypecheckDocker).mockImplementation(
      (_prepared, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
        }),
    );
    const pending = service.execute(SESSION, PLAN, request());
    await vi.waitFor(() => expect(runPinnedTypecheckDocker).toHaveBeenCalledOnce());
    expect(() =>
      service.cancel(SESSION, 'another-plan', { runId: RUN, operatorSecret: SECRET }),
    ).toThrow('Немає активного');
    const reply = service.cancel(SESSION, PLAN, { runId: RUN, operatorSecret: SECRET });
    expect(reply).toEqual({ runId: RUN, status: 'cancel-requested' });
    expect(grants.authenticateForCancellation).toHaveBeenCalledWith(SECRET);
    await expect(pending).rejects.toThrow('відхилений');
  });

  it('does not accept cancellation without an operator secret', () => {
    expect(() => service.cancel(SESSION, PLAN, { runId: RUN })).toThrow('Некоректний');
    expect(grants.authenticateForCancellation).not.toHaveBeenCalled();
  });
});
