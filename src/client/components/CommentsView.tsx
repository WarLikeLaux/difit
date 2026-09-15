import { useEffect, useState, useRef, useCallback } from 'react';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';

import type { CommentThread, CommentThreadStatus, DiffFile } from '../../types/diff';
import { getGitLabLineFragment } from '../utils/gitlabLinks';
import { THREAD_STATUS_LABELS } from '../utils/threadStatusLabels';

import { CommentThreadCard } from './CommentThreadCard';
import type { AppearanceSettings } from './SettingsModal';

type ThreadFilter = 'all' | CommentThreadStatus;
const EMPTY_DIFF_FILES: DiffFile[] = [];
const THREAD_FILTER_ORDER: CommentThreadStatus[] = [
  'open',
  'accepted',
  'to_verify',
  'ready',
  'resolved',
];

function threadMatchesFilter(thread: CommentThread, filter: ThreadFilter): boolean {
  if (filter === 'open')
    return !thread.acceptedAt && !thread.toVerifyAt && !thread.readyAt && !thread.resolvedAt;
  if (filter === 'accepted')
    return (
      Boolean(thread.acceptedAt) && !thread.toVerifyAt && !thread.readyAt && !thread.resolvedAt
    );
  if (filter === 'to_verify')
    return Boolean(thread.toVerifyAt) && !thread.readyAt && !thread.resolvedAt;
  if (filter === 'ready') return Boolean(thread.readyAt) && !thread.resolvedAt;
  if (filter === 'resolved') return Boolean(thread.resolvedAt);
  return true;
}

function getInitialThreadFilter(comments: CommentThread[]): ThreadFilter {
  return (
    THREAD_FILTER_ORDER.find((filter) =>
      comments.some((thread) => threadMatchesFilter(thread, filter)),
    ) ?? 'open'
  );
}

interface CommentsViewProps {
  comments: CommentThread[];
  showAuthorBadges?: boolean;
  reviewUrl?: string;
  files?: DiffFile[];
  onRemoveThread: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onThreadStatusChange?: (threadId: string, status: CommentThreadStatus) => void;
  onNavigateToCode?: (thread: CommentThread) => void;
  onGenerateThreadPrompt: (thread: CommentThread) => string;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
}

export function CommentsView({
  comments,
  showAuthorBadges = false,
  reviewUrl,
  files = EMPTY_DIFF_FILES,
  onRemoveThread,
  onDeleteThread,
  onThreadStatusChange,
  onNavigateToCode,
  onGenerateThreadPrompt,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  syntaxTheme,
}: CommentsViewProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>(() =>
    getInitialThreadFilter(comments),
  );
  const [collapseRequest, setCollapseRequest] = useState<{
    collapsed: boolean;
    version: number;
  }>();
  const [hideReplies, setHideReplies] = useState(false);
  const commentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { enableScope, disableScope } = useHotkeysContext();

  const getThreadGitLabLine = (thread: CommentThread): string | undefined => {
    const lineNumber = Array.isArray(thread.line) ? thread.line[0] : thread.line;
    const file = files.find((candidate) => candidate.path === thread.file);
    const line = file?.chunks
      .flatMap((chunk) => chunk.lines)
      .find((candidate) =>
        thread.side === 'old'
          ? candidate.oldLineNumber === lineNumber
          : candidate.newLineNumber === lineNumber,
      );
    return getGitLabLineFragment(line);
  };

  const visibleThreads = comments.filter((thread) => threadMatchesFilter(thread, threadFilter));
  const sortedThreads = [...visibleThreads].sort((a, b) => {
    const getLatestActivity = (thread: CommentThread) =>
      thread.messages.reduce(
        (latest, message) => (message.updatedAt > latest ? message.updatedAt : latest),
        thread.updatedAt,
      );

    return getLatestActivity(b).localeCompare(getLatestActivity(a));
  });

  const handleDeleteThread = useCallback(
    (thread: CommentThread) => {
      const preview = thread.messages[0]?.body || '';
      if (confirm(`Resolve this thread?\n\n"${preview}"`)) {
        onRemoveThread(thread.id);
        if (selectedIndex >= sortedThreads.length - 1 && selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
        }
      }
    },
    [onRemoveThread, selectedIndex, sortedThreads.length],
  );

  useEffect(() => {
    enableScope('comments-list');
    disableScope('navigation');

    return () => {
      enableScope('navigation');
      disableScope('comments-list');
    };
  }, [disableScope, enableScope]);

  const hotkeyOptions = { scopes: 'comments-list', enableOnFormTags: false };

  const selectFilter = (filter: ThreadFilter) => {
    setThreadFilter(filter);
    setSelectedIndex(0);
  };

  useHotkeys(
    'j, down',
    () => setSelectedIndex((prev) => Math.min(prev + 1, sortedThreads.length - 1)),
    hotkeyOptions,
    [sortedThreads.length],
  );

  useHotkeys('k, up', () => setSelectedIndex((prev) => Math.max(prev - 1, 0)), hotkeyOptions, []);

  useHotkeys(
    'd',
    () => {
      if (sortedThreads[selectedIndex]) {
        handleDeleteThread(sortedThreads[selectedIndex]);
      }
    },
    hotkeyOptions,
    [handleDeleteThread, selectedIndex, sortedThreads],
  );

  useEffect(() => {
    if (commentRefs.current[selectedIndex]) {
      commentRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [selectedIndex]);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-github-bg-primary">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-github-border bg-github-bg-secondary p-4 md:w-56 md:border-r md:border-b-0">
          <h2 className="mb-4 text-base font-semibold text-github-text-primary">Comments</h2>
          <div className="flex flex-wrap gap-2 md:flex-col" aria-label="Thread filters">
            {(
              [
                ['all', `All (${comments.length})`],
                [
                  'open',
                  `Open (${comments.filter((thread) => threadMatchesFilter(thread, 'open')).length})`,
                ],
                [
                  'accepted',
                  `Accepted (${comments.filter((thread) => threadMatchesFilter(thread, 'accepted')).length})`,
                ],
                [
                  'to_verify',
                  `${THREAD_STATUS_LABELS.to_verify} (${comments.filter((thread) => threadMatchesFilter(thread, 'to_verify')).length})`,
                ],
                [
                  'ready',
                  `${THREAD_STATUS_LABELS.ready} (${comments.filter((thread) => threadMatchesFilter(thread, 'ready')).length})`,
                ],
                [
                  'resolved',
                  `Resolved (${comments.filter((thread) => threadMatchesFilter(thread, 'resolved')).length})`,
                ],
              ] as const
            ).map(([filter, label]) => (
              <button
                key={filter}
                type="button"
                aria-pressed={threadFilter === filter}
                onClick={() => selectFilter(filter)}
                className={`rounded border px-2.5 py-1 text-left text-xs transition-colors ${
                  threadFilter === filter
                    ? 'border-blue-500 bg-blue-500/10 text-github-text-primary'
                    : 'border-github-border text-github-text-secondary hover:bg-github-bg-tertiary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-5 border-t border-github-border pt-4">
            <div className="mb-2 text-xs font-medium text-github-text-primary">View</div>
            <div className="flex flex-wrap gap-2 md:flex-col">
              <button
                type="button"
                onClick={() =>
                  setCollapseRequest((current) => ({
                    collapsed: true,
                    version: (current?.version ?? 0) + 1,
                  }))
                }
                className="rounded border border-github-border px-2.5 py-1 text-left text-xs text-github-text-secondary transition-colors hover:bg-github-bg-tertiary hover:text-github-text-primary"
              >
                Collapse all
              </button>
              <button
                type="button"
                onClick={() =>
                  setCollapseRequest((current) => ({
                    collapsed: false,
                    version: (current?.version ?? 0) + 1,
                  }))
                }
                className="rounded border border-github-border px-2.5 py-1 text-left text-xs text-github-text-secondary transition-colors hover:bg-github-bg-tertiary hover:text-github-text-primary"
              >
                Expand all
              </button>
              <button
                type="button"
                aria-pressed={hideReplies}
                onClick={() => setHideReplies((hidden) => !hidden)}
                className={`rounded border px-2.5 py-1 text-left text-xs transition-colors ${
                  hideReplies
                    ? 'border-blue-500 bg-blue-500/10 text-github-text-primary'
                    : 'border-github-border text-github-text-secondary hover:bg-github-bg-tertiary hover:text-github-text-primary'
                }`}
              >
                {hideReplies ? 'Show replies' : 'Hide replies'}
              </button>
            </div>
          </div>

          <div className="mt-5 text-xs text-github-text-secondary">
            <span className="font-mono">j/k</span> or <span className="font-mono">↑/↓</span> to
            navigate • <span className="font-mono">d</span> to resolve
          </div>
        </aside>

        <section className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] p-4 lg:p-6">
            {sortedThreads.length === 0 ? (
              <p className="text-center text-github-text-secondary">
                {threadFilter === 'all' ? 'No comments yet' : `No ${threadFilter} threads`}
              </p>
            ) : (
              <>
                <div aria-label="Comment threads" className="columns-1 gap-4 xl:columns-2">
                  {sortedThreads.map((thread, index) => (
                    <div
                      key={thread.id}
                      ref={(el) => {
                        commentRefs.current[index] = el;
                      }}
                      onClick={() => setSelectedIndex(index)}
                      className={`mb-4 break-inside-avoid-column ${
                        selectedIndex === index ? 'rounded ring-2 ring-blue-500' : ''
                      }`}
                    >
                      <CommentThreadCard
                        thread={thread}
                        showAuthorBadges={showAuthorBadges}
                        reviewUrl={reviewUrl}
                        gitLabLine={getThreadGitLabLine(thread)}
                        confirmRootAction={false}
                        onGeneratePrompt={onGenerateThreadPrompt}
                        onRemoveThread={(threadId) => {
                          if (threadId === thread.id) {
                            handleDeleteThread(thread);
                          }
                        }}
                        onDeleteThread={
                          onDeleteThread ? () => onDeleteThread(thread.id) : undefined
                        }
                        onThreadStatusChange={
                          onThreadStatusChange
                            ? (status) => onThreadStatusChange(thread.id, status)
                            : undefined
                        }
                        onNavigateToCode={
                          onNavigateToCode ? () => onNavigateToCode(thread) : undefined
                        }
                        collapseRequest={collapseRequest}
                        hideReplies={hideReplies}
                        onReplyToThread={onReplyToThread}
                        onRemoveMessage={onRemoveMessage}
                        onUpdateMessage={onUpdateMessage}
                        syntaxTheme={syntaxTheme}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-4 border-t border-github-border pt-4 text-center text-xs text-github-text-secondary">
                  {selectedIndex + 1} of {sortedThreads.length} threads
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
