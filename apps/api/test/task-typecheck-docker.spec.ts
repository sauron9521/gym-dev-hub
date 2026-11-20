import { describe, expect, it } from 'vitest';
import {
  validateRunnerReceipt,
  validateRunnerMounts,
  validateRunnerIsolation,
  validateRunnerSecurity,
} from '../src/worktree/task-typecheck-docker.js';

const valid = {
  protocol: 1,
  event: 'pinned-api-typecheck-local-executed',
  recipe: 'API_TYPECHECK',
  sourceCommit: '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a',
  sourceTree: '2c140e1e740b3dd8cc7582db726f46b54b73b334',
  sourceManifestSha256: 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b',
  typescriptVersion: '6.0.3',
  prismaGenerated: true,
  apiTypecheckExecuted: true,
  typecheckExitCode: 0,
  sourceReadOnly: true,
  networkEnabled: false,
  dependencyLifecycleScriptsExecuted: false,
  delegatedAuthorization: 'host-service-only',
  operatorGrantConsumedInsideContainer: false,
  hostGrantVerificationInsideContainer: false,
  arbitraryCommandsEnabled: false,
  stdoutBytes: 12,
  stderrBytes: 0,
};

describe('pinned local Docker typecheck attestation', () => {
  it('accepts the fixed pinned non-network receipt only', () => {
    expect(validateRunnerReceipt(JSON.stringify(valid))).toEqual({
      stdoutBytes: 12,
      stderrBytes: 0,
    });
  });

  it.each([
    ['arbitrary command', { arbitraryCommandsEnabled: true }],
    ['unreviewed recipe', { recipe: 'API_TEST' }],
    ['forged source commit', { sourceCommit: 'a'.repeat(40) }],
    ['forged tree', { sourceTree: 'b'.repeat(40) }],
    ['forged manifest', { sourceManifestSha256: 'c'.repeat(64) }],
    ['nonzero compiler', { typecheckExitCode: 1 }],
    ['missing Prisma generation', { prismaGenerated: false }],
    ['remote network', { networkEnabled: true }],
    ['untrusted source write', { sourceReadOnly: false }],
    ['unexpected hook', { dependencyLifecycleScriptsExecuted: true }],
    [
      'claims host auth was checked inside container',
      { hostGrantVerificationInsideContainer: true },
    ],
    ['claims grant was consumed inside container', { operatorGrantConsumedInsideContainer: true }],
    ['missing delegation marker', { delegatedAuthorization: 'unverified' }],
    ['oversized output', { stdoutBytes: 1000000 }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateRunnerReceipt(JSON.stringify({ ...valid, ...patch }))).toThrow(
      'Unverified runner',
    );
  });

  it('rejects non-json or partial receipts', () => {
    expect(() => validateRunnerReceipt('not-json')).toThrow('Malformed');
    expect(() => validateRunnerReceipt('{}')).toThrow('Unverified');
  });

  it('requires four exact read-only mount identities', () => {
    const expected = [
      { source: '/tmp/test-source', target: '/source' },
      { source: '/tmp/test-manifest', target: '/manifest' },
      { source: '/tmp/test-store', target: '/store' },
      { source: '/tmp/test-engine', target: '/engine' },
    ];
    const mounted = expected.map((entry) => ({
      Type: 'bind',
      Source: entry.source,
      Destination: entry.target,
      RW: false,
    }));
    if (process.platform === 'win32') return; // Native Windows sources need Docker Desktop mappings.
    expect(() => validateRunnerMounts(JSON.stringify(mounted), expected)).not.toThrow();
    expect(() =>
      validateRunnerMounts(
        JSON.stringify([{ ...mounted[0], RW: true }, ...mounted.slice(1)]),
        expected,
      ),
    ).toThrow('Unexpected Docker bind');
    expect(() => validateRunnerMounts(JSON.stringify(mounted.slice(1)), expected)).toThrow(
      'mount count',
    );
    expect(() =>
      validateRunnerMounts(
        JSON.stringify([{ ...mounted[0], Source: '/another/path' }, ...mounted.slice(1)]),
        expected,
      ),
    ).toThrow('Unexpected Docker bind');
  });

  it('requires exactly the fixed Docker network, user and 5GiB resource policy', () => {
    const approved = 'none|true|65534:65534|false|none|128|5368709120|2000000000';
    expect(() => validateRunnerIsolation(approved)).not.toThrow();
    expect(() => validateRunnerIsolation(approved.replace('none|true', 'bridge|true'))).toThrow();
    expect(() => validateRunnerIsolation(approved.replace('5368709120', '0'))).toThrow();
  });

  it('requires dropped capabilities and only noexec scratch tmpfs volumes', () => {
    const approved =
      JSON.stringify(['ALL']) +
      '|' +
      JSON.stringify(['no-new-privileges:true']) +
      '|' +
      JSON.stringify({
        '/workspace': 'rw,nosuid,nodev,noexec,size=3072m,mode=1777',
        '/results': 'rw,nosuid,nodev,noexec,size=32m,mode=1777',
        '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777',
      });
    expect(() => validateRunnerSecurity(approved)).not.toThrow();
    expect(() => validateRunnerSecurity(approved.replace('noexec', 'exec'))).toThrow('Executable');
    expect(() => validateRunnerSecurity(approved.replace('ALL', 'NET_ADMIN'))).toThrow(
      'Unapproved',
    );
  });
});
