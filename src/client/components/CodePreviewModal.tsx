import { LoaderCircle, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useHotkeysContext } from 'react-hotkeys-hook';

import type { CommentThread } from '../../types/diff';
import type { CursorPosition } from '../hooks/keyboardNavigation';

interface CodePreviewModalProps {
  /** Thread anchoring the preview; absent when the preview is opened for a whole file. */
  thread?: CommentThread;
  filePath: string;
  targetPosition: CursorPosition | null;
  isLoading: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function CodePreviewModal({
  thread,
  filePath,
  targetPosition,
  isLoading,
  onClose,
  children,
}: CodePreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { enableScope, disableScope } = useHotkeysContext();
  const lineLabel = Array.isArray(thread?.line)
    ? `${thread.line[0]}-${thread.line[1]}`
    : thread?.line;

  useEffect(() => {
    disableScope('navigation');
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      enableScope('navigation');
    };
  }, [disableScope, enableScope, onClose]);

  useEffect(() => {
    if (isLoading) return;
    // Whole-file previews have no anchor: show the top of the file as-is.
    if (!thread && !targetPosition) return;

    let cancelled = false;
    let frameId = 0;

    const scrollToTarget = (attempt: number) => {
      frameId = requestAnimationFrame(() => {
        if (cancelled) return;
        const dialog = dialogRef.current;
        if (!dialog) return;

        const threadTarget = thread
          ? Array.from(dialog.querySelectorAll<HTMLElement>('[id]')).find(
              (element) => element.id === `comment-thread-${thread.id}`,
            )
          : undefined;
        const lineId = targetPosition
          ? `file-0-chunk-${targetPosition.chunkIndex}-line-${targetPosition.lineIndex}`
          : null;
        const lineTarget = lineId
          ? (dialog.querySelector<HTMLElement>(`#${lineId}-${targetPosition?.side}`) ??
            dialog.querySelector<HTMLElement>(`#${lineId}`))
          : null;
        const target = threadTarget ?? lineTarget;
        if (!target) {
          if (attempt < 20) scrollToTarget(attempt + 1);
          return;
        }

        target.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    scrollToTarget(0);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [isLoading, targetPosition, thread]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-preview-title"
        className="relative flex h-full w-full flex-col overflow-hidden border-github-border bg-github-bg-primary shadow-2xl sm:h-[92vh] sm:w-[96vw] sm:max-w-[1800px] sm:rounded-lg sm:border"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-github-border bg-github-bg-secondary px-4 py-3">
          <div className="min-w-0">
            <h2 id="code-preview-title" className="text-sm font-semibold text-github-text-primary">
              Code preview
            </h2>
            <p className="truncate font-mono text-xs text-github-text-secondary">
              {filePath}
              {thread ? `:${lineLabel}` : ''}
              {isLoading ? ' · Loading full file…' : ''}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-github-text-secondary hover:bg-github-bg-tertiary hover:text-github-text-primary"
            aria-label="Close code preview"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-github-text-secondary"
            >
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
              <span>Loading full file…</span>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}
