import { ChevronDown, ChevronUp, Files } from 'lucide-react';

interface SingleFileToolbarProps {
  filePath: string;
  /** Zero-based position of the current file within the visible file list. */
  fileIndex: number;
  totalFiles: number;
  onShowAllFiles: () => void;
}

/**
 * Toolbar shown above the diff in file-by-file mode: progress counter, the
 * current file path, and a way back to the all-files view. File switching
 * lives in the floating FileByFileNavButtons.
 */
export function SingleFileToolbar({
  filePath,
  fileIndex,
  totalFiles,
  onShowAllFiles,
}: SingleFileToolbarProps) {
  return (
    <div className="shrink-0 bg-github-bg-secondary border-b border-github-border px-4 py-2 flex items-center gap-2">
      <span
        className="text-xs text-github-text-secondary tabular-nums whitespace-nowrap px-1"
        data-testid="single-file-progress"
      >
        {fileIndex + 1} / {totalFiles}
      </span>
      <span
        className="font-mono text-sm text-github-text-primary truncate flex-1 min-w-0"
        title={filePath}
      >
        {filePath}
      </span>
      <button
        type="button"
        onClick={onShowAllFiles}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary transition-colors whitespace-nowrap"
      >
        <Files size={14} />
        View all files
      </button>
    </div>
  );
}

interface FileByFileNavButtonsProps {
  /** Zero-based position of the current file within the visible file list. */
  fileIndex: number;
  totalFiles: number;
  onSelectIndex: (index: number) => void;
}

const navButtonClass =
  'flex items-center gap-2 px-4 py-2.5 text-sm text-github-text-primary transition-colors hover:bg-github-bg-tertiary disabled:opacity-40 disabled:pointer-events-none';
const navKbdClass =
  'rounded border border-github-border bg-github-bg-tertiary px-1.5 py-0.5 text-xs leading-none text-github-text-muted';

/**
 * Floating pager for file-by-file mode, pinned to the bottom-right corner so
 * next/previous is always within reach while reviewing. Mirrors GitHub's
 * floating "next file" button; `]` / `[` trigger the same navigation.
 */
export function FileByFileNavButtons({
  fileIndex,
  totalFiles,
  onSelectIndex,
}: FileByFileNavButtonsProps) {
  return (
    <div
      className="fixed bottom-6 right-6 z-30 flex items-center rounded-full border border-github-border bg-github-bg-secondary shadow-lg overflow-hidden"
      data-testid="file-by-file-nav"
    >
      <button
        type="button"
        aria-label="Previous file"
        title="Previous file ([)"
        disabled={fileIndex <= 0}
        onClick={() => onSelectIndex(fileIndex - 1)}
        className={`${navButtonClass} border-r border-github-border`}
      >
        <ChevronUp size={16} />
        Prev
        <kbd className={navKbdClass}>[</kbd>
      </button>
      <button
        type="button"
        aria-label="Next file"
        title="Next file (])"
        disabled={fileIndex >= totalFiles - 1}
        onClick={() => onSelectIndex(fileIndex + 1)}
        className={navButtonClass}
      >
        Next
        <kbd className={navKbdClass}>]</kbd>
        <ChevronDown size={16} />
      </button>
    </div>
  );
}
