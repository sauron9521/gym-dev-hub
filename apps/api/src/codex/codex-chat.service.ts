import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Observable } from 'rxjs';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatSnapshot,
  ChatStreamEvent,
  ChatTurnSnapshot,
} from '@gym-dev-hub/contracts';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { CodexBridgeService } from './codex-bridge.service.js';

const promptSchema = z.strictObject({ content: z.string().trim().min(1).max(3000) });
const MAX_CHAT_ENTRIES = 100;

@Injectable()
export class CodexChatService {
  private readonly active = new Map<string, ChatTurnSnapshot>();
  private readonly changes = new EventEmitter();
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly codex: CodexBridgeService,
  ) {
    this.changes.setMaxListeners(80);
  }

  async snapshot(sessionId: string): Promise<ChatSnapshot> {
    const messages: ChatMessage[] = await this.workspace.getChatMessages(sessionId);
    return {
      sessionId,
      messages,
      turn: this.active.get(sessionId) ?? { state: 'idle', draft: '', error: null },
    };
  }

  private publish(sessionId: string, event: ChatStreamEvent): void {
    this.changes.emit(sessionId, event);
  }

  events(sessionId: string): Observable<{ data: ChatStreamEvent }> {
    return new Observable((subscriber) => {
      let cancelled = false;
      const listener = (event: ChatStreamEvent) => subscriber.next({ data: event });
      this.changes.on(sessionId, listener);
      void this.snapshot(sessionId)
        .then((snapshot) => {
          if (!cancelled) subscriber.next({ data: { kind: 'snapshot', snapshot } });
        })
        .catch(() => {
          if (!cancelled)
            subscriber.next({
              data: {
                kind: 'progress',
                turn: { state: 'failed', draft: '', error: 'Сесію не знайдено.' },
              },
            });
        });
      const ping = setInterval(() => {
        if (!cancelled) subscriber.next({ data: { kind: 'ping' } });
      }, 15_000);
      return () => {
        cancelled = true;
        clearInterval(ping);
        this.changes.off(sessionId, listener);
      };
    });
  }

  async start(sessionId: string, input: unknown): Promise<ChatSnapshot> {
    const parsed = promptSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Повідомлення має містити 1–3000 символів.');
    }
    if (this.active.has(sessionId)) {
      throw new ConflictException('Codex ще обробляє попереднє повідомлення.');
    }
    this.active.set(sessionId, { state: 'starting', draft: '', error: null });
    this.publish(sessionId, { kind: 'progress', turn: this.active.get(sessionId)! });
    try {
      const session = await this.workspace.get(sessionId);
      if (session.status === 'completed') {
        throw new BadRequestException('Завершена сесія не приймає повідомлень.');
      }
      const history = await this.workspace.getChatMessages(sessionId);
      if (history.length > MAX_CHAT_ENTRIES - 2) {
        throw new BadRequestException('Досягнуто ліміту повідомлень у чаті.');
      }
      // Explicitly initiated by a user composing a prompt. Guarantees we
      // reconnect to the correct thread after NestJS restarts.
      const binding = await this.workspace.linkCodex(sessionId);
      await this.workspace.appendChatMessage(sessionId, 'user', parsed.data.content);
      void this.execute(sessionId, binding.threadId, parsed.data.content);
      return await this.snapshot(sessionId);
    } catch (error) {
      this.active.delete(sessionId);
      this.publish(sessionId, { kind: 'refresh' });
      throw error;
    }
  }

  private async execute(sessionId: string, threadId: string, prompt: string): Promise<void> {
    const update = (draft: string) => {
      const turn: ChatTurnSnapshot = { state: 'streaming', draft, error: null };
      this.active.set(sessionId, turn);
      this.publish(sessionId, { kind: 'progress', turn });
    };
    try {
      const result = await this.codex.startReadOnlyTurn(threadId, prompt, update);
      const state = result.status === 'completed' ? 'completed' : result.status;
      await this.workspace.appendChatMessage(
        sessionId,
        'assistant',
        result.text || (result.status === 'completed' ? 'Немає текстової відповіді.' : ''),
        state,
      );
    } catch {
      // Never propagate raw Codex errors which might contain local paths/secrets.
      await this.workspace
        .appendChatMessage(sessionId, 'assistant', '', 'failed')
        .catch(() => undefined);
    } finally {
      this.active.delete(sessionId);
      this.publish(sessionId, { kind: 'refresh' });
    }
  }
}
