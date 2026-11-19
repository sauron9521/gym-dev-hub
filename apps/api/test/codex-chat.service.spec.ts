import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubService } from '../src/github/github.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';
import { CodexChatService } from '../src/codex/codex-chat.service.js';
import { CodexBridgeService } from '../src/codex/codex-bridge.service.js';

describe('CodexChatService', () => {
  let root: string;
  let bridge: CodexBridgeService;
  let workspace: WorkspaceService;
  let chat: CodexChatService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'devhub-chat-'));
    process.env.DEV_HUB_WORKSPACE_FILE = join(root, 'sessions.json');
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-dev-hub';
    bridge = new CodexBridgeService();
    workspace = new WorkspaceService(new GitHubService(), bridge);
    chat = new CodexChatService(workspace, bridge);
    vi.spyOn(bridge, 'linkThread').mockResolvedValue({ id: 'thread-1234', reused: false });
    vi.spyOn(bridge, 'startReadOnlyTurn').mockImplementation(async (_id, _prompt, update) => {
      update('Привіт');
      return { text: 'Привіт!', status: 'completed' };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.DEV_HUB_WORKSPACE_FILE;
    delete process.env.GITHUB_REPOSITORIES;
    await rm(root, { force: true, recursive: true });
  });

  async function createSession() {
    return workspace.create({
      title: 'Test session',
      repository: 'sauron9521/gym-dev-hub',
      task: 'One implementation slice',
    });
  }

  it('persists user prompts and assistant answers without overwriting notes', async () => {
    const session = await createSession();
    await workspace.addMessage(session.id, { content: 'Personal note' });
    const started = await chat.start(session.id, { content: 'Привіт Codex' });
    expect(started.turn.state).toMatch(/starting|streaming/);
    await vi.waitFor(async () => {
      const state = await chat.snapshot(session.id);
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0]).toMatchObject({ role: 'user', content: 'Привіт Codex' });
      expect(state.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Привіт!',
        state: 'completed',
      });
    });
    expect((await workspace.get(session.id)).messages[0].content).toBe('Personal note');
    expect(
      await new WorkspaceService(new GitHubService(), bridge).getChatMessages(session.id),
    ).toHaveLength(2);
  });

  it('rejects an overlapping turn for the same session', async () => {
    const session = await createSession();
    let finish!: (response: { text: string; status: 'completed' }) => void;
    vi.mocked(bridge.startReadOnlyTurn).mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await chat.start(session.id, { content: 'First' });
    await expect(chat.start(session.id, { content: 'Second' })).rejects.toThrow(
      'Codex ще обробляє',
    );
    finish({ text: 'Done', status: 'completed' });
    await vi.waitFor(async () =>
      expect((await chat.snapshot(session.id)).messages).toHaveLength(2),
    );
  });

  it('rejects blank, oversized or finished-session prompts', async () => {
    const session = await createSession();
    await expect(chat.start(session.id, { content: ' ' })).rejects.toThrow();
    await expect(chat.start(session.id, { content: 'A'.repeat(3001) })).rejects.toThrow();
    await workspace.update(session.id, { status: 'completed' });
    await expect(chat.start(session.id, { content: 'Hello' })).rejects.toThrow('Завершена сесія');
    expect(await workspace.getChatMessages(session.id)).toHaveLength(0);
  });

  it('persists a failure instead of indefinitely presenting a running turn', async () => {
    const session = await createSession();
    vi.mocked(bridge.startReadOnlyTurn).mockRejectedValue(new Error('Sensitive API token data'));
    await chat.start(session.id, { content: 'Test failure' });
    await vi.waitFor(async () => {
      const state = await chat.snapshot(session.id);
      expect(state.messages).toHaveLength(2);
      expect(state.turn.state).toBe('idle');
      expect(state.messages[1]).toMatchObject({ role: 'assistant', state: 'failed' });
      expect(JSON.stringify(state)).not.toContain('Sensitive');
    });
  });

  it('exposes progress via SSE observable with an initial snapshot', async () => {
    const session = await createSession();
    const events: string[] = [];
    const subscription = chat.events(session.id).subscribe((item) => events.push(item.data.kind));
    await vi.waitFor(() => expect(events).toContain('snapshot'));
    await chat.start(session.id, { content: 'Stream' });
    await vi.waitFor(() => expect(events).toContain('refresh'));
    subscription.unsubscribe();
  });
});
