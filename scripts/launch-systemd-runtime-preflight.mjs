/**
 * Read-only metadata gate for the actual installed systemd user operator.
 * A matching checkout HEAD and PID is NOT proof of the code loaded in a
 * running process. This gate never certifies E2E or authorizes writes.
 */
import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSupervisor } from './launch-owner-operator-shutdown.mjs';

const SHA = /^[a-f0-9]{40}$/;
const PID = /^[1-9][0-9]{0,9}$/;
const UNIT = 'gym-dev-hub-operator.service';
const GITHUB_MAIN_URL = 'https://github.com/sauron9521/gym-dev-hub.git';
const GITHUB_MAIN_REF = 'refs/heads/main';
const FIELDS = [
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'WorkingDirectory',
];
const ORIGINS = new Set([
  'git@github.com:sauron9521/gym-dev-hub.git',
  'https://github.com/sauron9521/gym-dev-hub.git',
]);

function canonical(value) {
  return (
    typeof value === 'string' &&
    value.length > 1 &&
    value.length < 1024 &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !/[\r\n\0]/.test(value) &&
    !value.includes('//') &&
    !value.includes('/./') &&
    !value.includes('/../')
  );
}

export function parseRuntimeArgs(argv) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--check-only' ||
    !argv[1].startsWith('--expected-main=') ||
    !argv[2].startsWith('--operator-checkout=')
  )
    throw new Error('Expected fixed read-only mode and externally pinned source');
  const expectedMain = argv[1].slice('--expected-main='.length);
  const checkout = argv[2].slice('--operator-checkout='.length);
  if (!SHA.test(expectedMain) || !canonical(checkout))
    throw new Error('Invalid source pin or checkout path');
  return { expectedMain, checkout };
}

/**
 * Read-only operator current-main gate: unlike --check-only, this mode pins
 * GitHub's live advertised main instead of trusting an old caller-supplied SHA.
 * Neither mode may issue grants, write Git refs, stop services or attest E2E.
 */
export function parseCurrentMainArgs(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== '--check-current-github-main' ||
    !argv[1].startsWith('--operator-checkout=')
  )
    throw new Error('Require exact read-only GitHub main mode and physical checkout');
  const checkout = argv[1].slice('--operator-checkout='.length);
  if (!canonical(checkout)) throw new Error('Invalid canonical operator checkout');
  return { checkout };
}

function advertisedGithubMain() {
  const proc = spawnSync(
    'git',
    ['-c', 'credential.helper=', 'ls-remote', '--exit-code', GITHUB_MAIN_URL, GITHUB_MAIN_REF],
    {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 2048,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false',
      },
    },
  );
  if (proc.error || proc.status !== 0)
    throw new Error('Fixed public GitHub main advertisement unavailable');
  const match = /^([a-f0-9]{40})\trefs\/heads\/main\n?$/.exec(proc.stdout);
  if (!match) throw new Error('Unexpected public GitHub main advertisement');
  return match[1];
}

/** Test-only injected dependencies; CLI always uses the fixed public repo. */
export async function inspectCurrentMainRuntime(
  { checkout },
  { currentMain = advertisedGithubMain, inspect = inspectInstalledRuntime } = {},
) {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !canonical(checkout))
    throw new Error('Nonroot Linux and canonical owner primary required');
  const expectedMain = await currentMain();
  if (!SHA.test(expectedMain)) throw new Error('Invalid advertised GitHub main SHA');
  const report = await inspect({ expectedMain, checkout });
  const secondMain = await currentMain();
  if (secondMain !== expectedMain) throw new Error('GitHub main moved while inspecting runtime');
  if (
    !report ||
    !['blocked', 'source-and-process-metadata-consistent'].includes(report.status) ||
    !Array.isArray(report.reasons) ||
    report.expectedMainSha !== expectedMain ||
    !SHA.test(report.ownerHeadSha ?? '') ||
    report.readOnly !== true ||
    report.endToEndVerified !== false
  )
    throw new Error('Untrusted runtime metadata; no golden authorization');

  const reasons = [...new Set(report.reasons)];
  if (report.ownerHeadSha !== expectedMain)
    reasons.push('owner-primary-behind-advertised-github-main');
  if (report.status !== 'source-and-process-metadata-consistent')
    reasons.push('installed-owner-runtime-metadata-unverified');
  const blocked = reasons.length > 0;
  return {
    status: blocked ? 'blocked' : 'current-main-runtime-metadata-consistent-only',
    reasons: [...new Set(reasons)].sort(),
    advertisedGitHubMainSha: expectedMain,
    ownerHeadSha: report.ownerHeadSha,
    liveSupervisorIdentityVerified: report.liveSupervisorIdentityVerified === true,
    checkedLiveGitHubMainTwice: true,
    mayConsiderSeparateOwnerGoldenAuthorization: !blocked,
    liveRuntimeVersionVerified: false,
    approvedForOperatorGrants: false,
    productionGrantIssued: false,
    dockerExecuted: false,
    productionAuditWritten: false,
    draftPrCreated: false,
    endToEndVerified: false,
    readOnly: true,
    systemdMutated: false,
    sourceMutated: false,
  };
}

export function parseUserUnitShow(output) {
  if (typeof output !== 'string' || output.length > 8192 || output.includes('\0'))
    throw new Error('Unbounded or invalid systemd response');
  const values = new Map();
  const lines = output.trimEnd().split('\n');
  if (lines.length !== FIELDS.length) throw new Error('Unexpected systemd property count');
  for (const line of lines) {
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (at < 1 || !FIELDS.includes(key) || values.has(key) || /[\r\n\0]/.test(value))
      throw new Error('Untrusted systemd properties');
    values.set(key, value);
  }
  if (
    values.size !== FIELDS.length ||
    values.get('Id') !== UNIT ||
    !PID.test(values.get('MainPID') ?? '') ||
    Number(values.get('MainPID')) <= 1 ||
    !canonical(values.get('WorkingDirectory'))
  )
    throw new Error('Unexpected service identity');
  return {
    id: values.get('Id'),
    load: values.get('LoadState'),
    active: values.get('ActiveState'),
    sub: values.get('SubState'),
    enabled: values.get('UnitFileState'),
    pid: Number(values.get('MainPID')),
    checkout: values.get('WorkingDirectory'),
  };
}

function systemctlReadOnly() {
  const result = spawnSync(
    '/usr/bin/systemctl',
    ['--user', 'show', UNIT, '--no-pager', '--property=' + FIELDS.join(',')],
    {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 8192,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Cannot inspect owner systemd user unit');
  return parseUserUnitShow(result.stdout);
}

function git(root, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 8192,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.error || result.status !== 0) throw new Error('Owner Git metadata unavailable');
  return result.stdout.trim();
}

async function checkoutHead(checkout) {
  const [root, admin, physical] = await Promise.all([
    lstat(checkout),
    lstat(join(checkout, '.git')),
    realpath(checkout),
  ]);
  if (
    physical !== checkout ||
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid() ||
    !admin.isDirectory() ||
    admin.isSymbolicLink() ||
    git(checkout, ['rev-parse', '--show-toplevel']) !== checkout ||
    git(checkout, ['symbolic-ref', '--short', 'HEAD']) !== 'main' ||
    !ORIGINS.has(git(checkout, ['remote', 'get-url', 'origin']))
  )
    throw new Error('Expected trusted physical owner primary main checkout');
  const sha = git(checkout, ['rev-parse', 'HEAD']);
  if (!SHA.test(sha)) throw new Error('Invalid owner source commit');
  return sha;
}

function sameUnit(a, b) {
  return FIELDS.every((field) => {
    const key = {
      Id: 'id',
      LoadState: 'load',
      ActiveState: 'active',
      SubState: 'sub',
      UnitFileState: 'enabled',
      MainPID: 'pid',
      WorkingDirectory: 'checkout',
    }[field];
    return a[key] === b[key];
  });
}

/** All injectable dependencies are for hermetic tests only. */
export async function inspectInstalledRuntime(
  { expectedMain, checkout },
  { readUnit = systemctlReadOnly, inspectProcess = inspectSupervisor } = {},
) {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Non-root Linux required');
  if (!SHA.test(expectedMain) || !canonical(checkout))
    throw new Error('Invalid pinned runtime request');

  const firstHead = await checkoutHead(checkout);
  const first = await readUnit();
  const reasons = [];
  if (firstHead !== expectedMain) reasons.push('owner-primary-behind-pinned-main');
  if (
    first.id !== UNIT ||
    first.load !== 'loaded' ||
    first.active !== 'active' ||
    first.sub !== 'running' ||
    first.enabled !== 'enabled'
  )
    reasons.push('user-unit-not-active-enabled');
  if (first.checkout !== checkout) reasons.push('user-unit-points-at-foreign-checkout');

  let startTicks = null;
  if (
    !reasons.includes('user-unit-not-active-enabled') &&
    !reasons.includes('user-unit-points-at-foreign-checkout')
  ) {
    try {
      const identity = await inspectProcess(checkout, first.pid);
      if (
        identity.status !== 'exact-operator-supervisor-verified' ||
        identity.processOwnerVerified !== true ||
        identity.scriptIdentityVerified !== true ||
        !/^[1-9][0-9]{0,19}$/.test(identity.startTicks ?? '')
      )
        throw new Error('Invalid operator process identity');
      startTicks = identity.startTicks;
    } catch {
      reasons.push('operator-process-identity-unverified');
    }
  }

  const second = await readUnit();
  const secondHead = await checkoutHead(checkout);
  if (!sameUnit(first, second)) reasons.push('user-unit-changed-during-inspection');
  if (firstHead !== secondHead) reasons.push('owner-head-changed-during-inspection');
  if (startTicks !== null && sameUnit(first, second)) {
    try {
      const verified = await inspectProcess(checkout, first.pid);
      if (
        verified.startTicks !== startTicks ||
        verified.status !== 'exact-operator-supervisor-verified' ||
        verified.processOwnerVerified !== true ||
        verified.scriptIdentityVerified !== true
      )
        throw new Error('Operator process changed during inspection');
    } catch {
      reasons.push('operator-process-changed-during-inspection');
    }
  }

  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    status: uniqueReasons.length ? 'blocked' : 'source-and-process-metadata-consistent',
    reasons: uniqueReasons,
    expectedMainSha: expectedMain,
    ownerHeadSha: secondHead,
    liveSupervisorIdentityVerified:
      startTicks !== null &&
      !uniqueReasons.includes('operator-process-changed-during-inspection') &&
      !uniqueReasons.includes('user-unit-changed-during-inspection'),
    liveRuntimeVersionVerified: false,
    approvedForOperatorGrants: false,
    endToEndVerified: false,
    readOnly: true,
    systemdMutated: false,
    sourceMutated: false,
    servicesRestarted: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const report =
    argv[0] === '--check-current-github-main'
      ? await inspectCurrentMainRuntime(parseCurrentMainArgs(argv))
      : await inspectInstalledRuntime(parseRuntimeArgs(argv));
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.status === 'blocked') process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('SYSTEMD_RUNTIME_PREFLIGHT_REJECTED; no mutation performed\n');
    process.exitCode = 2;
  });
}
