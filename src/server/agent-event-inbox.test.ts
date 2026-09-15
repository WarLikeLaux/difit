import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffCommentThread } from '../types/diff.js';

import { AgentEventInbox, findAgentReviewEvents } from './agent-event-inbox.js';

const temporaryDirectories: string[] = [];

function thread(
  messages: DiffCommentThread['messages'],
  statuses: Pick<DiffCommentThread, 'acceptedAt' | 'toVerifyAt'> = {},
): DiffCommentThread {
  return {
    id: 'thread-1',
    filePath: 'src/app.ts',
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
    position: { side: 'new', line: 12 },
    messages,
    ...statuses,
  };
}

function message(
  id: string,
  body: string,
  author = 'User',
  updatedAt = '2026-09-13T10:00:00.000Z',
) {
  return { id, body, author, createdAt: updatedAt, updatedAt };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('findAgentReviewEvents', () => {
  it('finds new and edited User messages plus Accepted and To verify transitions', () => {
    const existing = message('message-1', 'before');
    const edited = message('message-1', 'after', 'User', '2026-09-13T10:01:00.000Z');
    const added = message('message-2', 'new');
    const agent = message('message-3', 'agent reply', 'Agent');

    expect(
      findAgentReviewEvents(
        [thread([existing])],
        [
          thread([edited, added, agent], {
            acceptedAt: '2026-09-13T10:01:30.000Z',
            toVerifyAt: '2026-09-13T10:02:00.000Z',
          }),
        ],
      ),
    ).toEqual([
      expect.objectContaining({ type: 'userMessage', message: edited }),
      expect.objectContaining({ type: 'userMessage', message: added }),
      expect.objectContaining({
        type: 'accepted',
        acceptedAt: '2026-09-13T10:01:30.000Z',
      }),
      expect.objectContaining({ type: 'toVerify', toVerifyAt: '2026-09-13T10:02:00.000Z' }),
    ]);
  });

  it('ignores unchanged messages and agent replies', () => {
    const existing = message('message-1', 'same');
    expect(
      findAgentReviewEvents(
        [thread([existing])],
        [thread([existing, message('a', 'reply', 'Agent')])],
      ),
    ).toEqual([]);
  });
});

describe('AgentEventInbox', () => {
  it('coalesces events behind one wake until they are acknowledged', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(
      async (_sessionId: string, _message: string, _localId: string) => undefined,
    );
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 10,
      retryMs: 60_000,
      sendWake,
    });
    await inbox.initialize();

    await inbox.recordChanges([], [thread([message('message-1', 'first')])]);
    await inbox.recordChanges(
      [thread([message('message-1', 'first')])],
      [thread([message('message-1', 'first'), message('message-2', 'second')])],
    );
    await vi.advanceTimersByTimeAsync(10);
    await inbox.flush();
    expect(sendWake).toHaveBeenCalledTimes(1);
    expect(sendWake).toHaveBeenLastCalledWith(
      'hapi-session',
      expect.any(String),
      'difit-wake:review-1:4966:1',
    );

    await inbox.recordChanges(
      [thread([message('message-1', 'first'), message('message-2', 'second')])],
      [
        thread([
          message('message-1', 'first'),
          message('message-2', 'second'),
          message('message-3', 'third'),
        ]),
      ],
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(sendWake).toHaveBeenCalledTimes(1);

    const batch = await inbox.getBatch();
    expect(batch.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(batch.throughSeq).toBe(3);

    await inbox.acknowledge(2);
    await vi.advanceTimersByTimeAsync(10);
    await inbox.flush();
    expect(sendWake).toHaveBeenCalledTimes(2);
    expect((await inbox.getBatch()).events.map((event) => event.seq)).toEqual([3]);
    inbox.dispose();
  });

  it('redelivers persisted unacknowledged events after restart', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const firstWake = vi.fn(async () => undefined);
    const first = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'old-session',
      configDirectory: directory,
      debounceMs: 10,
      sendWake: firstWake,
    });
    await first.initialize();
    await first.recordChanges([], [thread([message('message-1', 'first')])]);
    await vi.advanceTimersByTimeAsync(10);
    await first.flush();
    expect(firstWake).toHaveBeenCalledTimes(1);
    first.dispose();

    const secondWake = vi.fn(async () => undefined);
    const second = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4967,
      hapiSessionId: 'new-session',
      configDirectory: directory,
      debounceMs: 10,
      sendWake: secondWake,
    });
    await second.initialize();
    await vi.advanceTimersByTimeAsync(10);
    expect(secondWake).toHaveBeenCalledWith(
      'new-session',
      expect.stringContaining('--port 4967'),
      'difit-wake:review-1:4967:1',
    );
    second.dispose();
  });

  it('reuses one HAPI local ID for retries of the same outstanding wake', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(
      async (_sessionId: string, _message: string, _localId: string) => undefined,
    );
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 10,
      retryMs: 100,
      sendWake,
    });
    await inbox.initialize();

    await inbox.recordChanges([], [thread([message('message-1', 'first')])]);
    await vi.advanceTimersByTimeAsync(10);
    await inbox.flush();
    await vi.advanceTimersByTimeAsync(100);
    await inbox.flush();

    expect(sendWake).toHaveBeenCalledTimes(2);
    expect(sendWake.mock.calls.map((call) => call[2])).toEqual([
      'difit-wake:review-1:4966:1',
      'difit-wake:review-1:4966:1',
    ]);
    inbox.dispose();
  });
});
