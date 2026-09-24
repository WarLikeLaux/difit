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
      expect.objectContaining({ type: 'userMessage', message: edited, threadStatus: 'to_verify' }),
      expect.objectContaining({ type: 'userMessage', message: added, threadStatus: 'to_verify' }),
      expect.objectContaining({
        type: 'accepted',
        acceptedAt: '2026-09-13T10:01:30.000Z',
        threadStatus: 'to_verify',
      }),
      expect.objectContaining({
        type: 'toVerify',
        toVerifyAt: '2026-09-13T10:02:00.000Z',
        threadStatus: 'to_verify',
      }),
    ]);
  });

  it('attaches the thread workflow status so agents can tell tasks from questions', () => {
    const openThread = thread([message('message-1', 'a question')]);

    const assignedThread = thread([message('message-2', 'a task')], {
      acceptedAt: '2026-09-13T10:05:00.000Z',
    });
    const readyThread = {
      ...thread([message('message-3', 'follow-up on finished work')], {
        acceptedAt: '2026-09-13T10:05:00.000Z',
      }),
      readyAt: '2026-09-13T10:06:00.000Z',
    };

    const events = findAgentReviewEvents([], [openThread, assignedThread, readyThread]);

    expect(events.map((event) => [event.type, event.threadStatus])).toEqual([
      ['userMessage', 'open'],
      ['userMessage', 'accepted'],
      ['accepted', 'accepted'],
      ['userMessage', 'ready'],
      ['accepted', 'ready'],
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

  it('ignores messages and status transitions in closed or resolved threads', () => {
    const existing = message('message-1', 'before');
    const added = message('message-2', 'new');
    expect(
      findAgentReviewEvents(
        [thread([existing])],
        [
          {
            ...thread([existing, added]),
            closedAt: '2026-09-13T10:05:00.000Z',
          },
        ],
      ),
    ).toEqual([]);

    expect(
      findAgentReviewEvents(
        [thread([existing])],
        [
          {
            ...thread([existing, added], { acceptedAt: '2026-09-13T10:05:00.000Z' }),
            resolvedAt: '2026-09-13T10:05:00.000Z',
          },
        ],
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

  it('resets debounce window when new comments are added so multiple comments are batched', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(async () => undefined);
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 100,
      sendWake,
    });
    await inbox.initialize();

    // User writes comment 1
    await inbox.recordChanges([], [thread([message('message-1', 'first')])]);
    // 60ms pass (less than debounceMs 100)
    await vi.advanceTimersByTimeAsync(60);
    expect(sendWake).not.toHaveBeenCalled();

    // User writes comment 2 -> should reset debounce timer for another 100ms
    await inbox.recordChanges(
      [thread([message('message-1', 'first')])],
      [thread([message('message-1', 'first'), message('message-2', 'second')])],
    );

    // Another 60ms pass (120ms since comment 1, but only 60ms since comment 2)
    await vi.advanceTimersByTimeAsync(60);
    expect(sendWake).not.toHaveBeenCalled();

    // Another 40ms pass (100ms since comment 2) -> timer fires
    await vi.advanceTimersByTimeAsync(40);
    await inbox.flush();
    expect(sendWake).toHaveBeenCalledTimes(1);

    const batch = await inbox.getBatch();
    expect(batch.events).toHaveLength(2);
    expect(batch.events.map((e) => e.seq)).toEqual([1, 2]);
    inbox.dispose();
  });

  it('prunes pending events and cancels scheduled wake when a thread is closed', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(async () => undefined);
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 100,
      sendWake,
    });
    await inbox.initialize();

    const openThread = thread([message('message-1', 'need fix')]);
    await inbox.recordChanges([], [openThread]);
    expect((await inbox.getBatch()).events).toHaveLength(1);

    // User closes the thread before the debounce timer fires
    await vi.advanceTimersByTimeAsync(30);
    const closedThread = { ...openThread, closedAt: '2026-09-13T10:05:00.000Z' };
    await inbox.recordChanges([openThread], [closedThread]);

    // Timer window expires
    await vi.advanceTimersByTimeAsync(200);
    await inbox.flush();

    // No wake should have been sent, and inbox should be empty
    expect(sendWake).not.toHaveBeenCalled();
    expect((await inbox.getBatch()).events).toHaveLength(0);
    inbox.dispose();
  });

  it('prunes closed thread events while preserving open thread events', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(async () => undefined);
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 100,
      sendWake,
    });
    await inbox.initialize();

    const thread1 = { ...thread([message('m-1', 'comment 1')]), id: 't-1' };
    const thread2 = { ...thread([message('m-2', 'comment 2')]), id: 't-2' };
    await inbox.recordChanges([], [thread1, thread2]);
    expect((await inbox.getBatch()).events).toHaveLength(2);

    // User closes thread 1
    const closedThread1 = { ...thread1, closedAt: '2026-09-13T10:05:00.000Z' };
    await inbox.recordChanges([thread1, thread2], [closedThread1, thread2]);

    // Wait for debounce timer to fire
    await vi.advanceTimersByTimeAsync(150);
    await inbox.flush();

    // Wake should be sent containing only thread 2
    expect(sendWake).toHaveBeenCalledTimes(1);
    const batch = await inbox.getBatch();
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ threadId: 't-2' });
    inbox.dispose();
  });

  it('delivers the wake immediately on manual flush, bypassing the debounce', async () => {
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
      debounceMs: 60_000,
      sendWake,
    });
    await inbox.initialize();

    await inbox.recordChanges([], [thread([message('message-1', 'first')])]);
    const result = await inbox.deliverNow();
    expect(sendWake).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pendingCount: 1, woke: true });

    // No wake should fire from the debounce window itself
    await vi.advanceTimersByTimeAsync(60_000);
    await inbox.flush();
    expect(sendWake).toHaveBeenCalledTimes(1);

    // Repeated manual flushes use unique local IDs so HAPI does not dedupe them
    await inbox.deliverNow();
    expect(sendWake).toHaveBeenCalledTimes(2);
    const localIds = sendWake.mock.calls.map((call) => call[2]);
    expect(localIds[0]).toBe('difit-wake:review-1:4966:1:manual-1');
    expect(localIds[1]).toBe('difit-wake:review-1:4966:1:manual-2');
    inbox.dispose();
  });

  it('re-pings on manual flush even while a wake is outstanding', async () => {
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
      retryMs: 5 * 60_000,
      sendWake,
    });
    await inbox.initialize();

    await inbox.recordChanges([], [thread([message('message-1', 'first')])]);
    await vi.advanceTimersByTimeAsync(10);
    await inbox.flush();
    expect(sendWake).toHaveBeenCalledTimes(1);

    const result = await inbox.deliverNow();
    expect(result).toEqual({ pendingCount: 1, woke: true });
    expect(sendWake).toHaveBeenCalledTimes(2);
    expect(sendWake.mock.calls[1][2]).toBe('difit-wake:review-1:4966:1:manual-1');
    inbox.dispose();
  });

  it('reports pending count and wake availability in status', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(async () => undefined);
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 10,
      sendWake,
    });
    await inbox.initialize();

    expect(inbox.getStatus()).toEqual({
      pendingCount: 0,
      wakeAvailable: true,
      wakeOutstanding: false,
    });

    await inbox.recordChanges([], [thread([message('message-1', 'first')])]);
    expect(inbox.getStatus().pendingCount).toBe(1);
    // A debounce timer is scheduled 10ms out, exposed for the viewer countdown
    const scheduledAt = inbox.getStatus().wakeScheduledAt;
    expect(Date.parse(scheduledAt ?? '') - Date.now()).toBe(10);

    await vi.advanceTimersByTimeAsync(10);
    await inbox.flush();
    expect(inbox.getStatus().wakeOutstanding).toBe(true);
    // While the wake is outstanding only the retry timer runs, which is not counted down
    expect(inbox.getStatus().wakeScheduledAt).toBeUndefined();
    inbox.dispose();

    const detached = new AgentEventInbox({
      reviewId: 'review-2',
      port: 4967,
      configDirectory: directory,
      debounceMs: 10,
      sendWake,
    });
    await detached.initialize();
    expect(detached.getStatus()).toMatchObject({ pendingCount: 0, wakeAvailable: false });
    detached.dispose();
  });

  it('returns woke false on manual flush without a session or pending events', async () => {
    vi.useFakeTimers();
    const directory = await fs.mkdtemp(join(tmpdir(), 'difit-agent-events-'));
    temporaryDirectories.push(directory);
    const sendWake = vi.fn(async () => undefined);
    const inbox = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      configDirectory: directory,
      debounceMs: 10,
      sendWake,
    });
    await inbox.initialize();

    expect(await inbox.deliverNow()).toEqual({ pendingCount: 0, woke: false });

    const pending = new AgentEventInbox({
      reviewId: 'review-1',
      port: 4966,
      hapiSessionId: 'hapi-session',
      configDirectory: directory,
      debounceMs: 10,
      sendWake,
    });
    await pending.initialize();
    await pending.recordChanges([], [thread([message('message-1', 'first')])]);
    expect(await pending.deliverNow()).toEqual({ pendingCount: 1, woke: true });
    pending.dispose();
    expect(sendWake).toHaveBeenCalledTimes(1);
    inbox.dispose();
  });
});
