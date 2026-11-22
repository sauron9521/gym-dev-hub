import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseReceiptArgs,
  parseAuditRecords,
  verifyPassedReceipt,
  verifyOwnerReceipt,
} from './launch-verify-docker-receipt.mjs';

const MAIN = 'a'.repeat(40),
  ALT = 'b'.repeat(40),
  HASH = 'c'.repeat(64);
const SESSION = '10000000-0000-4000-8000-000000000001';
const PLAN = '10000000-0000-4000-8000-000000000002';
const GRANT = '10000000-0000-4000-8000-000000000003';
const RUN = '10000000-0000-4000-8000-000000000004';
const OTHER = '10000000-0000-4000-8000-000000000005';
const expected = {
  main: MAIN,
  sessionId: SESSION,
  planId: PLAN,
  grantId: GRANT,
  runId: RUN,
  recipeId: 'WEB_FORMAT',
};
const base = {
  grantId: GRANT,
  sessionId: SESSION,
  planId: PLAN,
  recipeId: 'WEB_FORMAT',
  fingerprint: 'sha256:' + HASH,
  sourceCommit: MAIN,
  sourceSha256: HASH,
  proposedSha256: 'd'.repeat(64),
  filePathSha256: 'e'.repeat(64),
};
const records = () => [
  { ...base, event: 'issued', at: '2026-11-22T10:00:00.000Z', runId: null },
  { ...base, event: 'attempted', at: '2026-11-22T10:00:01.000Z', runId: RUN },
  {
    ...base,
    event: 'passed',
    at: '2026-11-22T10:00:02.000Z',
    runId: RUN,
    durationMs: 1234,
    stdoutBytes: 42,
    stderrBytes: 0,
    containerRemoved: true,
  },
];
function args(root, overrides = {}) {
  const x = { ...expected, checkout: root, ...overrides };
  return [
    '--check-only',
    '--expected-main=' + x.main,
    '--operator-checkout=' + x.checkout,
    '--session-id=' + x.sessionId,
    '--plan-id=' + x.planId,
    '--grant-id=' + x.grantId,
    '--run-id=' + x.runId,
    '--recipe-id=' + x.recipeId,
  ];
}
function git(cwd, ...params) {
  const p = spawnSync('git', ['-C', cwd, ...params], {
    encoding: 'utf8',
    timeout: 12000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(p.status, 0);
  return p.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-receipt-owner-'));
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await writeFile(join(checkout, 'README.md'), 'fixture\n');
  git(checkout, 'add', 'README.md');
  git(checkout, 'commit', '-q', '-m', 'fixture');
  const main = git(checkout, 'rev-parse', 'HEAD'),
    parent = join(checkout, 'apps/api/.local');
  const dir = join(parent, 'patch-checks'),
    journal = join(dir, 'audit.jsonl');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await chmod(dir, 0o700);
  const bytes = Buffer.from(
    records()
      .map((r) => JSON.stringify({ ...r, sourceCommit: main }) + '\n')
      .join(''),
  );
  await writeFile(journal, bytes, { mode: 0o600 });
  await chmod(journal, 0o600);
  return {
    checkout,
    main,
    dir,
    journal,
    bytes,
    opts: { ...expected, checkout, main },
    cleanup: () => rm(checkout, { recursive: true, force: true }),
  };
}

test('strict read-only CLI refuses flags, foreign paths and forged IDs', () => {
  if (process.platform === 'win32') return;
  const x = args('/home/owner/Projects/hub');
  assert.deepEqual(parseReceiptArgs(x), { ...expected, checkout: '/home/owner/Projects/hub' });
  for (const a of [
    [],
    ['--apply'],
    [...x, '--write'],
    ['--confirm-run', ...x.slice(1)],
    args('./relative'),
    args('/tmp/../bad'),
    args('/tmp/space path'),
    args('/tmp/test', { main: 'wrong' }),
    args('/tmp/test', { grantId: 'not-a-uuid' }),
    args('/tmp/test', { runId: '../../etc/passwd' }),
    args('/tmp/test', { recipeId: 'ARBITRARY_SHELL' }),
  ])
    assert.throws(() => parseReceiptArgs(a));
});
test('full JSONL parser rejects truncated, oversized, malformed, unsafe or fake records', () => {
  const v = records();
  const b = Buffer.from(v.map((r) => JSON.stringify(r) + '\n').join(''));
  assert.deepEqual(parseAuditRecords(b), v);
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.from('not-json\n'),
    Buffer.from(JSON.stringify(v[0])),
    Buffer.from(JSON.stringify(v[0]) + '\r\n'),
    Buffer.from(JSON.stringify({ ...v[0], sourceCommit: '../../wrong' }) + '\n'),
    Buffer.from('{"event":"passed","secret":"must-not-expose"}\n'),
    Buffer.from('x'.repeat(1202) + '\n'),
    Buffer.alloc(1024 * 1024 + 1),
    Buffer.from([0xc3, 0x28, 10]),
  ])
    assert.throws(() => parseAuditRecords(invalid));
});
test('only exact issued/attempted/passed gives sanitized read-only non-E2E receipt', () => {
  const result = verifyPassedReceipt(records(), expected);
  assert.deepEqual(result, {
    status: 'verified-persisted-production-docker-receipt',
    sourceCommit: MAIN,
    sessionId: SESSION,
    planId: PLAN,
    grantId: GRANT,
    runId: RUN,
    recipeId: 'WEB_FORMAT',
    events: ['issued', 'attempted', 'passed'],
    containerRemoved: true,
    readOnly: true,
    dockerReexecuted: false,
    githubPrCreated: false,
    endToEndVerified: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /stdout|stderr|SECRET|Bearer|\/tmp/);
});
test('negative receipts fail closed on drift, replay, interruption, extra events and missing metrics', () => {
  const r = records();
  for (const invalid of [
    r.slice(0, 2),
    [r[0], r[2]],
    r.map((v, i) => (i === 2 ? { ...v, event: 'rejected' } : v)),
    r.map((v, i) => (i === 2 ? { ...v, containerRemoved: false } : v)),
    r.map((v, i) => (i === 2 ? { ...v, durationMs: -1 } : v)),
    r.map((v, i) => (i === 1 ? { ...v, fingerprint: 'sha256:' + 'f'.repeat(64) } : v)),
    r.map((v, i) => (i === 2 ? { ...v, sourceCommit: ALT } : v)),
    r.map((v, i) => (i === 2 ? { ...v, runId: OTHER } : v)),
    r.map((v) => ({ ...v, sourceCommit: ALT })),
    r.map((v) => ({ ...v, planId: OTHER })),
    r.map((v, i) => (i === 1 ? { ...v, at: '2026-11-22T09:59:59.000Z' } : v)),
    [...r, { ...r[2], at: '2026-11-22T10:00:03.000Z' }],
    [...r, { ...r[0], grantId: OTHER, runId: RUN }],
  ])
    assert.throws(() => verifyPassedReceipt(invalid, expected));
});
test('real disposable Git primary and 0600 journal are verified without mutations', async (t) => {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return t.skip('nonroot Linux only');
  const f = await fixture();
  try {
    const result = await verifyOwnerReceipt(f.opts);
    assert.equal(result.status, 'verified-persisted-production-docker-receipt');
    assert.equal(result.sourceCommit, f.main);
    assert.equal(result.journalSha256, createHash('sha256').update(f.bytes).digest('hex'));
    assert.equal(result.endToEndVerified, false);
    assert.deepEqual(await readFile(f.journal), f.bytes);
    assert.equal((await lstat(f.journal)).mode & 0o077, 0);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.main);
    assert.doesNotMatch(JSON.stringify(result), /\/tmp|private|token/);
  } finally {
    await f.cleanup();
  }
});
test('rejects stale main, foreign Git origin, world-readable journal and symlink', async (t) => {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return t.skip('nonroot Linux only');
  const f = await fixture();
  try {
    await assert.rejects(verifyOwnerReceipt({ ...f.opts, main: MAIN }));
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:foreign/owner.git');
    await assert.rejects(verifyOwnerReceipt(f.opts));
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
    await chmod(f.journal, 0o644);
    await assert.rejects(verifyOwnerReceipt(f.opts));
    await chmod(f.journal, 0o600);
    await rm(f.journal);
    await symlink(join(f.checkout, 'README.md'), f.journal);
    await assert.rejects(verifyOwnerReceipt(f.opts));
  } finally {
    await f.cleanup();
  }
});
