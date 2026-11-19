import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AgentSession,
  AgentSessionSummary,
  WorkspaceOverview,
  CodexSessionBinding,
} from '@gym-dev-hub/contracts';
import { CodexBridgeService } from '../codex/codex-bridge.service.js';
import { GitHubService } from '../github/github.service.js';
import {
  createMessageSchema,
  createSessionSchema,
  persistedWorkspaceSchema,
  updateSessionSchema,
  type PersistedWorkspace,
} from './workspace.schema.js';

const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 100;

function summary(session: PersistedWorkspace['sessions'][number]): AgentSessionSummary {
  return {
    id: session.id,
    title: session.title,
    task: session.task,
    repository: session.repository,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    codexThreadId: session.codexThreadId ?? null,
  };
}

function fullSession(session: PersistedWorkspace['sessions'][number]): AgentSession {
  return { ...summary(session), messages: session.messages.map((message) => ({ ...message })) };
}

@Injectable()
export class WorkspaceService {
  private readonly filePath = resolve(
    process.env.DEV_HUB_WORKSPACE_FILE ?? resolve(process.cwd(), '.local', 'agent-workspace.json'),
  );

  // Single-process serialization: mutate only after reading latest on-disk state.
  // Multiple independent API processes sharing the file are not supported.
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly github: GitHubService,
    private readonly codex: CodexBridgeService,
  ) {}

  private async load(): Promise<PersistedWorkspace> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, sessions: [] };
      }
      throw new ServiceUnavailableException('Не вдалося прочитати локальне сховище сесій.');
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return persistedWorkspaceSchema.parse(parsed);
    } catch {
      // Never overwrite a corrupt or incompatible file with empty data.
      throw new ServiceUnavailableException(
        'Файл сесій пошкоджено або має несумісну версію. Дані не змінено.',
      );
    }
  }

  private async save(data: PersistedWorkspace): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(data, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temp, this.filePath);
    } catch {
      await unlink(temp).catch(() => undefined);
      throw new ServiceUnavailableException('Не вдалося зберегти робочу сесію.');
    }
  }

  private transact<T>(
    callback: (data: PersistedWorkspace) => T | Promise<T>,
    persist = false,
  ): Promise<T> {
    const current = this.serial.then(async () => {
      const data = await this.load();
      const result = await callback(data);
      if (persist) await this.save(data);
      return result;
    });
    this.serial = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  list(): Promise<WorkspaceOverview> {
    return this.transact((data) => ({
      repositories: this.github.listAllowedRepositories(),
      sessions: data.sessions
        .map(summary)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }));
  }

  get(id: string): Promise<AgentSession> {
    return this.transact((data) => fullSession(this.findSession(data, id)));
  }

  async create(input: unknown): Promise<AgentSession> {
    const parsed = createSessionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Перевір назву, репозиторій і задачу.');
    const repository = this.github.assertAllowedRepository(parsed.data.repository);
    return this.transact((data) => {
      if (data.sessions.length >= MAX_SESSIONS) {
        throw new BadRequestException('Досягнуто ліміту 50 сесій.');
      }
      const now = new Date().toISOString();
      const session: PersistedWorkspace['sessions'][number] = {
        id: randomUUID(),
        title: parsed.data.title,
        task: parsed.data.task,
        repository,
        status: 'planned',
        codexThreadId: null,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      data.sessions.push(session);
      return fullSession(session);
    }, true);
  }

  async update(id: string, input: unknown): Promise<AgentSession> {
    const parsed = updateSessionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректне оновлення сесії.');
    return this.transact((data) => {
      const session = this.findSession(data, id);
      Object.assign(session, parsed.data, { updatedAt: new Date().toISOString() });
      return fullSession(session);
    }, true);
  }

  async addMessage(id: string, input: unknown): Promise<AgentSession> {
    const parsed = createMessageSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Повідомлення має містити 1–4000 символів.');
    return this.transact((data) => {
      const session = this.findSession(data, id);
      if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
        throw new BadRequestException('Ліміт 100 повідомлень у сесії.');
      }
      const now = new Date().toISOString();
      session.messages.push({
        id: randomUUID(),
        role: 'user',
        content: parsed.data.content,
        createdAt: now,
      });
      session.updatedAt = now;
      return fullSession(session);
    }, true);
  }

  linkCodex(id: string): Promise<CodexSessionBinding> {
    return this.transact(async (data) => {
      const session = this.findSession(data, id);
      const previousId = session.codexThreadId ?? null;
      const binding = await this.codex.linkThread(session.id, previousId);
      session.codexThreadId = binding.id;
      session.updatedAt = new Date().toISOString();
      return {
        sessionId: session.id,
        threadId: binding.id,
        reused: binding.reused,
        connection: this.codex.status(),
      };
    }, true);
  }

  private findSession(data: PersistedWorkspace, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('Некоректний ідентифікатор сесії.');
    }
    const session = data.sessions.find((item) => item.id === id);
    if (!session) throw new NotFoundException('Сесію не знайдено.');
    return session;
  }
}
