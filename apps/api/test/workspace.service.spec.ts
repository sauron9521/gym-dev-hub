import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubService } from '../src/github/github.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';

describe('WorkspaceService', () => {
  let directory: string;
  let file: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gym-dev-hub-test-'));
    file = join(directory, 'workspace.json');
    process.env.DEV_HUB_WORKSPACE_FILE = file;
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-dev-hub,sauron9521/gym-platform';
    service = new WorkspaceService(new GitHubService());
  });

  afterEach(async () => {
    delete process.env.DEV_HUB_WORKSPACE_FILE;
    delete process.env.GITHUB_REPOSITORIES;
    await rm(directory, { recursive: true, force: true });
  });

  const createInput = {
    title: 'API slice',
    repository: 'sauron9521/gym-platform',
    task: 'Implement one small PR and wait for manual review',
  };

  it('initializes an empty workspace with allowed repositories', async () => {
    const overview = await service.list();
    expect(overview.sessions).toEqual([]);
    expect(overview.repositories).toContain('sauron9521/gym-platform');
  });

  it('persists a session, notes, and status across service restarts', async () => {
    const created = await service.create(createInput);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.status).toBe('planned');

    const updated = await service.update(created.id, {
      status: 'in-progress',
      title: 'API PR #456',
    });
    expect(updated.status).toBe('in-progress');
    const withNote = await service.addMessage(created.id, {
      content: 'CI should check latest SHA',
    });
    expect(withNote.messages[0]).toMatchObject({
      role: 'user',
      content: 'CI should check latest SHA',
    });

    const restored = new WorkspaceService(new GitHubService());
    const readBack = await restored.get(created.id);
    expect(readBack).toMatchObject({
      title: 'API PR #456',
      status: 'in-progress',
      messageCount: 1,
    });
    expect(readBack.messages[0].content).toBe('CI should check latest SHA');
    expect((await restored.list()).sessions[0].id).toBe(created.id);
  });

  it('serializes concurrent writes without losing notes', async () => {
    const created = await service.create(createInput);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.addMessage(created.id, { content: `Acceptance criteria #${index}` }),
      ),
    );
    const readBack = await new WorkspaceService(new GitHubService()).get(created.id);
    expect(readBack.messages).toHaveLength(12);
    expect(new Set(readBack.messages.map((note) => note.content)).size).toBe(12);
  });

  it('rejects unknown repositories before file mutation', async () => {
    await expect(service.create({ ...createInput, repository: 'other/private' })).rejects.toThrow(
      'Репозиторій не дозволений',
    );
    expect((await service.list()).sessions).toHaveLength(0);
  });

  it('validates text lengths and rejects extra payload fields', async () => {
    await expect(service.create({ ...createInput, title: 'a' })).rejects.toThrow();
    await expect(service.create({ ...createInput, role: 'assistant' })).rejects.toThrow();
    const created = await service.create(createInput);
    await expect(service.update(created.id, { role: 'assistant' })).rejects.toThrow();
    await expect(service.addMessage(created.id, { content: ' ' })).rejects.toThrow();
    await expect(service.addMessage(created.id, { content: 'a'.repeat(4001) })).rejects.toThrow();
    expect((await service.get(created.id)).messages).toEqual([]);
  });

  it('rejects malformed ids and unknown sessions', async () => {
    await expect(service.get('../../passwd')).rejects.toThrow('Некоректний ідентифікатор');
    await expect(service.get('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'Сесію не знайдено',
    );
  });

  it('does not overwrite a corrupted workspace', async () => {
    const original = '{invalid-json';
    await writeFile(file, original, 'utf8');
    await expect(service.create(createInput)).rejects.toThrow('Файл сесій пошкоджено');
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('lists most recently updated sessions first', async () => {
    const first = await service.create(createInput);
    const second = await service.create({ ...createInput, title: 'Web slice' });
    await service.addMessage(first.id, { content: 'Check tests' });
    const items = (await service.list()).sessions;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe(first.id);
    expect(items[1].id).toBe(second.id);
  });
});
