import { render, waitFor } from '@testing-library/react';
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
