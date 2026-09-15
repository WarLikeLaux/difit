import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import type { DiffCommentThread, DiffCommentMessage, DiffCommentPosition } from '../types/diff.js';

import { ensurePrivateDirectory, writePrivateFile } from './private-storage.js';

type AgentReviewEvent =
  | {
      seq: number;
      type: 'userMessage';
      threadId: string;
      filePath: string;
      position: DiffCommentPosition;
      message: DiffCommentMessage;
    }
  | {
      seq: number;
      type: 'accepted';
      threadId: string;
      filePath: string;
      position: DiffCommentPosition;
      acceptedAt: string;
    }
  | {
      seq: number;
      type: 'toVerify';
      threadId: string;
      filePath: string;
      position: DiffCommentPosition;
      toVerifyAt: string;
    };

interface StoredAgentEventInbox {
  version: 1;
  nextSeq: number;
  ackedThrough: number;
  wakeOutstanding: boolean;
  wakeSentAt?: string;
  events: AgentReviewEvent[];
}

type PendingAgentReviewEvent =
  | Omit<Extract<AgentReviewEvent, { type: 'userMessage' }>, 'seq'>
  | Omit<Extract<AgentReviewEvent, { type: 'accepted' }>, 'seq'>
  | Omit<Extract<AgentReviewEvent, { type: 'toVerify' }>, 'seq'>;

export interface AgentEventBatch {
  reviewId: string;
  ackedThrough: number;
  throughSeq: number;
  events: AgentReviewEvent[];
}

interface AgentEventInboxOptions {
  reviewId: string;
  port: number;
  hapiSessionId?: string;
  configDirectory?: string;
  debounceMs?: number;
  retryMs?: number;
  sendWake?: (sessionId: string, message: string, localId: string) => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RETRY_MS = 5 * 60 * 1_000;

function defaultConfigDirectory(): string {
  const configured = process.env.DIFIT_CONFIG_DIR?.trim();
  return configured || join(homedir(), '.difit');
}

function isStoredAgentEventInbox(value: unknown): value is StoredAgentEventInbox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredAgentEventInbox>;
  return (
    candidate.version === 1 &&
    typeof candidate.nextSeq === 'number' &&
    Number.isInteger(candidate.nextSeq) &&
    typeof candidate.ackedThrough === 'number' &&
    Number.isInteger(candidate.ackedThrough) &&
    typeof candidate.wakeOutstanding === 'boolean' &&
    Array.isArray(candidate.events)
  );
}

function messageIdentity(threadId: string, messageId: string): string {
  return `${threadId}\u0000${messageId}`;
}

export function findAgentReviewEvents(
  previousThreads: DiffCommentThread[],
  nextThreads: DiffCommentThread[],
): PendingAgentReviewEvent[] {
  const previousMessages = new Map<string, string>();
  const previousAccepted = new Map<string, string | undefined>();
  const previousToVerify = new Map<string, string | undefined>();

  for (const thread of previousThreads) {
    previousAccepted.set(thread.id, thread.acceptedAt);
    previousToVerify.set(thread.id, thread.toVerifyAt);
    for (const message of thread.messages) {
      previousMessages.set(messageIdentity(thread.id, message.id), message.updatedAt);
    }
  }

  const events: PendingAgentReviewEvent[] = [];
  for (const thread of nextThreads) {
    for (const message of thread.messages) {
      if (message.author?.trim() !== 'User') continue;
      if (previousMessages.get(messageIdentity(thread.id, message.id)) === message.updatedAt) {
        continue;
      }
      events.push({
        type: 'userMessage',
        threadId: thread.id,
        filePath: thread.filePath,
        position: thread.position,
        message,
      });
    }

    if (thread.acceptedAt && previousAccepted.get(thread.id) !== thread.acceptedAt) {
      events.push({
        type: 'accepted',
        threadId: thread.id,
        filePath: thread.filePath,
        position: thread.position,
        acceptedAt: thread.acceptedAt,
      });
    }

    if (thread.toVerifyAt && previousToVerify.get(thread.id) !== thread.toVerifyAt) {
      events.push({
        type: 'toVerify',
        threadId: thread.id,
        filePath: thread.filePath,
        position: thread.position,
        toVerifyAt: thread.toVerifyAt,
      });
    }
  }

  return events;
}

function runHapiPing(sessionId: string, message: string, localId: string): Promise<void> {
  const executable = process.env.HAPI_CLI_EXECUTABLE?.trim() || 'hapi';
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['ping-peer', sessionId, message, '--local-id', localId],
      { timeout: 70_000, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function emptyInbox(): StoredAgentEventInbox {
  return {
    version: 1,
    nextSeq: 1,
    ackedThrough: 0,
    wakeOutstanding: false,
    events: [],
  };
}

export async function getPendingAgentEventCount(
  reviewId: string,
  configDirectory = defaultConfigDirectory(),
): Promise<number> {
  try {
    const path = join(configDirectory, 'agent-events', `${reviewId}.json`);
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    return isStoredAgentEventInbox(parsed) ? parsed.events.length : 0;
  } catch {
    return 0;
  }
}

export async function deleteAgentEventInbox(
  reviewId: string,
  configDirectory = defaultConfigDirectory(),
): Promise<void> {
  await fs.rm(join(configDirectory, 'agent-events', `${reviewId}.json`), { force: true });
}

export class AgentEventInbox {
  readonly #reviewId: string;
  readonly #port: number;
  readonly #hapiSessionId?: string;
  readonly #path: string;
  readonly #debounceMs: number;
  readonly #retryMs: number;
  readonly #sendWake: (sessionId: string, message: string, localId: string) => Promise<void>;
  #state = emptyInbox();
  #operations: Promise<void> = Promise.resolve();
  #wakeTimer?: NodeJS.Timeout;
  #disposed = false;

  constructor(options: AgentEventInboxOptions) {
    this.#reviewId = options.reviewId;
    this.#port = options.port;
    this.#hapiSessionId = options.hapiSessionId?.trim() || undefined;
    this.#path = join(
      options.configDirectory ?? defaultConfigDirectory(),
      'agent-events',
      `${options.reviewId}.json`,
    );
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#sendWake = options.sendWake ?? runHapiPing;
  }

  async initialize(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.#path, 'utf8'));
      if (isStoredAgentEventInbox(parsed)) this.#state = parsed;
    } catch {
      this.#state = emptyInbox();
    }

    if (this.#state.events.length > 0) {
      // A process restart invalidates the old delivery attempt. Wake the session currently
      // associated with this viewer and let the durable inbox provide idempotency.
      this.#state.wakeOutstanding = false;
      delete this.#state.wakeSentAt;
      await this.#persist();
      this.#scheduleWake();
    }
  }

  async recordChanges(
    previousThreads: DiffCommentThread[],
    nextThreads: DiffCommentThread[],
  ): Promise<void> {
    const events = findAgentReviewEvents(previousThreads, nextThreads);
    if (events.length === 0) return;

    await this.#serialize(async () => {
      for (const event of events) {
        this.#state.events.push({ ...event, seq: this.#state.nextSeq++ } as AgentReviewEvent);
      }
      await this.#persist();
      if (!this.#state.wakeOutstanding) this.#scheduleWake();
    });
  }

  async getBatch(): Promise<AgentEventBatch> {
    return this.#serialize(() => {
      const events = structuredClone(this.#state.events);
      return {
        reviewId: this.#reviewId,
        ackedThrough: this.#state.ackedThrough,
        throughSeq: events.at(-1)?.seq ?? this.#state.ackedThrough,
        events,
      };
    });
  }

  async acknowledge(throughSeq: number): Promise<{
    success: true;
    ackedThrough: number;
    pendingCount: number;
  }> {
    return this.#serialize(async () => {
      const newestSeq = this.#state.events.at(-1)?.seq ?? this.#state.ackedThrough;
      this.#state.ackedThrough = Math.max(
        this.#state.ackedThrough,
        Math.min(throughSeq, newestSeq),
      );
      this.#state.events = this.#state.events.filter(
        (event) => event.seq > this.#state.ackedThrough,
      );
      this.#state.wakeOutstanding = false;
      delete this.#state.wakeSentAt;
      await this.#persist();

      this.#clearWakeTimer();
      if (this.#state.events.length > 0) this.#scheduleWake();

      return {
        success: true,
        ackedThrough: this.#state.ackedThrough,
        pendingCount: this.#state.events.length,
      };
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearWakeTimer();
  }

  async flush(): Promise<void> {
    await this.#operations;
  }

  #serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #scheduleWake(delay = this.#debounceMs, retryOutstanding = false): void {
    if (this.#disposed || !this.#hapiSessionId || this.#wakeTimer) return;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined;
      void this.#serialize(() => this.#deliverWake(retryOutstanding));
    }, delay);
    this.#wakeTimer.unref?.();
  }

  async #deliverWake(retryOutstanding: boolean): Promise<void> {
    if (
      this.#disposed ||
      !this.#hapiSessionId ||
      (this.#state.wakeOutstanding && !retryOutstanding) ||
      this.#state.events.length === 0
    ) {
      return;
    }

    const message = [
      `Difit review ${this.#reviewId} has new user feedback or a requested status action.`,
      `Use the difit MCP get_events tool with port ${this.#port}; CLI fallback: difit comment events --port ${this.#port}`,
      `After handling every returned event, acknowledge the exact throughSeq with the MCP ack_events tool; CLI fallback: difit comment ack <throughSeq> --port ${this.#port}`,
    ].join('\n');
    const firstPendingSeq = this.#state.events[0]?.seq;
    if (firstPendingSeq === undefined) return;
    const localId = `difit-wake:${this.#reviewId}:${this.#port}:${firstPendingSeq}`;

    try {
      await this.#sendWake(this.#hapiSessionId, message, localId);
      this.#state.wakeOutstanding = true;
      this.#state.wakeSentAt = new Date().toISOString();
      await this.#persist();
      this.#scheduleWake(this.#retryMs, true);
    } catch (error) {
      console.warn(
        `Warning: Failed to wake HAPI session for review ${this.#reviewId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.#scheduleWake(Math.min(this.#retryMs, 30_000));
    }
  }

  #clearWakeTimer(): void {
    if (!this.#wakeTimer) return;
    clearTimeout(this.#wakeTimer);
    this.#wakeTimer = undefined;
  }

  async #persist(): Promise<void> {
    await ensurePrivateDirectory(dirname(this.#path));
    await writePrivateFile(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`);
  }
}
