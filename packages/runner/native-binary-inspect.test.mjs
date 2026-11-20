import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectElfFile, inspectElfHeader } from './native-binary-inspect.mjs';

function fixture({ machine = 62, elfClass = 2, endian = 1, type = 3 } = {}) {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = elfClass;
  header[5] = endian;
  header[7] = 0;
  header.writeUInt16LE(type, 16);
  header.writeUInt16LE(machine, 18);
  return header;
}

test('valid ELF64 little-endian x86_64 shared object header', () => {
  assert.equal(inspectElfHeader(fixture()).architecture, 'x86_64');
  assert.equal(inspectElfHeader(fixture({ type: 2 })).format, 'ELF64');
});

test('reject malformed, incompatible and unsupported native headers', () => {
  for (const bad of [
    Buffer.alloc(64),
    Buffer.alloc(6),
    fixture({ machine: 183 }),
    fixture({ elfClass: 1 }),
    fixture({ endian: 2 }),
    fixture({ type: 1 }),
  ]) {
    assert.throws(() => inspectElfHeader(bad), /ELF|Truncated/);
  }
});

test('report missing native file without importing or executing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-header-'));
  try {
    assert.deepEqual(await inspectElfFile(join(root, 'not-here.node'), root), {
      status: 'missing',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accept static header and reject a symlink pretending to be a native file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-header-'));
  try {
    const file = join(root, 'native.node');
    await writeFile(file, fixture());
    assert.equal((await inspectElfFile(file, root)).status, 'elf64-x86_64-header');
    const link = join(root, 'alias.node');
    await symlink(file, link);
    await assert.rejects(inspectElfFile(link, root), /symlink/);
    await writeFile(file, fixture({ machine: 183 }));
    await assert.rejects(inspectElfFile(file, root), /x86_64/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
