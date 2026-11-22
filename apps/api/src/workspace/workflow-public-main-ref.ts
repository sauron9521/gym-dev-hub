/**
 * Minimal credential-free, read-only fallback for GitHub's PUBLIC main ref.
 * GitHub REST may return 403 on a local Hub without GITHUB_TOKEN; that
 * must never turn an unknown CI check into a fake success.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAIN_REF = 'refs/heads/main';
const REMOTE = 'https://github.com/sauron9521/gym-dev-hub.git';
const EXPECTED = /^([a-f0-9]{40})\trefs\/heads\/main\n?$/;

/** Only exactly one full-length, lower-case main ref is trusted. */
export function parsePublicMainRef(output: unknown): string | null {
  if (typeof output !== 'string') return null;
  return EXPECTED.exec(output)?.[1] ?? null;
}

/**
 * No shell and no user-supplied URL/ref/arguments. No Git credential helper,
 * env tokens, interactive auth, local checkout modification or fetch.
 * Timeouts and any parsing failures remain UNKNOWN; never log stderr.
 */
export async function readPublicGitHubMainSha(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const result = await execFileAsync(
      'git',
      ['-c', 'credential.helper=', 'ls-remote', '--exit-code', REMOTE, MAIN_REF],
      {
        encoding: 'utf8',
        timeout: 7_000,
        maxBuffer: 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/false',
          GCM_INTERACTIVE: 'never',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
    );
    return parsePublicMainRef(result.stdout);
  } catch {
    // A public ref read is not proof of GitHub API/CI permissions.
    return null;
  }
}
