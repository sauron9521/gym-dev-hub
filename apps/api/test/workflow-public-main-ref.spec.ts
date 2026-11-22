import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublicGitHubMainSha } from '../src/workspace/workflow-public-main-ref.js';

const SHA = 'a'.repeat(40);
const originalPath = process.env.PATH;

describe('credential-free fixed public Git main fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function withFakeGit(script: string, run: () => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'hub-readonly-git-'));
    try {
      await writeFile(join(dir, 'git'), '#!/bin/sh\n' + script + '\n', { mode: 0o700 });
      await chmod(join(dir, 'git'), 0o700);
      vi.stubEnv('PATH', dir + ':' + (originalPath ?? '/usr/bin:/bin'));
      vi.stubEnv('GITHUB_TOKEN', 'TOP_SECRET_NOT_PASSED_TO_PUBLIC_GIT');
      vi.stubEnv('DEV_HUB_DRAFT_PR_TOKEN', 'OTHER_SECRET_NOT_PASSED');
      await run();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('uses only fixed URL/ref and clears credentials, never a shell or fetch', async () => {
    if (process.platform === 'win32') return;
    await withFakeGit(
      [
        'test "$#" -eq 6 || exit 10',
        'test "$1" = "-c" && test "$2" = "credential.helper=" || exit 11',
        'test "$3" = "ls-remote" && test "$4" = "--exit-code" || exit 12',
        'test "$5" = "https://github.com/sauron9521/gym-dev-hub.git" || exit 13',
        'test "$6" = "refs/heads/main" || exit 14',
        'test -z "$GITHUB_TOKEN" && test -z "$DEV_HUB_DRAFT_PR_TOKEN" || exit 15',
        'test "$GIT_TERMINAL_PROMPT" = "0" || exit 16',
        'test "$GIT_CONFIG_GLOBAL" = "/dev/null" || exit 17',
        "printf '%s\\trefs/heads/main\\n' " + SHA,
      ].join('\n'),
      async () => {
        await expect(readPublicGitHubMainSha()).resolves.toBe(SHA);
      },
    );
  });

  it('returns null on nonzero exit and never echoes command stderr', async () => {
    if (process.platform === 'win32') return;
    await withFakeGit('echo "SECRET_NOT_TO_LOG" >&2\nexit 34', async () => {
      await expect(readPublicGitHubMainSha()).resolves.toBeNull();
    });
  });

  it('returns null for more than one Git ref output line', async () => {
    if (process.platform === 'win32') return;
    await withFakeGit(
      "printf '%s\\trefs/heads/main\\n%s\\trefs/heads/main\\n' " + SHA + ' ' + SHA,
      async () => {
        await expect(readPublicGitHubMainSha()).resolves.toBeNull();
      },
    );
  });
});
