import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CommentThread, DiffFile } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';

import { DiffViewer } from './DiffViewer';

const file: DiffFile = {
  path: 'large.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  chunks: [
    {
      header: '@@ -10,0 +10 @@',
      oldStart: 10,
      oldLines: 0,
      newStart: 10,
      newLines: 1,
      lines: [{ type: 'add', content: 'changed', newLineNumber: 10 }],
    },
  ],
};

const mergedChunks: MergedChunk[] = [
  {
    ...file.chunks[0]!,
    originalIndices: [0],
    hiddenLinesBefore: 9,
    hiddenLinesAfter: 990,
  },
];

const createThread = (line: number): CommentThread => ({
  id: `thread-${line}`,
  file: file.path,
  line,
  side: 'new',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  messages: [
    {
      id: `message-${line}`,
      body: 'Review comment',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
  ],
});

type ExpandLines = (
  file: DiffFile,
  chunkIndex: number,
  direction: 'up' | 'down',
  count?: number,
) => Promise<void>;

const renderViewer = (thread: CommentThread, expandLines: ExpandLines) =>
  render(
    <WordHighlightProvider>
      <DiffViewer
        file={file}
        threads={[thread]}
        diffMode="unified"
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        collapsedFiles={new Set()}
        onToggleCollapsed={vi.fn()}
        onToggleAllCollapsed={vi.fn()}
        onAddComment={vi.fn().mockResolvedValue(undefined)}
        onGenerateThreadPrompt={vi.fn()}
        onRemoveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
        baseCommitish="HEAD^"
        targetCommitish="HEAD"
        mergedChunks={mergedChunks}
        expandLines={expandLines}
        expandAllBetweenChunks={vi.fn().mockResolvedValue(undefined)}
        prefetchFileContent={vi.fn().mockResolvedValue(undefined)}
        isExpandLoading={false}
      />
    </WordHighlightProvider>,
  );

describe('DiffViewer comment context expansion', () => {
  it('does not expand a large gap for a distant comment', async () => {
    const expandLines = vi.fn<ExpandLines>().mockResolvedValue(undefined);
    renderViewer(createThread(900), expandLines);

    await waitFor(() => expect(expandLines).not.toHaveBeenCalled());
  });

  it('expands only nearby context needed to reveal a comment', async () => {
    const expandLines = vi.fn<ExpandLines>().mockResolvedValue(undefined);
    renderViewer(createThread(15), expandLines);

    await waitFor(() => {
      expect(expandLines).toHaveBeenCalledWith(file, 0, 'down', 8);
    });
  });
});
