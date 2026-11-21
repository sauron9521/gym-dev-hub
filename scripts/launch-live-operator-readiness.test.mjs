import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseReadinessArgs,
  checkOperatorConfig,
  summarizeReadiness,
  checkPrivateAuditDir,
  storeVerified,
} from './launch-live-operator-readiness.mjs';

const SHA = 'a'.repeat(40);
const IMAGE = 'sha256:' + 'b'.repeat(64);
const OWNER = '/home/operator/gym-dev-hub';
const validEnv = () => ({
  DEV_HUB_ENABLE_PATCH_CHECKS: 'true',
  DEV_HUB_ENABLE_PATCH_REVIEW: 'true',
  DEV_HUB_ENABLE_PATCH_APPLY: 'true',
  DEV_HUB_ENABLE_PATCH_PREFLIGHT: 'true',
  DEV_HUB_ENABLE_SCOPED_CODE_READ: 'true',
  DEV_HUB_ENABLE_WORKTREE_MOUNT: 'true',
  DEV_HUB_PATCH_CHECK_OPERATOR_SECRET: 'alpha-'.repeat(8),
  DEV_HUB_PATCH_APPLY_OPERATOR_SECRET: 'bravo-'.repeat(8),
  DEV_HUB_WORKTREE_OPERATOR_SECRET: 'charlie-'.repeat(8),
  DEV_HUB_PATCH_CHECK_IMAGE_ID: IMAGE,
});
const HOST = { platform: 'linux', uid: 1000, node: '24.9.0' };

test('exact CLI requires separately pinned main and absolute operator checkout', () => {
  assert.deepEqual(parseReadinessArgs(['--expected-main=' + SHA, '--operator-checkout=' + OWNER]), {
    expected: SHA,
    checkout: OWNER,
  });
  for (const bad of [
    [],
    ['--expected-main=' + SHA],
    ['--operator-checkout=' + OWNER],
    ['--expected-main=' + SHA, '--operator-checkout=./somewhere'],
    ['--expected-main=' + SHA.toUpperCase(), '--operator-checkout=' + OWNER],
    ['--expected-main=' + 'f'.repeat(39), '--operator-checkout=' + OWNER],
    ['--expected-main=' + SHA, '--operator-checkout=/home/user/../gym-dev-hub'],
    ['--expected-main=' + SHA, '--operator-checkout=' + OWNER, '--grant'],
    ['--operator-checkout=' + OWNER, '--expected-main=' + SHA],
  ])
    assert.throws(() => parseReadinessArgs(bad));
});

test('disabled or non-Linux/root/old Node operator gates block without leaking env', () => {
  assert.deepEqual(checkOperatorConfig(validEnv(), HOST), []);
  for (const host of [
    { ...HOST, platform: 'win32' },
    { ...HOST, uid: 0 },
    { ...HOST, node: '22.19.0' },
  ])
    assert.ok(
      checkOperatorConfig(validEnv(), host).includes('unsupported-nonroot-linux-node-host'),
    );
  for (const key of [
    'DEV_HUB_ENABLE_PATCH_CHECKS',
    'DEV_HUB_ENABLE_PATCH_REVIEW',
    'DEV_HUB_ENABLE_PATCH_APPLY',
    'DEV_HUB_ENABLE_PATCH_PREFLIGHT',
    'DEV_HUB_ENABLE_SCOPED_CODE_READ',
    'DEV_HUB_ENABLE_WORKTREE_MOUNT',
  ]) {
    assert.ok(
      checkOperatorConfig({ ...validEnv(), [key]: 'false' }, HOST).includes(
        'required-feature-gate-disabled',
      ),
    );
  }
  const env = { ...validEnv(), DEV_HUB_PATCH_CHECK_OPERATOR_SECRET: 'short' };
  const text = JSON.stringify(checkOperatorConfig(env, HOST));
  assert.match(text, /operator-credential-missing-or-invalid/);
  assert.doesNotMatch(text, /short|alpha|bravo|charlie/);
});

test('independent strong operator credentials and pinned local Docker are mandatory', () => {
  const env = validEnv();
  assert.ok(
    checkOperatorConfig(
      {
        ...env,
        DEV_HUB_PATCH_APPLY_OPERATOR_SECRET: env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET,
      },
      HOST,
    ).includes('operator-credentials-not-independent'),
  );
  for (const change of [
    { DEV_HUB_PATCH_CHECK_IMAGE_ID: 'node:latest' },
    { DOCKER_HOST: 'tcp://localhost:2375' },
    { DOCKER_CONTEXT: 'remote' },
    { DOCKER_TLS_VERIFY: '1' },
    { DOCKER_CERT_PATH: '/home/user/.docker' },
  ])
    assert.notDeepEqual(checkOperatorConfig({ ...env, ...change }, HOST), []);
});

test('blocked state is redacted, stable, and never implies production authorization', () => {
  const reasons = ['pinned-store-lockfile-mismatch', 'operator-checkout-behind-pinned-main'];
  const report = summarizeReadiness([...reasons, reasons[0]], ['offline-source']);
  assert.deepEqual(report.reasons, [...reasons].sort());
  assert.equal(report.status, 'blocked');
  assert.equal(report.mayConsiderManualOwnerAuthorization, false);
  for (const key of [
    'productionGrantIssued',
    'dockerRecipeExecuted',
    'productionAuditWritten',
    'processRestarted',
    'anyMutationPerformed',
    'realOperatorRuntimeVersionVerified',
  ]) {
    assert.equal(report[key], false);
  }
  assert.equal(summarizeReadiness([], []).status, 'prerequisites-checked-only');
  assert.equal(summarizeReadiness([], []).productionGrantIssued, false);
});

test('audit directory inspection is read-only and rejects symlinks/open permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gym-preflight-audit-'));
  const alias = dir + '-alias';
  try {
    await chmod(dir, 0o700);
    assert.equal(await checkPrivateAuditDir(dir), true);
    assert.equal(await checkPrivateAuditDir(join(dir, 'missing')), false);
    await writeFile(join(dir, 'audit.jsonl'), '', { mode: 0o600 });
    assert.equal(await checkPrivateAuditDir(dir), true);
    await chmod(dir, 0o755);
    assert.equal(await checkPrivateAuditDir(dir), false);
    await chmod(dir, 0o700);
    await symlink(dir, alias);
    assert.equal(await checkPrivateAuditDir(alias), false);
    assert.equal(await checkPrivateAuditDir('./relative'), false);
  } finally {
    await rm(alias, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('wrong lockfile key is rejected before inspecting any private content', async () => {
  const result = await storeVerified('/tmp/' + 'c'.repeat(64), Buffer.from('public-lockfile'));
  assert.deepEqual(result, { reason: 'pinned-store-lockfile-mismatch' });
  assert.deepEqual(await storeVerified('not-absolute', Buffer.from('lock')), {
    reason: 'pinned-store-path-invalid',
  });
  const key = createHash('sha256').update('not-a-store').digest('hex');
  const matchingPath = '/tmp/' + key;
  assert.equal(
    (await storeVerified(matchingPath, Buffer.from('lock'))).reason,
    'pinned-store-lockfile-mismatch',
  );
});
