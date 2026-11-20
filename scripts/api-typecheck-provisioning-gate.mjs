/**
 * CI-only read-only API_TYPECHECK dependency provisioning preflight.
 * No package installs, network, project scripts, Prisma generation or execution.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLockText, auditWorkspaceText, gitBlobSha } from './gym-platform-dependency-audit.mjs';

export const PINNED_API = Object.freeze({
  repository: 'sauron9521/gym-platform',
  commit: '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a',
  tree: '2c140e1e740b3dd8cc7582db726f46b54b73b334',
  manifestSha256: 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b',
  blobs: Object.freeze({
    'package.json': '4fa06500522abaa2fc809d022e3c4f74267a8d67',
    'pnpm-workspace.yaml': '0af4a0308ad0b25ea1813badb71b09b0256b6513',
    'pnpm-lock.yaml': '994456e853beaa556ab5a0d5ee3533b8f7db5682',
    'apps/api/package.json': '314142f3577c0620ff3402b7de3d25ef9702a5f4',
    'apps/api/tsconfig.json': 'a69209733af2d44113e5a51b77e811100353eaa9',
    'apps/api/tsconfig.build.json': '2ea0defb45be21c0048d1b65406fa27738624d81',
    'apps/api/prisma7.config.ts': '52b055e27d1a84edc5bb060a326ac355a724c729',
    'apps/api/prisma/schemas/schema.prisma': 'add9713fe6b2ce5a166c666aee3e255c0b0f5f06',
  }),
});
const REQUIRED = Object.freeze({
  typescript: '6.0.3',
  prisma: '7.10.1',
  '@prisma/client': '7.10.1',
  '@prisma/adapter-pg': '7.10.1',
  bcrypt: '6.0.0',
  sharp: '0.35.5',
  '@types/node': '26.6.6',
});

function requireSafe(ok, description) {
  if (!ok) throw new Error('API_TYPECHECK provisioning rejected: ' + description);
}

export function readImporterEntry(importer, group, name, specifier) {
  const lines = importer.split('\n');
  const start = lines.indexOf('    ' + group + ':');
  requireSafe(start >= 0, 'missing importer group ' + group);
  const groupLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^    \S/.test(lines[i]) || /^  \S/.test(lines[i])) break;
    groupLines.push(lines[i]);
  }
  const entry = '      ' + name + ':';
  const index = groupLines.indexOf(entry);
  requireSafe(index >= 0 && groupLines.indexOf(entry, index + 1) < 0, 'missing/duplicate API dependency ' + name);
  const s = /^        specifier: (.*)$/.exec(groupLines[index + 1] ?? '');
  const v = /^        version: (.*)$/.exec(groupLines[index + 2] ?? '');
  requireSafe(s !== null && v !== null && s[1] === specifier, 'unexpected specifier for ' + name);
  const match = /^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\(|$)/.exec(v[1]);
  requireSafe(match !== null, 'unresolved/non-registry package ' + name);
  return match[1];
}

export function packageIntegrity(document, name, version) {
  const key = name + '@' + version;
  const line = '  ' + (name.startsWith('@') ? "'" + key + "'" : key) + ':\n';
  requireSafe(document.split(line).length === 2, 'missing/duplicate resolved package ' + key);
  const start = document.indexOf(line) + line.length;
  const end = document.indexOf('\n  ', start);
  const section = document.slice(start, end < 0 ? undefined : end);
  const match = /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]{86}==)\}$/m.exec(section);
  requireSafe(match !== null, 'untrusted SHA512 for ' + key);
  return match[1];
}

export function inspectTypecheckLayout(root, api, ts, build, prismaConfig, schema) {
  requireSafe(root.name === 'gym-platform' && root.packageManager === 'pnpm@12.18.0', 'unknown package manager');
  requireSafe(api.name === '@gym/api' && api.scripts?.typecheck === 'tsc --noEmit -p tsconfig.build.json', 'unreviewed typecheck recipe');
  requireSafe(api.scripts?.['db:generate'] === 'prisma generate --config prisma7.config.ts', 'unreviewed Prisma generator');
  requireSafe(build.extends === './tsconfig.json', 'unreviewed build config');
  requireSafe(build.compilerOptions?.rootDir === './src' && JSON.stringify(build.include) === '["src"]', 'unreviewed build scope');
  requireSafe(Array.isArray(build.exclude) && build.exclude.includes('src/generated/**'), 'unreviewed build exclusions');
  requireSafe(ts.compilerOptions?.strict === true && ts.compilerOptions?.module === 'nodenext', 'unreviewed TS module policy');
  requireSafe(ts.compilerOptions?.paths?.['#prisma/*']?.[0] === './src/infra/database/generated/prisma/*', 'unreviewed generated Prisma import path');
  requireSafe(/generator client\s*\{[\s\S]*?provider\s*=\s*"prisma-client"/.test(schema), 'Prisma generator missing');
  requireSafe(/output\s*=\s*"\.\.\/\.\.\/src\/infra\/database\/generated\/prisma"/.test(schema), 'Prisma output changed');
  requireSafe(/schema:\s*'prisma\/schemas\/'/.test(prismaConfig), 'Prisma schema location changed');
}

export function inspectApiTypecheckProvisioning(files) {
  requireSafe(files !== null && typeof files === 'object' && !Array.isArray(files), 'missing reviewed files');
  for (const path of Object.keys(PINNED_API.blobs)) {
    requireSafe(typeof files[path] === 'string', 'missing pinned input: ' + path);
  }
  const root = JSON.parse(files['package.json']);
  const api = JSON.parse(files['apps/api/package.json']);
  const ts = JSON.parse(files['apps/api/tsconfig.json']);
  const build = JSON.parse(files['apps/api/tsconfig.build.json']);
  inspectTypecheckLayout(root, api, ts, build, files['apps/api/prisma7.config.ts'], files['apps/api/prisma/schemas/schema.prisma']);
  const workspaceReport = auditWorkspaceText(files['pnpm-workspace.yaml']);
  const lockText = files['pnpm-lock.yaml'];
  const lockReport = auditLockText(lockText);
  requireSafe(lockReport.yamlDocuments === 2 && lockReport.sha512Pins === 1631, 'full pinned lockfile drift');
  const docs = lockText.split('\n---\n');
  requireSafe(docs.length === 2, 'two pnpm 12 YAML documents required');
  const document = docs[1];
  const marker = '\n  apps/api:\n';
  const start = document.indexOf(marker);
  requireSafe(start >= 0, 'apps/api importer missing');
  const remaining = document.slice(start + marker.length);
  const next = remaining.search(/\n  [^\s][^\n]*:\n/);
  requireSafe(next > 0, 'apps/api importer boundary missing');
  const importer = remaining.slice(0, next);
  const resolutions = [];
  for (const group of ['dependencies', 'devDependencies']) {
    requireSafe(api[group] && typeof api[group] === 'object', 'missing package group');
    for (const [name, specifier] of Object.entries(api[group])) {
      requireSafe(typeof specifier === 'string', 'invalid requested package');
      const version = readImporterEntry(importer, group, name, specifier);
      resolutions.push({
        name,
        scope: group,
        requested: specifier,
        resolved: version,
        sha512: packageIntegrity(document, name, version),
      });
    }
  }
  requireSafe(resolutions.length >= 35 && resolutions.length < 80, 'API direct dependency graph drift');
  for (const [name, version] of Object.entries(REQUIRED)) {
    requireSafe(resolutions.some((item) => item.name === name && item.resolved === version), 'required package version drift: ' + name);
  }
  for (const nativeName of ['@prisma/engines', 'prisma', 'bcrypt']) {
    requireSafe(workspaceReport.buildScriptsAllowed.includes(nativeName), 'native build policy drift: ' + nativeName);
  }
  const engines = packageIntegrity(document, '@prisma/engines', '7.10.1');
  return {
    protocol: 1,
    event: 'api-typecheck-provisioning-gate',
    repository: PINNED_API.repository,
    sourceCommit: PINNED_API.commit,
    sourceTree: PINNED_API.tree,
    sourceManifestSha256: PINNED_API.manifestSha256,
    recipe: 'API_TYPECHECK',
    argv: ['pnpm', '--filter', '@gym/api', 'typecheck'],
    actualScript: api.scripts.typecheck,
    nodeLinker: 'hoisted',
    packageManager: root.packageManager,
    lockSha256: createHash('sha256').update(lockText).digest('hex'),
    lockSha512Pins: lockReport.sha512Pins,
    resolvedDirectCount: resolutions.length,
    directDependencies: Object.keys(api.dependencies).length,
    directDevDependencies: Object.keys(api.devDependencies).length,
    resolutions,
    prismaEngine: { version: '7.10.1', sha512: engines },
    nativeBuildAllowlistInSource: workspaceReport.buildScriptsAllowed,
    nativeBuildDenylistInSource: workspaceReport.buildScriptsDenied,
    generatedPrismaClient: 'apps/api/src/infra/database/generated/prisma',
    futureInstallArgv: ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
    missingPrerequisites: [
      'reviewed-full-offline-api-cache',
      'reviewed-native-build-and-prebuilt-binary-policy',
      'private-overlay-prisma-client-generation',
      'single-use-execution-grant-consumption',
    ],
    provisionReady: false,
    typecheckExecuted: false,
    installExecuted: false,
    nativeBuildsExecuted: false,
    prismaGeneratorExecuted: false,
    registryContacted: false,
    executionEnabled: false,
  };
}

async function readPinnedFile(root, path, sha) {
  let base = root;
  for (const part of path.split('/').slice(0, -1)) {
    base = join(base, part);
    const stat = await lstat(base);
    requireSafe(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe pinned path: ' + path);
  }
  const file = join(root, path);
  const stat = await lstat(file);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1500000, 'unsafe pinned file: ' + path);
  const bytes = await readFile(file);
  requireSafe(bytes.length === stat.size && gitBlobSha(bytes) === sha, 'pinned Git blob changed: ' + path);
  return bytes.toString('utf8');
}

export async function inspectPinnedApiCheckout(directory) {
  const root = resolve(directory);
  const stat = await lstat(root);
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe source root');
  const files = {};
  for (const [path, sha] of Object.entries(PINNED_API.blobs)) {
    files[path] = await readPinnedFile(root, path, sha);
  }
  return inspectApiTypecheckProvisioning(files);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '.audit/gym-platform') {
    throw new Error('Only the fixed CI-only source directory is accepted');
  }
  const result = await inspectPinnedApiCheckout(process.argv[2]);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write('API_TYPECHECK provisioning gate rejected: ' + (error instanceof Error ? error.message.slice(0, 450) : 'unknown') + '\n');
    process.exitCode = 1;
  });
}
