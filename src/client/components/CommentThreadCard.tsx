import {
  Check,
  ChevronDown,
  ChevronRight,
  Edit2,
  ExternalLink,
  FileCode2,
  FileSearch,
  MessageSquare,
  Navigation,
  Trash2,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import {
  type CommentThread,
  type CommentThreadStatus,
  type DiffCommentMessage,
} from '../../types/diff';
import { useClickOutside } from '../hooks/useClickOutside';
import { copyTextToClipboard } from '../utils/clipboard';
import { buildGitLabDiffLineUrl } from '../utils/gitlabLinks';
import { THREAD_STATUS_LABELS } from '../utils/threadStatusLabels';

import { CommentBodyRenderer } from './CommentBodyRenderer';
import { CommentForm } from './CommentForm';
import type { AppearanceSettings } from './SettingsModal';

interface ThreadMessageItemProps {
  message: DiffCommentMessage;
  isRootMessage?: boolean;
  showAuthorBadge: boolean;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  filename?: string;
  originalCode?: string;
  onUpdate: (newBody: string) => void;
  onResolveOrDelete: () => void;
  actionLabel: string;
  confirmPrompt?: string;
  hideAction?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}

function ThreadMessageItem({
  message,
  isRootMessage = false,
  showAuthorBadge,
  syntaxTheme,
  filename,
  originalCode,
  onUpdate,
  onResolveOrDelete,
  actionLabel,
  confirmPrompt,
  hideAction = false,
  onClick,
}: ThreadMessageItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmContainerRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const showAuthorHeader = showAuthorBadge;
  const isUserAuthoredMessage = message.author?.trim() === 'User';
  const authorLabel = message.author?.trim() || 'Agent';

  useClickOutside(confirmContainerRef, () => setIsConfirming(false), isConfirming);

  useEffect(() => {
    if (!isConfirming) return;

    confirmButtonRef.current?.focus();

    // Capture phase so Escape only cancels the confirmation and never reaches
    // surrounding Escape handlers (e.g. the CommentsListModal close hotkey).
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsConfirming(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isConfirming]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleSaveEdit = (nextBody: string) => {
    if (nextBody !== message.body) {
      onUpdate(nextBody);
    }
    setIsEditing(false);
    return Promise.resolve();
  };

  return (
    <div className={isEditing ? '' : 'flex min-w-0 items-start gap-3'} onClick={onClick}>
      {!isEditing ? (
        <>
          <div className="min-w-0 flex-1">
            {showAuthorHeader && (
              <div className="mb-2 flex min-w-0 items-center gap-2 pr-2 text-xs text-github-text-secondary">
                <span className="inline-flex items-center rounded-full border border-github-border bg-github-bg-primary px-2 py-0.5 text-[11px] font-medium text-github-text-primary">
                  {authorLabel}
                </span>
              </div>
            )}

            <CommentBodyRenderer
              body={message.body}
              originalCode={originalCode}
              filename={filename}
              syntaxTheme={syntaxTheme}
            />
          </div>
          {!hideAction &&
            (isRootMessage || isUserAuthoredMessage) &&
            (isConfirming ? (
              <div
                ref={confirmContainerRef}
                className="flex shrink-0 items-center gap-1.5 pt-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="whitespace-nowrap text-xs text-github-text-secondary">
                  {confirmPrompt}
                </span>
                <button
                  ref={confirmButtonRef}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsConfirming(false);
                    onResolveOrDelete();
                  }}
                  className={`whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs font-medium transition-all hover:bg-github-bg-primary ${
                    isRootMessage ? 'text-green-700 hover:text-green-800' : 'text-github-danger'
                  }`}
                >
                  {isRootMessage ? 'Resolve' : 'Delete'}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsConfirming(false);
                  }}
                  className="whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary transition-all hover:bg-github-bg-primary"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex shrink-0 items-start gap-2 pt-0.5">
                {isUserAuthoredMessage && (
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    className="rounded border border-github-border bg-github-bg-tertiary p-1.5 text-github-text-primary transition-all hover:bg-github-bg-primary"
                    title="Edit message"
                  >
                    <Edit2 size={12} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirmPrompt) {
                      setIsConfirming(true);
                      return;
                    }
                    onResolveOrDelete();
                  }}
                  className={`rounded border border-github-border bg-github-bg-tertiary p-1.5 transition-all hover:bg-github-bg-primary ${
                    isRootMessage ? 'text-green-700 hover:text-green-800' : 'text-github-danger'
                  }`}
                  title={actionLabel}
                  aria-label={actionLabel}
                >
                  {isRootMessage ? <Check size={12} /> : <Trash2 size={12} />}
                </button>
              </div>
            ))}
        </>
      ) : (
        <CommentForm
          onSubmit={handleSaveEdit}
          onCancel={handleCancelEdit}
          selectedCode={originalCode}
          syntaxTheme={syntaxTheme}
          filename={filename}
          initialValue={message.body}
          embedded={true}
          title="Edit comment"
          submitLabel="Save"
          placeholder="Edit your message..."
        />
      )}
    </div>
  );
}

interface CommentThreadCardProps {
  thread: CommentThread;
  showAuthorBadges?: boolean;
  confirmRootAction?: boolean;
  reviewUrl?: string;
  gitLabLine?: string;
  onGeneratePrompt: (thread: CommentThread) => string;
  onRemoveThread: (threadId: string) => void;
  onDeleteThread?: () => void;
  onThreadStatusChange?: (status: CommentThreadStatus) => void;
  onNavigateToCode?: () => void;
  onShowCode?: () => void;
  collapseRequest?: { collapsed: boolean; version: number };
  hideReplies?: boolean;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  onClick?: (e: React.MouseEvent) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
}

interface ThreadStatusAction {
  status: CommentThreadStatus;
  label: string;
}

const THREAD_STATUS_ACTIONS: Record<CommentThreadStatus, readonly ThreadStatusAction[]> = {
  open: [
    { status: 'accepted', label: 'Assign Agent' },
    { status: 'changes_requested', label: 'Request Changes' },
    { status: 'closed', label: 'Close' },
  ],
  accepted: [
    { status: 'open', label: 'Reopen' },
    { status: 'closed', label: 'Close' },
  ],
  changes_requested: [
    { status: 'to_verify', label: 'Verify Fix' },
    { status: 'open', label: 'Reopen' },
  ],
  to_verify: [{ status: 'open', label: 'Reopen' }],
  ready: [
    { status: 'resolved', label: 'Resolve' },
    { status: 'open', label: 'Reopen' },
  ],
  closed: [{ status: 'open', label: 'Reopen' }],
  resolved: [{ status: 'open', label: 'Reopen' }],
};

const THREAD_STATUS_ACCENT_CLASSES: Record<CommentThreadStatus, string> = {
  open: 'border-yellow-600/50 border-l-yellow-400',
  accepted: 'border-blue-600/50 border-l-blue-400',
  changes_requested: 'border-orange-600/50 border-l-orange-400',
  to_verify: 'border-purple-600/50 border-l-purple-400',
  ready: 'border-green-600/50 border-l-green-400',
  closed: 'border-github-border border-l-github-text-muted opacity-75',
  resolved: 'border-github-border border-l-github-text-muted opacity-75',
};

const THREAD_STATUS_BADGE_CLASSES: Record<CommentThreadStatus, string> = {
  open: 'border-yellow-500/60 text-yellow-400',
  accepted: 'border-blue-500/60 text-blue-400',
  changes_requested: 'border-orange-500/60 text-orange-400',
  to_verify: 'border-purple-500/60 text-purple-400',
  ready: 'border-green-500/60 text-green-400',
  closed: 'border-github-text-muted text-github-text-muted',
  resolved: 'border-github-text-muted text-github-text-muted',
};

export function CommentThreadCard({
  thread,
  showAuthorBadges = false,
  confirmRootAction = true,
  reviewUrl,
  gitLabLine,
  onRemoveThread,
  onDeleteThread,
  onThreadStatusChange,
  onNavigateToCode,
  onShowCode,
  collapseRequest,
  hideReplies = false,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  onClick,
  syntaxTheme,
}: CommentThreadCardProps) {
  const [isFileCopied, setIsFileCopied] = useState(false);
  const [reviewLineUrl, setReviewLineUrl] = useState<string>();
  const [isReplying, setIsReplying] = useState(false);
  const [isDeleteConfirming, setIsDeleteConfirming] = useState(false);
  const isThreadClosed = Boolean(thread.closedAt || thread.resolvedAt);
  const [isCollapsed, setIsCollapsed] = useState(isThreadClosed);
  const [repliesHiddenOverride, setRepliesHiddenOverride] = useState<boolean | null>(null);
  const [showAllReplies, setShowAllReplies] = useState(false);
  const firstLine = Array.isArray(thread.line) ? thread.line[0] : thread.line;
  const threadStatus: CommentThreadStatus = thread.closedAt
    ? 'closed'
    : thread.resolvedAt
      ? 'resolved'
      : thread.readyAt
        ? 'ready'
        : thread.toVerifyAt
          ? 'to_verify'
          : thread.changesRequestedAt
            ? 'changes_requested'
            : thread.acceptedAt
              ? 'accepted'
              : 'open';
  const repliesHidden = repliesHiddenOverride ?? hideReplies;

  useEffect(() => {
    let active = true;
    if (!reviewUrl || !gitLabLine) {
      setReviewLineUrl(undefined);
      return;
    }

    void buildGitLabDiffLineUrl(reviewUrl, thread.file, gitLabLine)
      .then((url) => {
        if (active) setReviewLineUrl(url);
      })
      .catch((error: unknown) => {
        console.error('Failed to build GitLab line URL:', error);
      });

    return () => {
      active = false;
    };
  }, [gitLabLine, reviewUrl, thread.file]);
  const lineLabel = Array.isArray(thread.line)
    ? `${thread.line[0]}-${thread.line[1]}`
    : thread.line;

  useEffect(() => {
    setIsCollapsed(isThreadClosed);
  }, [isThreadClosed]);

  useEffect(() => {
    if (collapseRequest) {
      setIsCollapsed(collapseRequest.collapsed);
    }
  }, [collapseRequest]);

  useEffect(() => {
    setRepliesHiddenOverride(null);
    setShowAllReplies(false);
  }, [hideReplies]);

  const toggleCollapsed = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsCollapsed((prev) => !prev);
  };

  const handleCopyFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyTextToClipboard(`${thread.file}:${firstLine}`);
      setIsFileCopied(true);
      setTimeout(() => setIsFileCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy file and line:', error);
    }
  };

  const rootMessage = thread.messages[0];
  if (!rootMessage) return null;
  const replyMessages = thread.messages.slice(1);
  let lastUserMessageIndex = -1;
  for (let index = thread.messages.length - 1; index > 0; index -= 1) {
    if (thread.messages[index]?.author?.trim() === 'User') {
      lastUserMessageIndex = index;
      break;
    }
  }
  const latestConversationStart =
    lastUserMessageIndex > 0
      ? lastUserMessageIndex === thread.messages.length - 1
        ? Math.max(1, lastUserMessageIndex - 1)
        : lastUserMessageIndex
      : 1;
  const latestConversationReplies = thread.messages.slice(latestConversationStart);
  const hiddenEarlierReplies = replyMessages.length - latestConversationReplies.length;
  const visibleReplyMessages = showAllReplies ? replyMessages : latestConversationReplies;

  return (
    <div
      id={`comment-thread-${thread.id}`}
      className={`rounded-md border border-l-4 bg-github-bg-tertiary p-3 shadow-sm transition-all ${THREAD_STATUS_ACCENT_CLASSES[threadStatus]} ${onClick ? 'cursor-pointer hover:shadow-md' : ''}`}
      onClick={onClick}
    >
      <div className={isCollapsed ? '' : 'mb-3'}>
        <div>
          <div className="flex min-w-0 w-full items-center gap-2 text-xs text-github-text-secondary">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? 'Expand thread' : 'Collapse thread'}
              title={isCollapsed ? 'Expand thread' : 'Collapse thread'}
              className="shrink-0 rounded p-0.5 text-github-text-secondary transition-colors hover:bg-github-bg-primary hover:text-github-text-primary"
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            <span
              className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded px-1 py-0.5 font-mono"
              title={`${thread.file}:${lineLabel}`}
              style={{
                backgroundColor: 'var(--color-yellow-path-bg)',
                color: 'var(--color-yellow-path-text)',
              }}
            >
              {thread.file}:{lineLabel}
            </span>
            {thread.isOutdated && !thread.isOrphaned && (
              <span
                className="inline-flex h-5 shrink-0 items-center rounded-full border border-github-text-muted px-2 text-[10px] font-medium text-github-text-muted"
                title="Code has changed since this comment was made"
                aria-label="Outdated comment"
              >
                Outdated
              </span>
            )}
            {thread.isOrphaned && (
              <span
                className="inline-flex h-5 shrink-0 items-center rounded-full border border-github-text-muted px-2 text-[10px] font-medium text-github-text-muted"
                title="The file is no longer part of this diff"
                aria-label="File not in diff"
              >
                Not in diff
              </span>
            )}
            {threadStatus !== 'open' && (
              <span
                className={`inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium ${THREAD_STATUS_BADGE_CLASSES[threadStatus]}`}
                aria-label={`${THREAD_STATUS_LABELS[threadStatus]} thread`}
              >
                {THREAD_STATUS_LABELS[threadStatus]}
              </span>
            )}
            {isCollapsed && (
              <button
                type="button"
                onClick={toggleCollapsed}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title="Expand thread"
              >
                <span className="min-w-0 flex-1 truncate text-github-text-secondary">
                  {rootMessage.body.split('\n')[0]}
                </span>
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-github-text-muted"
                  aria-label={`${thread.messages.length} messages in thread`}
                >
                  <MessageSquare size={12} />
                  {thread.messages.length}
                </span>
              </button>
            )}
          </div>
          {!isCollapsed && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {onThreadStatusChange && (
                <div className="inline-flex overflow-hidden rounded border border-github-border">
                  <span className="border-r border-github-border bg-blue-600 px-2 py-1 text-xs text-white">
                    {THREAD_STATUS_LABELS[threadStatus]}
                  </span>
                  {THREAD_STATUS_ACTIONS[threadStatus].map((action) => (
                    <button
                      key={action.status}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onThreadStatusChange(action.status);
                      }}
                      className="border-r border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-secondary transition-colors last:border-r-0 hover:bg-github-bg-primary hover:text-github-text-primary"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
                {onNavigateToCode && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onNavigateToCode();
                    }}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary transition-all hover:bg-github-bg-primary"
                    title="Show this thread in the diff"
                  >
                    <Navigation size={12} />
                    Go to Code
                  </button>
                )}
                {onShowCode && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onShowCode();
                    }}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary transition-all hover:bg-github-bg-primary"
                    title="Preview the full file at this comment"
                  >
                    <FileSearch size={12} />
                    Show Code
                  </button>
                )}
                {reviewLineUrl && (
                  <a
                    href={reviewLineUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary transition-all hover:bg-github-bg-primary"
                    title="Open this line in GitLab"
                  >
                    <ExternalLink size={12} />
                    Open Link
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleCopyFile}
                  className="whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary transition-all hover:bg-github-bg-primary"
                  title={`Copy ${thread.file}:${firstLine}`}
                >
                  <span className="inline-flex items-center gap-1">
                    <FileCode2 size={12} />
                    {isFileCopied ? 'Copied!' : 'Copy File'}
                  </span>
                </button>
                {onDeleteThread &&
                  (isDeleteConfirming ? (
                    <div
                      className="inline-flex items-center gap-1"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="text-xs text-github-danger">Delete permanently?</span>
                      <button
                        type="button"
                        onClick={() => onDeleteThread()}
                        className="rounded border border-github-danger px-2 py-1 text-xs text-github-danger hover:bg-github-danger/10"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsDeleteConfirming(false)}
                        className="rounded border border-github-border px-2 py-1 text-xs text-github-text-secondary hover:bg-github-bg-primary"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setIsDeleteConfirming(true);
                      }}
                      className="rounded border border-github-border bg-github-bg-tertiary p-1.5 text-github-danger transition-all hover:bg-github-bg-primary"
                      title="Delete thread"
                      aria-label="Delete thread"
                    >
                      <Trash2 size={12} />
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <div className="space-y-3">
          <ThreadMessageItem
            message={rootMessage}
            isRootMessage={true}
            showAuthorBadge={showAuthorBadges}
            syntaxTheme={syntaxTheme}
            filename={thread.file}
            originalCode={thread.codeContent}
            onUpdate={(newBody) => onUpdateMessage(thread.id, rootMessage.id, newBody)}
            onResolveOrDelete={() => onRemoveThread(thread.id)}
            actionLabel="Resolve thread"
            confirmPrompt={confirmRootAction ? 'Resolve?' : undefined}
            hideAction={isThreadClosed || Boolean(onThreadStatusChange)}
          />

          {replyMessages.length > 0 && (
            <div className="ml-4 flex items-center justify-end gap-3">
              {!repliesHidden && hiddenEarlierReplies > 0 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowAllReplies((current) => !current);
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                >
                  {showAllReplies
                    ? 'Show latest conversation'
                    : `Show ${hiddenEarlierReplies} earlier ${hiddenEarlierReplies === 1 ? 'reply' : 'replies'}`}
                </button>
              )}
              <button
                type="button"
                aria-pressed={repliesHidden}
                onClick={(event) => {
                  event.stopPropagation();
                  setRepliesHiddenOverride(!repliesHidden);
                }}
                className="text-xs text-github-text-muted hover:text-github-text-primary hover:underline"
              >
                {repliesHidden ? 'Show replies' : 'Hide replies'}
              </button>
            </div>
          )}

          {!repliesHidden &&
            visibleReplyMessages.map((message) => (
              <div key={message.id} className="ml-4 border-l border-github-border pl-3">
                <ThreadMessageItem
                  message={message}
                  showAuthorBadge={showAuthorBadges}
                  syntaxTheme={syntaxTheme}
                  filename={thread.file}
                  originalCode={thread.codeContent}
                  onUpdate={(newBody) => onUpdateMessage(thread.id, message.id, newBody)}
                  onResolveOrDelete={() => onRemoveMessage(thread.id, message.id)}
                  actionLabel="Delete reply"
                  confirmPrompt="Delete?"
                />
              </div>
            ))}

          {repliesHidden && replyMessages.length > 0 && (
            <div className="ml-4 text-xs text-github-text-muted">
              {replyMessages.length} replies hidden
            </div>
          )}

          <div
            className="ml-4 border-l border-github-border pl-3"
            onClick={(e) => e.stopPropagation()}
          >
            {isReplying ? (
              <CommentForm
                draftKey={`reply:${thread.id}`}
                onSubmit={async (body) => {
                  await onReplyToThread(thread.id, body);
                  setIsReplying(false);
                }}
                onCancel={() => setIsReplying(false)}
                selectedCode={thread.codeContent}
                syntaxTheme={syntaxTheme}
                filename={thread.file}
                embedded={true}
                title="Reply to thread"
                submitLabel="Reply"
                placeholder="Write a reply..."
              />
            ) : (
              <button
                type="button"
                data-reply-trigger="true"
                onFocus={() => setIsReplying(true)}
                onClick={() => setIsReplying(true)}
                className="w-full cursor-text rounded border border-github-border bg-github-bg-secondary px-3 py-1.5 text-left text-sm text-github-text-muted transition-colors hover:border-github-text-secondary"
              >
                Write a reply...
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
