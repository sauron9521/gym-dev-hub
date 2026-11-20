/**
 * Static, CI-only Linux musl x86_64 ELF inventory.
 * Reading headers does NOT prove dynamic linker compatibility or safe loading.
 * Never imports target modules or runs an untrusted native executable.
 */
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const MAX_NATIVE_BYTES = 180 * 1024 * 1024;

export function inspectElfHeader(header) {
  if (!Buffer.isBuffer(header) || header.length < 64) {
    throw new Error('Truncated native ELF header');
  }
  if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
    throw new Error('Not an ELF native artifact');
  }
  if (header[4] !== 2 || header[5] !== 1 || ![0, 3].includes(header[7])) {
    throw new Error('ELF is not supported little-endian 64-bit Linux');
  }
  if (![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 62) {
    throw new Error('ELF is not an x86_64 executable or shared object');
  }
  return { format: 'ELF64', architecture: 'x86_64', headerValidated: true };
}

export async function inspectElfFile(file, allowedRoot) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Native artifact is not a regular non-symlink file');
  }
  if (info.size < 64 || info.size > MAX_NATIVE_BYTES) {
    throw new Error('Native artifact size is outside reviewed bounds');
  }
  const root = await realpath(allowedRoot);
  const resolved = await realpath(file);
  if (!resolved.startsWith(root + sep)) {
    throw new Error('Native artifact escapes its private inspected root');
  }
  const fh = await open(file, 'r');
  const header = Buffer.alloc(64);
  try {
    const { bytesRead } = await fh.read(header, 0, header.length, 0);
    if (bytesRead !== 64) throw new Error('Incomplete ELF header read');
  } finally {
    await fh.close();
  }
  return {
    status: 'elf64-x86_64-header',
    sizeBytes: info.size,
    ...inspectElfHeader(header),
  };
}

async function firstCandidate(project, paths) {
  for (const suffix of paths) {
    const file = join(project, suffix);
    const finding = await inspectElfFile(file, project);
    if (finding.status !== 'missing') {
      return {
        ...finding,
        path: relative(project, file).replaceAll('\\', '/'),
      };
    }
  }
  return { status: 'missing' };
}

async function libvipsCandidate(project) {
  for (const prefix of ['node_modules', 'apps/api/node_modules']) {
    const dir = join(project, prefix, '@img', 'sharp-libvips-linuxmusl-x64', 'lib');
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const candidates = names.filter((name) => /^libvips-cpp\.so(?:\.[0-9.]+)?$/.test(name));
    if (candidates.length > 4) {
      throw new Error('Unexpected number of libvips ELF files');
    }
    for (const name of candidates) {
      const path = join(dir, name);
      const finding = await inspectElfFile(path, project);
      if (finding.status !== 'missing') {
        return {
          ...finding,
          path: relative(project, path).replaceAll('\\', '/'),
        };
      }
    }
  }
  return { status: 'missing' };
}

export async function inspectInstalledNativeArtifacts(project, engine) {
  const prefixes = ['node_modules', 'apps/api/node_modules'];
  const withSuffix = (path) => prefixes.map((prefix) => join(prefix, path));
  const bcrypt = await firstCandidate(
    project,
    withSuffix('bcrypt/prebuilds/linux-x64/bcrypt.musl.node'),
  );
  const sharp = await firstCandidate(
    project,
    withSuffix('@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.5.node'),
  );
  const libvips = await libvipsCandidate(project);
  const prismaSchemaEngine = await inspectElfFile(engine, '/engine');
  return {
    target: 'alpine-linux-musl-x86_64',
    bcrypt,
    sharp,
    libvips,
    prismaSchemaEngine,
    allExpectedHeadersPresent:
      bcrypt.status === 'elf64-x86_64-header' &&
      sharp.status === 'elf64-x86_64-header' &&
      libvips.status === 'elf64-x86_64-header' &&
      prismaSchemaEngine.status === 'elf64-x86_64-header',
    runtimeCompatibilityCertified: false,
  };
}
