import { render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';

import type { CommentThread } from '../../types/diff';

import { CodePreviewModal } from './CodePreviewModal';

const thread: CommentThread = {
  id: 'thread-1',
  file: 'src/example.ts',
  line: 42,
  side: 'new',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  messages: [],
};

describe('CodePreviewModal', () => {
  it('waits for the full file before rendering and scrolling the diff', async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      const view = render(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <CodePreviewModal
            thread={thread}
            targetPosition={{ fileIndex: 0, chunkIndex: 1, lineIndex: 2, side: 'right' }}
            isLoading={true}
            onClose={vi.fn()}
          >
            <div id="file-0-chunk-1-line-2-right">target</div>
          </CodePreviewModal>
        </HotkeysProvider>,
      );

      expect(screen.getByRole('status')).toHaveTextContent('Loading full file…');
      expect(screen.queryByText('target')).not.toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();

      view.rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <CodePreviewModal
            thread={thread}
            targetPosition={{ fileIndex: 0, chunkIndex: 1, lineIndex: 2, side: 'right' }}
            isLoading={false}
            onClose={vi.fn()}
          >
            <div id="file-0-chunk-1-line-2-right">target</div>
          </CodePreviewModal>
        </HotkeysProvider>,
      );

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByText('target')).toBeInTheDocument();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('scrolls the split-view side cell into view', async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      render(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <CodePreviewModal
            thread={thread}
            targetPosition={{ fileIndex: 0, chunkIndex: 1, lineIndex: 2, side: 'right' }}
            isLoading={false}
            onClose={vi.fn()}
          >
            <div id="file-0-chunk-1-line-2-right">target</div>
          </CodePreviewModal>
        </HotkeysProvider>,
      );

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
      });
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
