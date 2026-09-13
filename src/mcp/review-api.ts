import type { DiffCommentPosition, DiffCommentThread } from '../types/diff.js';
import { createId } from '../utils/createId.js';
import { authenticatedFetch } from '../cli/auth-client.js';

export type ThreadStatus = 'open' | 'accepted' | 'to_verify' | 'ready';

export interface AgentEventBatch {
  reviewId: string;
  ackedThrough: number;
  throughSeq: number;
  events: unknown[];
}

type FetchLike = typeof authenticatedFetch;

async function parseResponse(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    const message =
      typeof body.error === 'string' ? body.error : `Difit returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

export class DifitReviewApi {
  readonly #fetch: FetchLike;

  constructor(fetcher: FetchLike = authenticatedFetch) {
    this.#fetch = fetcher;
  }

  async getContext(port: number): Promise<unknown> {
    return this.#request(port, '/api/review-context');
  }

  async getComments(port: number, includeResolved = false): Promise<unknown> {
    const result = (await this.#request(port, '/api/comments-json')) as {
      threads?: DiffCommentThread[];
      [key: string]: unknown;
    };
    return {
      ...result,
      threads: includeResolved
        ? (result.threads ?? [])
        : (result.threads ?? []).filter((thread) => !thread.resolvedAt),
    };
  }

  async getEvents(port: number): Promise<AgentEventBatch> {
    return (await this.#request(port, '/api/agent-events')) as AgentEventBatch;
  }

  async acknowledgeEvents(port: number, throughSeq: number): Promise<unknown> {
    return this.#request(port, '/api/agent-events/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ throughSeq }),
    });
  }

  async addComment(
    port: number,
    input: { filePath: string; position: DiffCommentPosition; body: string },
  ): Promise<unknown> {
    const threadId = createId();
    const result = await this.#request(port, '/api/comment-imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          type: 'thread',
          id: threadId,
          filePath: input.filePath,
          position: input.position,
          body: input.body,
          author: 'Agent',
        },
      ]),
    });
    return { threadId, result };
  }

  async reply(port: number, threadId: string, body: string): Promise<unknown> {
    return this.#request(port, `/api/comments/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async editMessage(
    port: number,
    threadId: string,
    messageId: string,
    body: string,
  ): Promise<unknown> {
    return this.#request(
      port,
      `/api/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
  }

  async setThreadStatus(port: number, threadId: string, status: ThreadStatus): Promise<unknown> {
    return this.#request(port, `/api/comments/${encodeURIComponent(threadId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  }

  async #request(port: number, path: string, init?: RequestInit): Promise<unknown> {
    try {
      return await parseResponse(await this.#fetch(`http://localhost:${port}${path}`, init));
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch failed')) {
        throw new Error(`Cannot connect to difit server on port ${port}`, { cause: error });
      }
      throw error;
    }
  }
}
