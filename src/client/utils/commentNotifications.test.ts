import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffCommentThread } from '../../types/diff';

import { findNewExternalMessages, showExternalMessageNotification } from './commentNotifications';

function thread(id: string, messages: Array<{ id: string; author?: string }>): DiffCommentThread {
  return {
    id,
    filePath: 'src/example.ts',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    position: { side: 'new', line: 1 },
    messages: messages.map((message) => ({
      ...message,
      body: message.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  };
}

describe('findNewExternalMessages', () => {
  it('returns a newly imported agent reply', () => {
    const current = [thread('thread-1', [{ id: 'user-1', author: 'User' }])];
    const next = [
      thread('thread-1', [
        { id: 'user-1', author: 'User' },
        { id: 'agent-1', author: 'Agent' },
      ]),
    ];

    expect(findNewExternalMessages(current, next).map((message) => message.id)).toEqual([
      'agent-1',
    ]);
  });

  it('does not treat the user own comment as an external reply', () => {
    expect(
      findNewExternalMessages([], [thread('thread-1', [{ id: 'user-1', author: 'User' }])]),
    ).toEqual([]);
  });

  it('treats author-less CLI imports as external replies', () => {
    expect(
      findNewExternalMessages([], [thread('thread-1', [{ id: 'agent-1' }])]).map(
        (message) => message.id,
      ),
    ).toEqual(['agent-1']);
  });
});

describe('showExternalMessageNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('notifies for an external reply', () => {
    const notificationConstructor = vi.fn();
    class NotificationMock {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      close = vi.fn();

      constructor(title: string, options?: NotificationOptions) {
        notificationConstructor(title, options);
      }
    }
    vi.stubGlobal('Notification', NotificationMock);

    const message = thread('thread-1', [{ id: 'agent-1', author: 'Agent' }]).messages[0]!;
    showExternalMessageNotification([message]);

    expect(notificationConstructor).toHaveBeenCalledWith('New agent reply in difit', {
      body: 'agent-1',
      tag: 'difit-comment-agent-1',
    });
  });

  it('does not notify without permission', () => {
    const NotificationMock = vi.fn();
    Object.assign(NotificationMock, { permission: 'denied' });
    vi.stubGlobal('Notification', NotificationMock);

    const message = thread('thread-1', [{ id: 'agent-1', author: 'Agent' }]).messages[0]!;
    showExternalMessageNotification([message]);

    expect(NotificationMock).not.toHaveBeenCalled();
  });
});
