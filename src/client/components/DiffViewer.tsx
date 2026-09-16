import React, { useState, useEffect, useRef, useCallback, memo } from 'react';

import {
  type DiffFile,
  type DiffViewMode,
  type DiffSide,
  type CommentThread,
  type CommentThreadStatus,
  type LineNumber,
} from '../../types/diff';
import { FileLevelTokensProvider } from '../contexts/FileLevelTokensContext';
import { type CursorPosition } from '../hooks/keyboardNavigation';
import { type MergedChunk } from '../hooks/useExpandedLines';
import { useFileLevelTokens } from '../hooks/useFileLevelTokens';
import { isWholeFileHighlightExtension } from '../utils/languageDetection';
import { getViewerForFile } from '../viewers/registry';
import type { DiffViewerBodyProps } from '../viewers/types';

import { DiffViewerHeader } from './DiffViewerHeader';
import type { AppearanceSettings } from './SettingsModal';

interface DiffViewerProps {
  file: DiffFile;
  threads: CommentThread[];
  showAuthorBadges?: boolean;
  reviewUrl?: string;
  diffMode: DiffViewMode;
  reviewedFiles: Set<string>;
  isChangedSinceViewed?: boolean;
  onToggleReviewed: (path: string) => void;
  collapsedFiles: Set<string>;
  onToggleCollapsed: (path: string) => void;
  onToggleAllCollapsed: (shouldCollapse: boolean) => void;
  onAddComment: (
    file: string,
    line: LineNumber,
    body: string,
    codeContent?: string,
    side?: DiffSide,
  ) => Promise<void>;
  onGenerateThreadPrompt: (thread: CommentThread) => string;
  onRemoveThread: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onThreadStatusChange?: (threadId: string, status: CommentThreadStatus) => void;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  onOpenInEditor?: (filePath: string, lineNumber: number) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  baseCommitish?: string;
  targetCommitish?: string;
  cursor?: CursorPosition | null;
  isFocused?: boolean;
  fileIndex?: number;
  mergedChunks: MergedChunk[];
  expandLines: (
    file: DiffFile,
    chunkIndex: number,
    direction: 'up' | 'down',
    count?: number,
  ) => Promise<void>;
  expandAllBetweenChunks: (
    file: DiffFile,
    chunkIndex: number,
    hiddenLines: number,
  ) => Promise<void>;
  prefetchFileContent: (file: DiffFile) => Promise<void>;
  isExpandLoading: boolean;
  onLineClick?: (
    fileIndex: number,
    chunkIndex: number,
    lineIndex: number,
    side: 'left' | 'right',
  ) => void;
  commentTrigger?: {
    fileIndex: number;
    chunkIndex: number;
    lineIndex: number;
  } | null;
  onCommentTriggerHandled?: () => void;
  diffVersion?: number;
}

type LineRange = { start: number; end: number };
type ChunkRange = LineRange & { index: number };
type Gap = {
  type: 'before' | 'between' | 'after';
  start: number;
  end: number;
  nextChunkIndex?: number;
  prevChunkIndex?: number;
};

const AUTO_EXPAND_COMMENT_CONTEXT = 3;
const MAX_AUTO_EXPAND_COMMENT_LINES = 40;

const normalizeCommentRanges = (threads: CommentThread[]): Record<DiffSide, LineRange[]> => {
  const ranges: Record<DiffSide, LineRange[]> = { old: [], new: [] };

  threads.forEach((thread) => {
    const side = thread.side ?? 'new';
    const [start, end] = Array.isArray(thread.line)
      ? [thread.line[0], thread.line[1]]
      : [thread.line, thread.line];

    if (start <= 0 || end <= 0) return;

    ranges[side].push({
      start: Math.min(start, end),
      end: Math.max(start, end),
    });
  });

  return ranges;
};

const buildChunkRanges = (file: DiffFile, side: DiffSide): ChunkRange[] =>
  file.chunks
    .map((chunk, index) => {
      const start = side === 'old' ? chunk.oldStart : chunk.newStart;
      const lines = side === 'old' ? chunk.oldLines : chunk.newLines;
      if (!start || lines <= 0) return null;
      return { start, end: start + lines - 1, index };
    })
    .filter((range): range is ChunkRange => !!range);

const buildGaps = (ranges: ChunkRange[]): Gap[] => {
  const gaps: Gap[] = [];
  const firstRange = ranges[0];
  if (!firstRange) return gaps;

  if (firstRange.start > 1) {
    gaps.push({
      type: 'before',
      start: 1,
      end: firstRange.start - 1,
      nextChunkIndex: firstRange.index,
    });
  }

  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1];
    const current = ranges[i];
    if (!prev || !current) continue;
    if (current.start > prev.end + 1) {
      gaps.push({
        type: 'between',
        start: prev.end + 1,
        end: current.start - 1,
        prevChunkIndex: prev.index,
        nextChunkIndex: current.index,
      });
    }
  }

  const last = ranges[ranges.length - 1];
  if (!last) return gaps;
  gaps.push({
    type: 'after',
    start: last.end + 1,
    end: Number.POSITIVE_INFINITY,
    prevChunkIndex: last.index,
  });

  return gaps;
};

const buildMergedChunkIndex = (mergedChunks: MergedChunk[]) => {
  const mergedByFirstIndex = new Map<number, MergedChunk>();
  mergedChunks.forEach((chunk) => {
    const firstIndex = chunk.originalIndices[0];
    if (firstIndex !== undefined) {
      mergedByFirstIndex.set(firstIndex, chunk);
    }
  });
  return mergedByFirstIndex;
};

const getLastChunkIndex = (mergedChunks: MergedChunk[]): number | null => {
  const lastMerged = mergedChunks[mergedChunks.length - 1];
  const lastIndex = lastMerged?.originalIndices[lastMerged.originalIndices.length - 1];
  return lastIndex ?? null;
};

const isCommentRangeVisible = (
  range: LineRange,
  side: DiffSide,
  mergedChunks: MergedChunk[],
): boolean => {
  const visibleLines = new Set<number>();
  mergedChunks.forEach((chunk) => {
    chunk.lines.forEach((line) => {
      const lineNumber = side === 'old' ? line.oldLineNumber : line.newLineNumber;
      if (lineNumber !== undefined) visibleLines.add(lineNumber);
    });
  });

  for (let line = range.start; line <= range.end; line += 1) {
    if (!visibleLines.has(line)) return false;
  }
  return true;
};

const clampAutoExpandCount = (count: number, hiddenLines: number): number | null => {
  const clamped = Math.min(count, hiddenLines);
  return clamped <= MAX_AUTO_EXPAND_COMMENT_LINES ? clamped : null;
};

export const DiffViewer = memo(function DiffViewer({
  file,
  threads,
  showAuthorBadges = false,
  reviewUrl,
  diffMode,
  reviewedFiles,
  isChangedSinceViewed = false,
  onToggleReviewed,
  collapsedFiles,
  onToggleCollapsed,
  onToggleAllCollapsed,
  onAddComment,
  onGenerateThreadPrompt,
  onRemoveThread,
  onDeleteThread,
  onThreadStatusChange,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  onOpenInEditor,
  syntaxTheme,
  baseCommitish,
  targetCommitish,
  cursor = null,
  isFocused = false,
  fileIndex = 0,
  onLineClick,
  commentTrigger,
  onCommentTriggerHandled,
  mergedChunks,
  expandLines,
  expandAllBetweenChunks,
  prefetchFileContent,
  isExpandLoading,
  diffVersion,
}: DiffViewerProps) {
  const isCollapsed = collapsedFiles.has(file.path);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  const viewer = getViewerForFile(file);
  const hasBlobContent = baseCommitish !== 'stdin' && targetCommitish !== 'stdin';
  const canExpandHiddenLines = hasBlobContent && (viewer.canExpandHiddenLines?.(file) ?? false);
  // Tokenize the whole file so embedded blocks (e.g. <script>/<style>) are
  // highlighted by their own language instead of line-by-line, which can't see
  // the surrounding context.
  const wholeFileHighlight = viewer.id === 'default' && isWholeFileHighlightExtension(file.path);

  // Observe visibility for lazy prefetch
  useEffect(() => {
    if (!canExpandHiddenLines) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setIsVisible(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canExpandHiddenLines]);

  // Pre-fetch line counts (lightweight) only for visible, non-collapsed files that can expand
  useEffect(() => {
    if (isVisible && !isCollapsed && canExpandHiddenLines) {
      void prefetchFileContent(file);
    }
  }, [isVisible, isCollapsed, canExpandHiddenLines, file, prefetchFileContent]);

  const handleAddComment = useCallback(
    async (line: LineNumber, body: string, codeContent?: string, side?: DiffSide) => {
      try {
        await onAddComment(file.path, line, body, codeContent, side);
      } catch (error) {
        console.error('Failed to add comment:', error);
      }
    },
    [file.path, onAddComment],
  );

  useEffect(() => {
    if (isCollapsed || isExpandLoading || !canExpandHiddenLines || threads.length === 0) {
      return;
    }

    if (file.chunks.length === 0 || mergedChunks.length === 0) {
      return;
    }

    const commentRangesBySide = normalizeCommentRanges(threads);
    const mergedByFirstIndex = buildMergedChunkIndex(mergedChunks);
    const lastChunkIndex = getLastChunkIndex(mergedChunks);
    const lastMerged = mergedChunks[mergedChunks.length - 1];

    const queued = new Set<string>();
    const queueExpand = (key: string, action: () => void) => {
      if (queued.has(key)) return;
      queued.add(key);
      action();
    };

    (['old', 'new'] as const).forEach((side) => {
      const commentRanges = commentRangesBySide[side];
      if (commentRanges.length === 0) return;

      const ranges = buildChunkRanges(file, side);
      const gaps = buildGaps(ranges);

      gaps.forEach((gap) => {
        const hiddenCommentRanges = commentRanges.filter(
          (range) =>
            range.start <= gap.end &&
            range.end >= gap.start &&
            !isCommentRangeVisible(range, side, mergedChunks),
        );
        if (hiddenCommentRanges.length === 0) return;

        if (gap.type === 'after' && lastMerged && lastChunkIndex !== null) {
          if (lastMerged.hiddenLinesAfter > 0) {
            const counts = hiddenCommentRanges
              .map((range) =>
                clampAutoExpandCount(
                  range.end - gap.start + 1 + AUTO_EXPAND_COMMENT_CONTEXT,
                  lastMerged.hiddenLinesAfter,
                ),
              )
              .filter((count): count is number => count !== null);
            const count = counts.length > 0 ? Math.min(...counts) : null;
            if (count !== null) {
              queueExpand(`after-${lastChunkIndex}`, () => {
                void expandLines(file, lastChunkIndex, 'down', count);
              });
            }
          }
          return;
        }

        const nextChunkIndex = gap.nextChunkIndex;
        if (nextChunkIndex === undefined) return;
        const mergedChunk = mergedByFirstIndex.get(nextChunkIndex);
        if (!mergedChunk || mergedChunk.hiddenLinesBefore <= 0) return;

        if (gap.type === 'before') {
          const counts = hiddenCommentRanges
            .map((range) =>
              clampAutoExpandCount(
                gap.end - range.start + 1 + AUTO_EXPAND_COMMENT_CONTEXT,
                mergedChunk.hiddenLinesBefore,
              ),
            )
            .filter((count): count is number => count !== null);
          const count = counts.length > 0 ? Math.min(...counts) : null;
          if (count !== null) {
            queueExpand(`before-${nextChunkIndex}`, () => {
              void expandLines(file, nextChunkIndex, 'up', count);
            });
          }
        } else if (gap.type === 'between') {
          const previousChunkIndex = gap.prevChunkIndex;
          if (previousChunkIndex === undefined) return;

          const candidates = hiddenCommentRanges.flatMap((range) => {
            const downCount = clampAutoExpandCount(
              range.end - gap.start + 1 + AUTO_EXPAND_COMMENT_CONTEXT,
              mergedChunk.hiddenLinesBefore,
            );
            const upCount = clampAutoExpandCount(
              gap.end - range.start + 1 + AUTO_EXPAND_COMMENT_CONTEXT,
              mergedChunk.hiddenLinesBefore,
            );
            return [
              ...(downCount === null ? [] : [{ direction: 'down' as const, count: downCount }]),
              ...(upCount === null ? [] : [{ direction: 'up' as const, count: upCount }]),
            ];
          });
          const candidate = candidates.sort((left, right) => left.count - right.count)[0];

          if (candidate?.direction === 'down') {
            queueExpand(`between-down-${previousChunkIndex}`, () => {
              void expandLines(file, previousChunkIndex, 'down', candidate.count);
            });
          } else if (candidate?.direction === 'up') {
            queueExpand(`between-up-${nextChunkIndex}`, () => {
              void expandLines(file, nextChunkIndex, 'up', candidate.count);
            });
          }
        }
      });
    });
  }, [
    threads,
    expandLines,
    file,
    isCollapsed,
    isExpandLoading,
    mergedChunks,
    canExpandHiddenLines,
  ]);

  const fileLevelTokens = useFileLevelTokens({
    file,
    enabled: wholeFileHighlight,
    baseCommitish,
    targetCommitish,
    reloadKey: diffVersion,
  });

  const lineNumberWidth = '4em';
  const ViewerComponent = viewer.Component;
  const viewerProps: DiffViewerBodyProps = {
    file,
    threads,
    showAuthorBadges,
    reviewUrl,
    diffMode,
    syntaxTheme,
    baseCommitish,
    targetCommitish,
    cursor,
    fileIndex,
    mergedChunks,
    isExpandLoading,
    expandHiddenLines: expandLines,
    expandAllBetweenChunks,
    onAddComment: handleAddComment,
    onGenerateThreadPrompt,
    onRemoveThread,
    onDeleteThread,
    onThreadStatusChange,
    onReplyToThread,
    onRemoveMessage,
    onUpdateMessage,
    onLineClick,
    commentTrigger,
    onCommentTriggerHandled,
  };

  return (
    <div
      ref={containerRef}
      className="bg-github-bg-primary"
      style={{ '--line-number-width': lineNumberWidth } as React.CSSProperties}
    >
      <DiffViewerHeader
        file={file}
        reviewUrl={reviewUrl}
        onOpenInEditor={onOpenInEditor}
        isCollapsed={isCollapsed}
        isFocused={isFocused}
        isReviewed={reviewedFiles.has(file.path)}
        isChangedSinceViewed={isChangedSinceViewed}
        onToggleCollapsed={onToggleCollapsed}
        onToggleAllCollapsed={onToggleAllCollapsed}
        onToggleReviewed={onToggleReviewed}
      />

      {!isCollapsed && (
        <FileLevelTokensProvider value={fileLevelTokens}>
          <div className="overflow-y-auto">
            <ViewerComponent {...viewerProps} />
          </div>
        </FileLevelTokensProvider>
      )}
    </div>
  );
});
