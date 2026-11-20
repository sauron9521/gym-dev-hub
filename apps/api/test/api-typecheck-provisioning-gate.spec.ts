import { describe, expect, it } from 'vitest';
import {
  PINNED_API,
  readImporterEntry,
  packageIntegrity,
  inspectTypecheckLayout,
} from '../../../scripts/api-typecheck-provisioning-gate.mjs';

const IMPORTER = [
  '    dependencies:',
  '      bcrypt:',
  '        specifier: ^6.0.0',
  '        version: 6.0.0',
  "      '@prisma/client':",
  '        specifier: ^7.10.1',
  '        version: 7.10.1(prisma@7.10.1)(typescript@6.0.3)',
  '    devDependencies:',
  '      typescript:',
  '        specifier: ^6.0.3',
  '        version: 6.0.3',
].join('\n');
const SRI = 'sha512-' + Buffer.alloc(64, 13).toString('base64');
const PACKAGES = [
  "lockfileVersion: '9.0'",
  '',
  'packages:',
  '',
  "  '@prisma/client@7.10.1':",
  '    resolution: {integrity: ' + SRI + '}',
  '',
  '  typescript@6.0.3:',
  '    resolution: {integrity: ' + SRI + '}',
  '',
  'snapshots:',
  '',
  '  typescript@6.0.3: {}',
].join('\n');

function config() {
  const root = { name: 'gym-platform', packageManager: 'pnpm@12.18.0' };
  const api = {
    name: '@gym/api',
    scripts: {
      typecheck: 'tsc --noEmit -p tsconfig.build.json',
      'db:generate': 'prisma generate --config prisma7.config.ts',
    },
  };
  const ts = {
    compilerOptions: {
      strict: true,
      module: 'nodenext',
      paths: { '#prisma/*': ['./src/infra/database/generated/prisma/*'] },
    },
  };
  const build = {
    extends: './tsconfig.json',
    compilerOptions: { rootDir: './src' },
    include: ['src'],
    exclude: ['node_modules', 'test', 'dist', '**/*spec.ts', 'src/generated/**'],
  };
  const prisma = "export default defineConfig({ schema: 'prisma/schemas/' });";
  const schema =
    'generator client {\n  provider = "prisma-client"\n  output = "../../src/infra/database/generated/prisma"\n}';
  return { root, api, ts, build, prisma, schema };
}

describe('real API_TYPECHECK dependency provisioning safety gate', () => {
  it('binds exactly eight reviewed Git source objects and never accepts caller argv', () => {
    expect(PINNED_API.repository).toBe('sauron9521/gym-platform');
    expect(PINNED_API.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(PINNED_API.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(PINNED_API.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(PINNED_API.blobs)).toHaveLength(8);
    for (const blob of Object.values(PINNED_API.blobs)) {
      expect(blob).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it('resolves exact importer specifier, pinned version and scoped package', () => {
    expect(readImporterEntry(IMPORTER, 'dependencies', 'bcrypt', '^6.0.0')).toBe('6.0.0');
    expect(readImporterEntry(IMPORTER, 'dependencies', '@prisma/client', '^7.10.1')).toBe('7.10.1');
    expect(readImporterEntry(IMPORTER, 'devDependencies', 'typescript', '^6.0.3')).toBe('6.0.3');
  });

  it('rejects absent, unapproved, duplicated or local/file/remote importer versions', () => {
    expect(() => readImporterEntry(IMPORTER, 'dependencies', 'bcrypt', '^7.0.0')).toThrow();
    expect(() => readImporterEntry(IMPORTER, 'dependencies', 'unknown', '^1.0.0')).toThrow();
    expect(() =>
      readImporterEntry(
        IMPORTER.replace('version: 6.0.0', 'version: link:../../pkg'),
        'dependencies',
        'bcrypt',
        '^6.0.0',
      ),
    ).toThrow('non-registry');
    expect(() =>
      readImporterEntry(
        IMPORTER.replace('version: 6.0.0', 'version: https://evil'),
        'dependencies',
        'bcrypt',
        '^6.0.0',
      ),
    ).toThrow('non-registry');
    expect(() =>
      readImporterEntry(
        IMPORTER.replace(
          '    devDependencies:',
          '      bcrypt:\n        specifier: ^6.0.0\n        version: 6.0.0\n    devDependencies:',
        ),
        'dependencies',
        'bcrypt',
        '^6.0.0',
      ),
    ).toThrow('duplicate');
  });

  it('verifies pinned SHA-512 without trusting a textual package name alone', () => {
    expect(packageIntegrity(PACKAGES, 'typescript', '6.0.3')).toBe(SRI);
    expect(packageIntegrity(PACKAGES, '@prisma/client', '7.10.1')).toBe(SRI);
    expect(() => packageIntegrity(PACKAGES, 'typescript', '6.0.4')).toThrow();
    expect(() =>
      packageIntegrity(PACKAGES.replace(SRI, 'sha1-malicious'), '@prisma/client', '7.10.1'),
    ).toThrow('SHA512');
  });

  it('requires exact reviewed tsconfig and Prisma generator before any future execution', () => {
    const c = config();
    expect(() =>
      inspectTypecheckLayout(c.root, c.api, c.ts, c.build, c.prisma, c.schema),
    ).not.toThrow();
    expect(() =>
      inspectTypecheckLayout(
        c.root,
        { ...c.api, scripts: { ...c.api.scripts, typecheck: 'sh -c malicious' } },
        c.ts,
        c.build,
        c.prisma,
        c.schema,
      ),
    ).toThrow('recipe');
    expect(() =>
      inspectTypecheckLayout(
        c.root,
        c.api,
        c.ts,
        { ...c.build, include: ['test'] },
        c.prisma,
        c.schema,
      ),
    ).toThrow('build scope');
    expect(() =>
      inspectTypecheckLayout(
        c.root,
        c.api,
        c.ts,
        c.build,
        c.prisma,
        c.schema.replace('prisma-client', 'prisma-client-js'),
      ),
    ).toThrow('generator');
    expect(() =>
      inspectTypecheckLayout(
        c.root,
        c.api,
        c.ts,
        c.build,
        c.prisma,
        c.schema.replace('generated/prisma', 'unsafe'),
      ),
    ).toThrow('output');
  });
});
