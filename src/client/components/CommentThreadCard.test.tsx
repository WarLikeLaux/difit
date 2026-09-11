import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CommentThread } from '../../types/diff';
import { copyTextToClipboard } from '../utils/clipboard';

import { CommentThreadCard } from './CommentThreadCard';

vi.mock('../utils/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

const mockThread: CommentThread = {
  id: 'thread-1',
  file: 'src/client/components/CommentThreadCard.tsx',
  line: 80,
  side: 'new',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  codeContent: 'const value = 1;',
  messages: [
    {
      id: 'message-1',
      body: 'Root comment',
      author: 'User',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'message-2',
      body: 'Reply comment',
      author: 'Reviewer',
      createdAt: '2024-01-01T00:01:00Z',
      updatedAt: '2024-01-01T00:01:00Z',
    },
  ],
};

describe('CommentThreadCard', () => {
  it('shows missing authors as Agent when author badges are enabled', () => {
    render(
      <CommentThreadCard
        thread={{
          ...mockThread,
          messages: [
            { ...mockThread.messages[0]!, author: undefined },
            { ...mockThread.messages[1]!, author: 'User' },
          ],
        }}
        showAuthorBadges
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('copies the file path with its first line', async () => {
    const user = userEvent.setup();
    vi.mocked(copyTextToClipboard).mockClear();

    render(
      <CommentThreadCard
        thread={{ ...mockThread, line: [80, 83] }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy File' }));

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'src/client/components/CommentThreadCard.tsx:80',
    );
  });

  it('links a thread to the matching GitLab diff line in a new tab', async () => {
    render(
      <CommentThreadCard
        thread={{ ...mockThread, file: 'src/services/logger.ts', line: 60 }}
        reviewUrl="https://gitlab.example.com/group/project/-/merge_requests/123"
        gitLabLine="A60"
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    const link = await screen.findByRole('link', { name: 'Open Link' });
    expect(link).toHaveAttribute(
      'href',
      'https://gitlab.example.com/group/project/-/merge_requests/123/diffs?file_path=src%2Fservices%2Flogger.ts#line_f1536cbbf_A60',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not show delete action for replies authored by someone else', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('Reply comment')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete reply')).not.toBeInTheDocument();
  });

  it('keeps resolve available for root comments even when not authored by the user', () => {
    render(
      <CommentThreadCard
        thread={{
          ...mockThread,
          messages: [
            {
              ...mockThread.messages[0]!,
              author: 'Reviewer',
            },
          ],
        }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
    expect(screen.queryByTitle('Edit message')).not.toBeInTheDocument();
  });

  it('shows an inline confirmation before resolving a root comment by default', async () => {
    const user = userEvent.setup();
    const onRemoveThread = vi.fn();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={onRemoveThread}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Resolve thread'));

    expect(onRemoveThread).not.toHaveBeenCalled();
    expect(screen.getByText('Resolve?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolve' }));

    expect(onRemoveThread).toHaveBeenCalledWith('thread-1');
  });

  it('cancels the inline resolve confirmation with the cancel button', async () => {
    const user = userEvent.setup();
    const onRemoveThread = vi.fn();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={onRemoveThread}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Resolve thread'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onRemoveThread).not.toHaveBeenCalled();
    expect(screen.queryByText('Resolve?')).not.toBeInTheDocument();
    expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
  });

  it('cancels the inline resolve confirmation with Escape', async () => {
    const user = userEvent.setup();
    const onRemoveThread = vi.fn();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={onRemoveThread}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Resolve thread'));
    await user.keyboard('{Escape}');

    expect(onRemoveThread).not.toHaveBeenCalled();
    expect(screen.queryByText('Resolve?')).not.toBeInTheDocument();
  });

  it('consumes Escape so surrounding Escape handlers do not fire', async () => {
    const user = userEvent.setup();
    const outerKeyDown = vi.fn();
    document.addEventListener('keydown', outerKeyDown);

    try {
      render(
        <CommentThreadCard
          thread={mockThread}
          onGeneratePrompt={() => 'thread prompt'}
          onRemoveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );

      await user.click(screen.getByTitle('Resolve thread'));
      await user.keyboard('{Escape}');

      expect(screen.queryByText('Resolve?')).not.toBeInTheDocument();
      expect(outerKeyDown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outerKeyDown);
    }
  });

  it('cancels the inline resolve confirmation when clicking outside', async () => {
    const user = userEvent.setup();
    const onRemoveThread = vi.fn();

    render(
      <div>
        <button type="button">outside</button>
        <CommentThreadCard
          thread={mockThread}
          onGeneratePrompt={() => 'thread prompt'}
          onRemoveThread={onRemoveThread}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />
      </div>,
    );

    await user.click(screen.getByTitle('Resolve thread'));
    await user.click(screen.getByRole('button', { name: 'outside' }));

    expect(onRemoveThread).not.toHaveBeenCalled();
    expect(screen.queryByText('Resolve?')).not.toBeInTheDocument();
  });

  it('resolves immediately without confirmation when confirmRootAction is false', async () => {
    const user = userEvent.setup();
    const onRemoveThread = vi.fn();

    render(
      <CommentThreadCard
        thread={mockThread}
        confirmRootAction={false}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={onRemoveThread}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Resolve thread'));

    expect(screen.queryByText('Resolve?')).not.toBeInTheDocument();
    expect(onRemoveThread).toHaveBeenCalledWith('thread-1');
  });

  it('collapses the thread into a single line and expands it back', async () => {
    const user = userEvent.setup();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse thread' }));

    // Messages and actions are hidden; a one-line summary with the count remains
    expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
    expect(screen.queryByText(/Copy Prompt/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Resolve thread')).not.toBeInTheDocument();
    expect(screen.getByText('Root comment')).toBeInTheDocument();
    expect(screen.getByLabelText('2 messages in thread')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand thread' }));

    expect(screen.getByText('Reply comment')).toBeInTheDocument();
    expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
  });

  it('shows resolved threads collapsed by default', () => {
    render(
      <CommentThreadCard
        thread={{ ...mockThread, resolvedAt: '2026-09-11T00:00:00.000Z' }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Expand thread' })).toBeInTheDocument();
    expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });

  it('expands a collapsed thread by clicking the summary line', async () => {
    const user = userEvent.setup();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse thread' }));
    await user.click(screen.getByText('Root comment'));

    expect(screen.getByText('Reply comment')).toBeInTheDocument();
  });

  it('does not trigger the card click when toggling collapse', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
        onClick={onClick}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse thread' }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the "Outdated" badge when the thread is marked outdated', () => {
    render(
      <CommentThreadCard
        thread={{ ...mockThread, isOutdated: true }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    const badge = screen.getByLabelText('Outdated comment');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Outdated');
    expect(badge).toHaveAttribute('title', 'Code has changed since this comment was made');
  });

  it('does not render the "Outdated" badge when the thread is up to date', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
  });

  it('always shows an inline reply trigger below the last message', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Write a reply...' })).toBeInTheDocument();
  });

  it('expands the reply trigger into a reply form and submits a reply', async () => {
    const user = userEvent.setup();
    const onReplyToThread = vi.fn().mockResolvedValue(undefined);

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={onReplyToThread}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Write a reply...' }));

    const textarea = screen.getByPlaceholderText('Write a reply...');
    expect(textarea).toHaveFocus();

    await user.type(textarea, 'A new reply');
    await user.click(screen.getByRole('button', { name: 'Reply' }));

    expect(onReplyToThread).toHaveBeenCalledWith('thread-1', 'A new reply');
    // Collapses back to the trigger after submitting
    expect(screen.getByRole('button', { name: 'Write a reply...' })).toBeInTheDocument();
  });

  it('collapses the reply form back to the trigger on cancel', async () => {
    const user = userEvent.setup();

    render(
      <CommentThreadCard
        thread={mockThread}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Write a reply...' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByPlaceholderText('Write a reply...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write a reply...' })).toBeInTheDocument();
  });

  it('shows an inline confirmation before deleting a user-authored reply', async () => {
    const user = userEvent.setup();
    const onRemoveMessage = vi.fn();

    render(
      <CommentThreadCard
        thread={{
          ...mockThread,
          messages: [
            mockThread.messages[0]!,
            {
              ...mockThread.messages[1]!,
              author: 'User',
            },
          ],
        }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={onRemoveMessage}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Delete reply'));

    expect(onRemoveMessage).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onRemoveMessage).toHaveBeenCalledWith('thread-1', 'message-2');
  });

  it('shows the last user message and every later reply by default', async () => {
    const user = userEvent.setup();
    const replies = [
      { id: 'old-agent', body: 'Old agent reply', author: 'Agent' },
      { id: 'last-user', body: 'Latest user question', author: 'User' },
      { id: 'agent-1', body: 'First agent answer', author: 'Agent' },
      { id: 'agent-2', body: 'Second agent answer', author: 'Agent' },
    ].map((message, index) => ({
      ...message,
      createdAt: `2024-01-01T00:0${index + 1}:00Z`,
      updatedAt: `2024-01-01T00:0${index + 1}:00Z`,
    }));

    render(
      <CommentThreadCard
        thread={{ ...mockThread, messages: [mockThread.messages[0]!, ...replies] }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.queryByText('Old agent reply')).not.toBeInTheDocument();
    expect(screen.getByText('Latest user question')).toBeInTheDocument();
    expect(screen.getByText('First agent answer')).toBeInTheDocument();
    expect(screen.getByText('Second agent answer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show 1 earlier reply' }));
    expect(screen.getByText('Old agent reply')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show latest conversation' }));
    expect(screen.queryByText('Old agent reply')).not.toBeInTheDocument();
    expect(screen.getByText('Second agent answer')).toBeInTheDocument();
  });

  it('keeps the previous reply visible when the latest user message has no answer yet', () => {
    render(
      <CommentThreadCard
        thread={{
          ...mockThread,
          messages: [
            mockThread.messages[0]!,
            {
              id: 'older-agent',
              body: 'Older agent context',
              author: 'Agent',
              createdAt: '2024-01-01T00:01:00Z',
              updatedAt: '2024-01-01T00:01:00Z',
            },
            {
              id: 'latest-user',
              body: 'Latest unanswered question',
              author: 'User',
              createdAt: '2024-01-01T00:02:00Z',
              updatedAt: '2024-01-01T00:02:00Z',
            },
          ],
        }}
        onGeneratePrompt={() => 'thread prompt'}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('Older agent context')).toBeInTheDocument();
    expect(screen.getByText('Latest unanswered question')).toBeInTheDocument();
  });
});
