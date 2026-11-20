import { describe, expect, it } from 'vitest';
import {
  TARGET,
  auditLockText,
  auditWorkspaceText,
  gitBlobSha,
} from '../../../scripts/gym-platform-dependency-audit.mjs';

const PIN = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const DOC = (key: string) => `---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      fixture:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  ${key}:
    resolution: {integrity: ${PIN}}
    hasBin: true

snapshots:

  ${key}: {}
`;
const LOCK = DOC('fixture-one@1.0.0') + '\n' + DOC('fixture-two@1.0.0');
const WORKSPACE = `packages:
  - 'apps/*'

nodeLinker: hoisted

allowBuilds:
  '@prisma/engines': true
  prisma: true
  bcrypt: true
  esbuild: true
  '@swc/core': true
  '@parcel/watcher': false
  '@scarf/scarf': false

audit:
  ignore:
    - GHSA-fc5q-39xc-vjpf
`;

describe('Gym Platform static pinned dependency audit', () => {
  it('pins an immutable target commit and five Git blob identities', () => {
    expect(TARGET.repository).toBe('sauron9521/gym-platform');
    expect(TARGET.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(Object.keys(TARGET.blobs)).toHaveLength(5);
    for (const sha of Object.values(TARGET.blobs)) {
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('audits both independent YAML documents, counting SHA512 pins and binaries', () => {
    const result = auditLockText(LOCK);
    expect(result).toMatchObject({
      yamlDocuments: 2,
      packageCount: 2,
      sha512Pins: 2,
      documents: [
        { yamlDocument: 1, packageCount: 1, sha512Pins: 1, packagesWithBins: 1 },
        { yamlDocument: 2, packageCount: 1, sha512Pins: 1, packagesWithBins: 1 },
      ],
    });
  });

  it('fails closed if the second document or a single SHA512 pin is missing', () => {
    expect(() => auditLockText(DOC('single@1.0.0'))).toThrow('both pnpm 12');
    expect(() => auditLockText(LOCK.replace(PIN, 'sha1-unsafe'))).toThrow('non-SHA512');
    expect(() => auditLockText(LOCK.replace(PIN, 'sha512-' + 'A'.repeat(88)))).toThrow();
  });

  it('rejects custom archive sources, duplicate package entries and unsafe importer protocols', () => {
    expect(() =>
      auditLockText(
        LOCK.replace('resolution: {integrity: ' + PIN + '}', 'resolution: {tarball: https://bad}'),
      ),
    ).toThrow('non-SHA512');
    expect(() => auditLockText(DOC('duplicate@1.0.0') + '\n' + DOC('duplicate@1.0.0'))).toThrow(
      'Duplicate package',
    );
    expect(() =>
      auditLockText(LOCK.replace('version: 1.0.0', 'version: file:../../secret')),
    ).toThrow('Unsupported importer');
  });

  it('reports separately allowed and denied native-build hooks and the one existing advisory exception', () => {
    const result = auditWorkspaceText(WORKSPACE);
    expect(result.buildScriptsAllowed).toEqual([
      '@prisma/engines',
      '@swc/core',
      'bcrypt',
      'esbuild',
      'prisma',
    ]);
    expect(result.buildScriptsDenied).toEqual(['@parcel/watcher', '@scarf/scarf']);
    expect(result.auditAdvisoryExceptions).toEqual(['GHSA-fc5q-39xc-vjpf']);
    expect(result.scriptsActuallyExecuted).toBe(false);
  });

  it('rejects any new native build allowance, disabled denial or new advisory suppression', () => {
    expect(() => auditWorkspaceText(WORKSPACE.replace('bcrypt: true', 'bcrypt: false'))).toThrow(
      'build allowance',
    );
    expect(() => auditWorkspaceText(WORKSPACE.replace('audit:', '  evil: true\n\naudit:'))).toThrow(
      'Unexpected change',
    );
    expect(() =>
      auditWorkspaceText(WORKSPACE.replace('    - GHSA-fc5q-39xc-vjpf', '    - GHSA-new-risk')),
    ).toThrow('security audit suppression');
  });
});
