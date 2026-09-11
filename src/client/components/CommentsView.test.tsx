import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { CommentThread } from '../../types/diff';

import { CommentsView } from './CommentsView';

vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: vi.fn(),
  useHotkeysContext: vi.fn(() => ({
    enableScope: vi.fn(),
    disableScope: vi.fn(),
  })),
  HotkeysProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockThreads: CommentThread[] = [
  {
    id: 'thread-1',
    file: 'src/file1.ts',
    line: 10,
    side: 'new',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    codeContent: 'const value = 1;',
    messages: [
      {
        id: 'thread-1',
        body: 'First root comment',
        author: 'User',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'reply-1',
        body: 'First reply',
        author: 'Reviewer',
        createdAt: '2024-01-01T00:01:00Z',
        updatedAt: '2024-01-01T00:01:00Z',
      },
    ],
  },
  {
    id: 'thread-2',
    file: 'src/file2.ts',
    line: [20, 25],
    side: 'new',
    createdAt: '2024-01-01T00:02:00Z',
    updatedAt: '2024-01-01T00:02:00Z',
    messages: [
      {
        id: 'thread-2',
        body: 'Second root comment',
        author: 'User',
        createdAt: '2024-01-01T00:02:00Z',
        updatedAt: '2024-01-01T00:02:00Z',
      },
    ],
  },
];

const mockRemoveThread = vi.fn();
const mockGenerateThreadPrompt = vi.fn().mockReturnValue('thread prompt');
const mockReplyToThread = vi.fn().mockResolvedValue(undefined);
const mockRemoveMessage = vi.fn();
const mockUpdateMessage = vi.fn();

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <HotkeysProvider initiallyActiveScopes={['global']}>{children}</HotkeysProvider>
);

describe('CommentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders thread content', () => {
    render(
      <CommentsView
        comments={mockThreads}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    expect(screen.getByText('Comments')).toBeInTheDocument();
    expect(screen.getByText('First root comment')).toBeInTheDocument();
    expect(screen.getByText('First reply')).toBeInTheDocument();
    expect(screen.getByText('Second root comment')).toBeInTheDocument();
    expect(screen.getByText('src/file1.ts:10')).toBeInTheDocument();
    expect(screen.getByText('src/file2.ts:20-25')).toBeInTheDocument();
    expect(screen.getByLabelText('Comment threads')).toHaveClass('xl:columns-2');
  });

  it('shows author badges when enabled', () => {
    render(
      <CommentsView
        comments={mockThreads}
        showAuthorBadges={true}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    expect(screen.getAllByText('User').length).toBeGreaterThan(0);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });

  it('keeps resolved threads whose file is no longer in the diff visible', async () => {
    const user = userEvent.setup();
    const orphanedThread: CommentThread = {
      ...mockThreads[0]!,
      id: 'orphaned-thread',
      resolvedAt: '2026-09-11T00:00:00.000Z',
      isOutdated: true,
      isOrphaned: true,
    };

    render(
      <CommentsView
        comments={[orphanedThread]}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole('button', { name: 'Resolved (1)' }));
    expect(screen.getByText('First root comment')).toBeInTheDocument();
    expect(screen.getByLabelText('File not in diff')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Resolve thread')).not.toBeInTheDocument();
  });

  it('filters open and resolved threads separately', async () => {
    const user = userEvent.setup();
    const resolvedThread: CommentThread = {
      ...mockThreads[1]!,
      resolvedAt: '2026-09-11T00:00:00.000Z',
    };

    render(
      <CommentsView
        comments={[mockThreads[0]!, resolvedThread]}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole('button', { name: 'Open (1)' }));
    expect(screen.getByText('First root comment')).toBeInTheDocument();
    expect(screen.queryByText('Second root comment')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolved (1)' }));
    expect(screen.queryByText('First root comment')).not.toBeInTheDocument();
    expect(screen.getByText('Second root comment')).toBeInTheDocument();
  });

  it('keeps accepted threads separate from open work', async () => {
    const user = userEvent.setup();
    const acceptedThread: CommentThread = {
      ...mockThreads[1]!,
      acceptedAt: '2026-09-11T00:00:00.000Z',
    };

    render(
      <CommentsView
        comments={[mockThreads[0]!, acceptedThread]}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    expect(screen.getByText('First root comment')).toBeInTheDocument();
    expect(screen.queryByText('Second root comment')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accepted (1)' }));
    expect(screen.getByText('Second root comment')).toBeInTheDocument();
  });

  it('provides thread workflow, navigation, deletion, and reply visibility controls', async () => {
    const user = userEvent.setup();
    const onDeleteThread = vi.fn();
    const onThreadStatusChange = vi.fn();
    const onNavigateToCode = vi.fn();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    render(
      <CommentsView
        comments={[mockThreads[0]!]}
        onRemoveThread={mockRemoveThread}
        onDeleteThread={onDeleteThread}
        onThreadStatusChange={onThreadStatusChange}
        onNavigateToCode={onNavigateToCode}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Thread status' }), 'accepted');
    expect(onThreadStatusChange).toHaveBeenCalledWith('thread-1', 'accepted');

    await user.click(screen.getByRole('button', { name: 'Go to Code' }));
    expect(onNavigateToCode).toHaveBeenCalledWith(mockThreads[0]);

    await user.click(screen.getByRole('button', { name: 'Hide replies' }));
    expect(screen.queryByText('First reply')).not.toBeInTheDocument();
    expect(screen.getByText('1 replies hidden')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete thread' }));
    expect(onDeleteThread).toHaveBeenCalledWith('thread-1');
  });

  it('orders threads by their latest message', () => {
    const recentlyRepliedThread: CommentThread = {
      ...mockThreads[0]!,
      messages: [
        ...mockThreads[0]!.messages,
        {
          id: 'latest-reply',
          body: 'Latest reply',
          author: 'Reviewer',
          createdAt: '2024-01-01T00:03:00Z',
          updatedAt: '2024-01-01T00:03:00Z',
        },
      ],
    };
    render(
      <CommentsView
        comments={[recentlyRepliedThread, mockThreads[1]!]}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    const threadLocations = screen.getAllByText(/^src\/file\d\.ts:/);
    expect(threadLocations.map((location) => location.textContent)).toEqual([
      'src/file1.ts:10',
      'src/file2.ts:20-25',
    ]);
  });

  it('keeps the comments view open when clicking inside the reply form', async () => {
    const user = userEvent.setup();

    render(
      <CommentsView
        comments={mockThreads}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    await user.click(screen.getAllByRole('button', { name: 'Write a reply...' })[0]!);
    await user.click(screen.getByPlaceholderText('Write a reply...'));

    expect(screen.getByText('Reply to thread')).toBeInTheDocument();
  });

  it('keeps the comments view open when cancelling message editing', async () => {
    const user = userEvent.setup();

    render(
      <CommentsView
        comments={mockThreads}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    await user.click(screen.getAllByTitle('Edit message')[0]!);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('First root comment')).toBeInTheDocument();
  });

  it('uses the comments view resolve handler from the resolve button', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);

    render(
      <CommentsView
        comments={mockThreads}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    await user.click(screen.getAllByTitle('Resolve thread')[0]!);

    expect(confirmSpy).toHaveBeenCalledWith('Resolve this thread?\n\n"Second root comment"');
    expect(mockRemoveThread).not.toHaveBeenCalled();
  });

  it('shows empty state when there are no threads', () => {
    render(
      <CommentsView
        comments={[]}
        onRemoveThread={mockRemoveThread}
        onGenerateThreadPrompt={mockGenerateThreadPrompt}
        onReplyToThread={mockReplyToThread}
        onRemoveMessage={mockRemoveMessage}
        onUpdateMessage={mockUpdateMessage}
      />,
      { wrapper },
    );

    expect(screen.getByText('No open threads')).toBeInTheDocument();
  });
});
