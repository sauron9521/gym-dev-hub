import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { describePath, boundedRecord, LOG_MAX_BYTES } = require('./nest-watch-fs-probe.cjs');

test('safe watcher path labels preserve tracked source but redact private and external paths', () => {
  const root = '/mnt/repository';
  assert.equal(describePath(root, root + '/apps/api/src/main.ts'), 'apps/api/src/main.ts');
  assert.equal(
    describePath(root, root + '/packages/contracts/src/index.ts'),
    'packages/contracts/src/index.ts',
  );
  assert.equal(
    describePath(root, root + '/apps/api/.local/worktrees/secret/test.ts'),
    'apps/api/.local/<redacted>',
  );
  assert.match(describePath(root, '/tmp/private/keys.env'), /^external\/[0-9a-f]{12}$/);
  assert.match(
    describePath(root, root + '/apps/api/src/credentials.ts'),
    /^repo-other\/[0-9a-f]{12}$/,
  );
  assert.match(describePath(root, root + '/apps/api/.env'), /^repo-other\/[0-9a-f]{12}$/);
});

test('audit is bounded, owner-only and refuses a replaced symlink log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-watch-probe-'));
  const log = join(dir, 'events.jsonl');
  try {
    await writeFile(log, '', { mode: 0o600 });
    assert.equal(boundedRecord(log, { event: 'probe', path: 'apps/api/src/main.ts' }), true);
    assert.match(await readFile(log, 'utf8'), /apps\/api\/src\/main\.ts/);
    if (typeof process.getuid === 'function') {
      await writeFile(log, 'visible');
      const { chmod } = await import('node:fs/promises');
      await chmod(log, 0o644);
      assert.equal(boundedRecord(log, { event: 'private-required' }), false);
      await chmod(log, 0o600);
    }
    await writeFile(log, 'x'.repeat(LOG_MAX_BYTES));
    assert.equal(boundedRecord(log, { event: 'beyond-limit' }), false);
    await rm(log);
    if (process.platform !== 'win32') {
      await symlink(join(dir, 'external-target'), log);
      assert.throws(() => boundedRecord(log, { event: 'injected' }));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preload captures a live Node fs.watch source edit without logging content', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux real inotify fixture');
  const root = await mkdtemp(join(tmpdir(), 'devhub-watch-probe-live-'));
  const source = join(root, 'apps/api/src');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source, { recursive: true });
  const file = join(source, 'main.ts');
  const audit = join(root, 'audit.jsonl');
  await writeFile(audit, '', { mode: 0o600 });
  try {
    const script = `const fs=require('node:fs');const file=process.argv[1];const w=fs.watch(file,()=>{});setTimeout(()=>fs.writeFileSync(file,'edited'),80);setTimeout(()=>{w.close();},230);`;
    await writeFile(file, 'original');
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        new URL('./nest-watch-fs-probe.cjs', import.meta.url).pathname,
        '-e',
        script,
        file,
      ],
      {
        encoding: 'utf8',
        timeout: 6000,
        env: {
          ...process.env,
          DEV_HUB_WATCH_DIAGNOSTIC_LOG: audit,
          DEV_HUB_WATCH_DIAGNOSTIC_ROOT: root,
        },
      },
    );
    assert.equal(result.status, 0, (result.stderr || '').slice(0, 500));
    const events = (await readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.event === 'fs.watch' && e.path === 'apps/api/src/main.ts'));
    assert.ok(events.every((e) => !JSON.stringify(e).includes('edited')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
