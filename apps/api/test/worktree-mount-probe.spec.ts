import { describe, expect, it } from 'vitest';
import {
  mountedWorkerArguments,
  validateObservedMounts,
  equivalentMountSource,
  validateScopedCodePath,
} from '../src/worktree/worktree-mount-probe.js';

const ID = 'sha256:' + 'a'.repeat(64);
const NAME = 'gym-dev-hub-worker-00000000-0000-4000-8000-000000000111';
const SOURCE = process.platform === 'win32' ? 'C:\\worktrees\\approved' : '/tmp/worktrees/approved';

describe('immutable mounted worker CLI policy', () => {
  it('inherits all safety flags and inserts a single read-only mount before immutable image ID', () => {
    const args = mountedWorkerArguments(NAME, ID, SOURCE);
    const mount = args[args.indexOf('--mount') + 1];
    expect(mount).toBe(`type=bind,source=${SOURCE},target=/workspace,readonly`);
    expect(args[args.length - 1]).toBe(ID);
    expect(args).toEqual(
      expect.arrayContaining([
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--ipc=none',
        '--user=65534:65534',
        '--pull=never',
      ]),
    );
    expect(args.filter((item) => item === '--mount')).toHaveLength(1);
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it.each(['../danger', '/tmp/unsafe,other=true', '/tmp/unsafe\nmore', '/var/run/docker.sock'])(
    'rejects a noncanonical or unsafe path: %s',
    (path) => {
      expect(() => mountedWorkerArguments(NAME, ID, path)).toThrow();
    },
  );

  it('requires Docker to report only the exact approved read-only host mount', () => {
    const data = [{ Type: 'bind', Source: SOURCE, Target: '/workspace', ReadOnly: true }];
    expect(() => validateObservedMounts(JSON.stringify(data), SOURCE)).not.toThrow();
    expect(() =>
      validateObservedMounts(
        JSON.stringify([
          ...data,
          { Type: 'bind', Source: '/var/run/docker.sock', Target: '/sock', ReadOnly: false },
        ]),
        SOURCE,
      ),
    ).toThrow();
    expect(() =>
      validateObservedMounts(JSON.stringify([{ ...data[0], ReadOnly: false }]), SOURCE),
    ).toThrow();
    expect(() =>
      validateObservedMounts(JSON.stringify([{ ...data[0], Source: '/private' }]), SOURCE),
    ).toThrow();
    expect(() =>
      validateObservedMounts(JSON.stringify([{ ...data[0], Target: '/root' }]), SOURCE),
    ).toThrow();
    expect(() => validateObservedMounts('not-json', SOURCE)).toThrow();
  });
});

describe('scoped protocol path and actual Docker bind identity', () => {
  it.each(['src/main.ts', 'apps/web/page.tsx', 'README.md', 'package.json'])(
    'allows one plain source file: %s',
    (path) => expect(() => validateScopedCodePath(path)).not.toThrow(),
  );

  it.each(['../secret.ts', '/etc/passwd', '.env', '.git/config.json', 'src/../../secrets.ts', 'src//main.ts', 'src/file.ts;whoami', 'src/a.txt'])(
    'rejects traversal, hidden paths, commands and unsupported extensions: %s',
    (path) => expect(() => validateScopedCodePath(path)).toThrow(),
  );

  it('only accepts exact case-sensitive Linux bind sources', () => {
    expect(equivalentMountSource('/tmp/project', '/tmp/project', 'linux')).toBe(true);
    expect(equivalentMountSource('/TMP/project', '/tmp/project', 'linux')).toBe(false);
    expect(equivalentMountSource('/other/project', '/tmp/project', 'linux')).toBe(false);
  });

  it('understands only known Docker Desktop drive translations', () => {
    const windows = 'F:\\programer\\worktrees\\approved';
    expect(equivalentMountSource('F:\\programer\\worktrees\\approved', windows, 'win32')).toBe(true);
    expect(equivalentMountSource('/run/desktop/mnt/host/f/programer/worktrees/approved', windows, 'win32')).toBe(true);
    expect(equivalentMountSource('/host_mnt/f/programer/worktrees/approved', windows, 'win32')).toBe(true);
    expect(equivalentMountSource('/run/desktop/mnt/host/c/programer/worktrees/approved', windows, 'win32')).toBe(false);
    expect(equivalentMountSource('/run/desktop/mnt/host/f/programer/../approved', windows, 'win32')).toBe(false);
    expect(equivalentMountSource('/unknown/host/f/programer/worktrees/approved', windows, 'win32')).toBe(false);
    expect(equivalentMountSource('F:\\PROGRA~1\\worktrees\\approved', windows, 'win32')).toBe(false);
  });

  it('checks real Docker .Mounts and refuses writable or extra binds', () => {
    const effective = [{ Type: 'bind', Source: SOURCE, Destination: '/workspace', RW: false }];
    expect(() => validateObservedMounts(JSON.stringify(effective), SOURCE)).not.toThrow();
    expect(() => validateObservedMounts(JSON.stringify([{ ...effective[0], RW: true }]), SOURCE)).toThrow();
    expect(() => validateObservedMounts(JSON.stringify([...effective, effective[0]]), SOURCE)).toThrow();
    expect(() => validateObservedMounts(JSON.stringify([{ ...effective[0], Destination: '/tmp' }]), SOURCE)).toThrow();
  });
});
