import {
  Columns,
  AlignLeft,
  Settings,
  PanelLeftClose,
  PanelLeft,
  Keyboard,
  List,
  ExternalLink,
  FileStack,
  ArrowLeft,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';

import {
  type DiffCommentThread,
  type DiffResponse,
  type DiffSelection,
  type DiffViewMode,
  type DiffSide,
  type LineNumber,
  type CommentThread,
  type CommentThreadStatus,
  type RevisionsResponse,
} from '../types/diff';
import { DEFAULT_DIFF_VIEW_MODE, normalizeDiffViewMode } from '../utils/diffMode';
import { mergeCommentThreads } from '../utils/commentImports';
import {
  createDiffSelection,
  diffSelectionsEqual,
  getDiffSelectionKey,
  normalizeBaseMode,
} from '../utils/diffSelection';

import { CodePreviewModal } from './components/CodePreviewModal';
import { CommentsView } from './components/CommentsView';
import { DiffQuickMenu } from './components/DiffQuickMenu';
import { DiffViewer } from './components/DiffViewer';
import { FileList, fileMatchesCodeFilter } from './components/FileList';
import { FileByFileNavButtons, SingleFileToolbar } from './components/SingleFileToolbar';
import { GitHubIcon } from './components/GitHubIcon';
import { HelpModal } from './components/HelpModal';
import { Logo } from './components/Logo';
import { ReloadButton } from './components/ReloadButton';
import { SendToAgentButton } from './components/SendToAgentButton';
import { ReviewSwitcher } from './components/ReviewSwitcher';
import { RevisionDetailModal } from './components/RevisionDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { SparkleAnimation } from './components/SparkleAnimation';
import { WordHighlightProvider } from './contexts/WordHighlightContext';
import { useAppearanceSettings } from './hooks/useAppearanceSettings';
import { useAgentEventsStatus } from './hooks/useAgentEventsStatus';
import { useDiffComments } from './hooks/useDiffComments';
import { useExpandedLines, type MergedChunk } from './hooks/useExpandedLines';
import { useFileWatch } from './hooks/useFileWatch';
import { useKeyboardNavigation } from './hooks/useKeyboardNavigation';
import { useLazyDiffRendering } from './hooks/useLazyDiffRendering';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useViewport } from './hooks/useViewport';
import { useReviewRegistry, type ActiveReview } from './reviews/reviewRegistry';
import {
  readReviewWorkspaceState,
  writeReviewWorkspaceState,
} from './reviews/reviewWorkspaceState';
import { fetchClientSettings, saveClientSettings } from './services/userSettings';
import {
  DEFAULT_DIFF_LAYOUT_MODE,
  DIFF_LAYOUT_MODE_STORAGE_KEY,
  type DiffLayoutMode,
  getStoredDiffLayoutMode,
  normalizeDiffLayoutMode,
} from './utils/diffLayoutMode';
import { hasMultipleCommentAuthors } from './utils/commentAuthors';
import { getCommentStorageNamespace } from './utils/commentStorageNamespace';
import { getReviewsDashboardUrl, resolveApiUrl } from './utils/apiUrl';
import { createReviewTitle } from './utils/reviewTitle';
import {
  findNewExternalMessages,
  showExternalMessageNotification,
} from './utils/commentNotifications';
import { copyTextToClipboard } from './utils/clipboard';
import { updateCodeSearchHighlights } from './utils/codeSearchHighlight';
import { getFileElementId } from './utils/domUtils';
import {
  findClosestCommentPosition,
  findCommentPosition,
} from './utils/navigation/positionHelpers';
import { resolveEventSourceUrl } from './utils/eventSourceUrl';
import { buildGitLabMergeRequestUrl } from './utils/gitlabLinks';
import {
  EMPTY_MERGED_CHUNKS_STATE,
  buildMergedChunksState,
  getMergedChunksForVersion,
} from './utils/mergedChunks';
import { buildFileLineIndex, isThreadOutdated } from './utils/outdatedComments';

const EMPTY_COMMENT_THREADS: CommentThread[] = [];
const EMPTY_MERGED_CHUNKS: MergedChunk[] = [];
const DIFF_VIEW_MODE_STORAGE_KEY = 'difit.diffViewMode';
const SIDEBAR_WIDTH_STORAGE_KEY = 'difit.sidebarWidth';
const SIDEBAR_OPEN_STORAGE_KEY = 'difit.sidebarOpen';
const SHOW_RESOLVED_STORAGE_KEY = 'difit.diff.showResolvedComments';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_DEFAULT_WIDTH = 280;

const parseDiffViewMode = (value: unknown): DiffViewMode | null => {
  switch (value) {
    case 'split':
    case 'side-by-side':
    case 'unified':
    case 'inline':
      return normalizeDiffViewMode(value);
    default:
      return null;
  }
};

const getStoredDiffViewMode = (): DiffViewMode | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return parseDiffViewMode(window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
};

const getInitialDiffViewMode = () => getStoredDiffViewMode() ?? DEFAULT_DIFF_VIEW_MODE;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

const getStoredSidebarWidth = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  const parsed = Number.parseInt(stored, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clampSidebarWidth(parsed);
};

const getInitialSidebarWidth = () => getStoredSidebarWidth() ?? SIDEBAR_DEFAULT_WIDTH;

const getStoredSidebarOpen = (): boolean | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
  if (stored === 'true') {
    return true;
  }
  if (stored === 'false') {
    return false;
  }
  return null;
};

const getInitialFileTreeOpen = () => getStoredSidebarOpen() ?? true;

const getInitialShowResolvedComments = () => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SHOW_RESOLVED_STORAGE_KEY) === 'true';
};

type MainView = 'diff' | 'comments';

interface ReviewWorkspaceProps {
  activeReviewId: string | null;
  reviews: ActiveReview[];
  onSelectReview: (reviewId: string) => void;
}

interface ReviewLoadingHeaderProps {
  isMobile: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

function ReviewLoadingHeader({ isMobile, sidebarOpen, sidebarWidth }: ReviewLoadingHeaderProps) {
  return (
    <header
      className={`shrink-0 border-b border-github-border bg-github-bg-secondary ${
        isMobile ? 'h-[97px]' : 'flex h-[61px] items-center'
      }`}
      aria-label="Loading review controls"
    >
      <div
        className={`flex items-center justify-between ${isMobile ? 'h-[52px] px-3' : 'h-full px-4'}`}
        style={{ width: isMobile ? '100%' : sidebarOpen ? `${sidebarWidth}px` : 'auto' }}
      >
        <Logo style={{ height: '18px', color: 'var(--color-github-text-secondary)' }} />
        <div className="flex items-center gap-1 text-github-text-muted" aria-hidden="true">
          {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
          <Settings size={18} />
        </div>
      </div>
      {!isMobile && (
        <div
          className="h-[45px] shrink-0 border-r border-github-border"
          style={{ width: sidebarOpen ? '4px' : '0px' }}
          aria-hidden="true"
        />
      )}
      <div
        className={`flex flex-1 items-center justify-between ${
          isMobile ? 'h-[44px] px-3 pb-2' : 'h-full px-4'
        }`}
        aria-hidden="true"
      >
        <div className="h-8 w-56 max-w-[45%] animate-pulse rounded-md bg-github-bg-tertiary" />
        <div className="h-6 w-36 max-w-[30%] animate-pulse rounded bg-github-bg-tertiary" />
      </div>
    </header>
  );
}

function ReviewWorkspace({ activeReviewId, reviews, onSelectReview }: ReviewWorkspaceProps) {
  const initialWorkspaceStateRef = useRef(readReviewWorkspaceState(activeReviewId));
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const diffDataRef = useRef<DiffResponse | null>(null);
  const [diffDataVersion, setDiffDataVersion] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffViewMode>(
    () => initialWorkspaceStateRef.current.diffMode ?? getInitialDiffViewMode(),
  );
  const [diffLayoutMode, setDiffLayoutMode] = useState<DiffLayoutMode>(
    () => getStoredDiffLayoutMode() ?? DEFAULT_DIFF_LAYOUT_MODE,
  );
  const [activeSingleFilePath, setActiveSingleFilePath] = useState<string | null>(null);
  const isFileByFileView = diffLayoutMode === 'file-by-file';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(getInitialFileTreeOpen);
  const [showResolvedComments, setShowResolvedComments] = useState(getInitialShowResolvedComments);
  const [isDragging, setIsDragging] = useState(false);
  const [showSparkles, setShowSparkles] = useState(false);
  const [hasTriggeredSparkles, setHasTriggeredSparkles] = useState(false);
  const [mainView, setMainView] = useState<MainView | null>(
    initialWorkspaceStateRef.current.mainView ?? null,
  );
  const [pendingCommentThreadId, setPendingCommentThreadId] = useState<string | null>(null);
  const [codePreviewThreadId, setCodePreviewThreadId] = useState<string | null>(null);
  const [codePreviewFilePath, setCodePreviewFilePath] = useState<string | null>(null);
  const [isCodePreviewCollapsed, setIsCodePreviewCollapsed] = useState(false);
  const codePreviewExpansionKeyRef = useRef<string | null>(null);
  const [isRevisionModalOpen, setIsRevisionModalOpen] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [codeFilterText, setCodeFilterText] = useState(
    initialWorkspaceStateRef.current.codeFilterText ?? '',
  );
  const deferredCodeFilterText = useDeferredValue(codeFilterText);
  const collapsedInitializedRef = useRef(false);
  const diffScrollContainerRef = useRef<HTMLElement | null>(null);
  const workspaceStateRef = useRef(initialWorkspaceStateRef.current);
  workspaceStateRef.current = {
    mainView: mainView ?? undefined,
    diffMode,
    codeFilterText,
    diffScrollTop: diffScrollContainerRef.current?.scrollTop,
  };
  const pendingScrollRestoreRef = useRef(initialWorkspaceStateRef.current.diffScrollTop);
  diffDataRef.current = diffData;

  useEffect(
    () => () => {
      writeReviewWorkspaceState(activeReviewId, {
        ...workspaceStateRef.current,
        diffScrollTop: diffScrollContainerRef.current?.scrollTop,
      });
    },
    [activeReviewId],
  );

  // Revision selector state
  const [revisionOptions, setRevisionOptions] = useState<RevisionsResponse | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<DiffSelection>(
    createDiffSelection('', ''),
  );
  const [resolvedBaseRevision, setResolvedBaseRevision] = useState<string>('');
  const [resolvedTargetRevision, setResolvedTargetRevision] = useState<string>('');
  const hasUserSelectedRevisionRef = useRef(false);
  const currentRequestedBaseModeRef = useRef(selectedRevision.baseMode);
  currentRequestedBaseModeRef.current = diffData?.requestedBaseMode ?? selectedRevision.baseMode;
  const selectedRevisionRef = useRef(selectedRevision);
  selectedRevisionRef.current = selectedRevision;
  const diffRequestIdRef = useRef(0);
  const activeDiffAbortControllerRef = useRef<AbortController | null>(null);
  const resolvedSelection = useMemo<DiffSelection | null>(() => {
    if (!diffData?.baseCommitish || !diffData?.targetCommitish) {
      return null;
    }

    return createDiffSelection(
      diffData.baseCommitish,
      diffData.targetCommitish,
      diffData.requestedBaseMode,
    );
  }, [diffData]);
  const resolvedSelectionKey = useMemo(() => {
    if (!resolvedSelection) {
      return null;
    }

    return getDiffSelectionKey(resolvedSelection);
  }, [resolvedSelection]);

  const { settings, updateSettings } = useAppearanceSettings();
  const ignoreWhitespace = settings.ignoreWhitespace ?? true;
  const { isMobile, isDesktop } = useViewport();

  // New diff-aware comment system
  const commentStorageNamespace = getCommentStorageNamespace(
    diffData?.repositoryId,
    diffData?.reviewId,
  );
  const {
    hasLoadedComments,
    threads,
    replaceThreads,
    addThread,
    replyToThread,
    removeThread,
    deleteThread,
    setThreadStatus,
    removeMessage,
    updateMessage,
    clearAllComments,
    generateThreadPrompt,
    generateAllCommentsPrompt,
  } = useDiffComments(
    resolvedSelection?.baseCommitish,
    resolvedSelection?.targetCommitish,
    diffData?.commit, // Using commit as currentCommitHash
    undefined, // branchToHash map - could be populated from server data
    commentStorageNamespace,
    resolvedSelection?.baseMode,
  );
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const showMobileCommentsBar = isMobile && mainView === 'diff' && threads.length > 0;
  const commentsContextKey = useMemo(() => {
    if (!resolvedSelectionKey) {
      return null;
    }

    return `${commentStorageNamespace ?? 'default'}:${resolvedSelectionKey}`;
  }, [commentStorageNamespace, resolvedSelectionKey]);
  const commentSessionQueryString = useMemo(() => {
    if (!resolvedSelection) {
      return null;
    }

    const params = new URLSearchParams({
      base: resolvedSelection.baseCommitish,
      target: resolvedSelection.targetCommitish,
    });
    if (resolvedSelection.baseMode === 'merge-base') {
      params.set('baseMode', resolvedSelection.baseMode);
    }

    return params.toString();
  }, [resolvedSelection]);
  const getCommentApiUrl = useCallback(
    (path: string) => {
      if (!commentSessionQueryString) {
        return resolveApiUrl(path);
      }
      return resolveApiUrl(`${path}?${commentSessionQueryString}`);
    },
    [commentSessionQueryString],
  );
  const [bootstrappedCommentsKey, setBootstrappedCommentsKey] = useState<string | null>(null);
  const hasBootstrappedComments =
    commentsContextKey !== null && commentsContextKey === bootstrappedCommentsKey;
  const bootstrappingCommentsKeyRef = useRef<string | null>(null);
  const hasSelectedInitialMainViewRef = useRef(
    initialWorkspaceStateRef.current.mainView !== undefined,
  );
  const selectMainView = useCallback((view: MainView) => {
    hasSelectedInitialMainViewRef.current = true;
    setMainView(view);
  }, []);
  const skipNextCommentSyncRef = useRef(false);
  // Last server comment version seen; echoed back as baseVersion so the server can detect concurrent writes.
  const serverCommentVersionRef = useRef<number | null>(null);
  const serverCommentSessionEpochRef = useRef<string | null>(null);
  const pendingBootstrapAfterLocalResetRef = useRef(false);

  const handleThreadStatusChange = useCallback(
    (threadId: string, status: CommentThreadStatus) => {
      // Status transitions are small, ordered mutations. Persist them directly so a fast
      // review switch cannot unmount this workspace before the full-thread sync effect runs.
      skipNextCommentSyncRef.current = true;
      setThreadStatus(threadId, status);
      const statusApiUrl = getCommentApiUrl(`/api/comments/${encodeURIComponent(threadId)}/status`);

      void fetch(statusApiUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        keepalive: true,
      })
        .then(async (response) => {
          const result = (await response.json().catch(() => null)) as {
            version?: number;
            error?: string;
          } | null;
          if (!response.ok) {
            throw new Error(result?.error || `Failed to update thread status: ${response.status}`);
          }
          if (typeof result?.version === 'number') {
            serverCommentVersionRef.current = result.version;
          }
        })
        .catch((statusError: unknown) => {
          console.error('Failed to persist thread status:', statusError);
        });
    },
    [getCommentApiUrl, setThreadStatus],
  );

  useEffect(() => {
    if (commentsContextKey !== bootstrappedCommentsKey) {
      skipNextCommentSyncRef.current = false;
    }
  }, [bootstrappedCommentsKey, commentsContextKey]);

  const fetchServerThreads = useCallback(async (): Promise<DiffCommentThread[]> => {
    const response = await fetch(getCommentApiUrl('/api/comments-json'));
    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      sessionEpoch?: string;
      version?: number;
      threads?: DiffCommentThread[];
    };
    if (typeof payload.sessionEpoch === 'string') {
      serverCommentSessionEpochRef.current = payload.sessionEpoch;
    }
    if (typeof payload.version === 'number') {
      serverCommentVersionRef.current = payload.version;
    }
    return Array.isArray(payload.threads) ? payload.threads : [];
  }, [getCommentApiUrl]);

  const syncThreadsToServer = useCallback(
    async (nextThreads: DiffCommentThread[]) => {
      const response = await fetch(getCommentApiUrl('/api/comments'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threads: nextThreads,
          baseVersion: serverCommentVersionRef.current ?? undefined,
          sessionEpoch: serverCommentSessionEpochRef.current ?? undefined,
        }),
      });
      const result = (await response.json()) as {
        sessionEpoch?: string;
        version?: number;
        merged?: boolean;
        staleClient?: boolean;
        threads?: DiffCommentThread[];
      };
      if (typeof result.sessionEpoch === 'string') {
        serverCommentSessionEpochRef.current = result.sessionEpoch;
      }
      if (typeof result.version === 'number') {
        serverCommentVersionRef.current = result.version;
      }
      if (!response.ok) {
        if (result.staleClient && Array.isArray(result.threads)) {
          skipNextCommentSyncRef.current = true;
          replaceThreads(result.threads);
        }
        return;
      }
      // Server merged in a concurrent change; adopt it so we don't push a stale set back.
      if (result.merged && Array.isArray(result.threads)) {
        skipNextCommentSyncRef.current = true;
        replaceThreads(result.threads);
      }
    },
    [getCommentApiUrl, replaceThreads],
  );

  // Viewed files management
  const {
    viewedFiles,
    changedSinceViewedFiles,
    hasLoadedInitialViewedFiles,
    toggleFileViewed,
    setFilesViewed,
    clearViewedFiles,
  } = useViewedFiles(
    resolvedSelection?.baseCommitish,
    resolvedSelection?.targetCommitish,
    diffData?.commit,
    undefined,
    diffData?.files,
    diffData?.repositoryId, // Repository identifier for storage isolation
    settings.autoViewedPatterns,
    resolvedSelection?.baseMode,
  );

  // Reset initialization flag when diff context changes
  useEffect(() => {
    collapsedInitializedRef.current = false;
  }, [diffData?.repositoryId, resolvedSelectionKey, diffData?.commit]);

  // Initialize collapsed files from viewed files (only once per diff)
  useEffect(() => {
    if (!collapsedInitializedRef.current && hasLoadedInitialViewedFiles) {
      setCollapsedFiles(new Set(viewedFiles));
      collapsedInitializedRef.current = true;
    }
  }, [viewedFiles, hasLoadedInitialViewedFiles]);
  const {
    renderedFilePaths,
    ensureFileRendered,
    ensureFilesRenderedUpTo,
    registerLazyFileContainer,
    scrollFileIntoDiffContainer,
    isFileScrolledPastContainerTop,
  } = useLazyDiffRendering({
    diffData,
    diffScrollContainerRef,
    setDiffData,
  });

  useEffect(() => {
    if (!pendingCommentThreadId || mainView !== 'diff' || deferredCodeFilterText.trim()) return;

    let cancelled = false;
    let frameId = 0;
    const scrollToThread = (attempt: number) => {
      frameId = requestAnimationFrame(() => {
        if (cancelled) return;
        const target = document.getElementById(`comment-thread-${pendingCommentThreadId}`);
        if (!target) {
          if (attempt < 12) scrollToThread(attempt + 1);
          return;
        }

        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        setPendingCommentThreadId((current) =>
          current === pendingCommentThreadId ? null : current,
        );
      });
    };
    scrollToThread(0);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [deferredCodeFilterText, mainView, pendingCommentThreadId, renderedFilePaths]);

  const visibleDiffFiles = useMemo(
    () =>
      (diffData?.files ?? [])
        .map((file, fileIndex) => ({ file, fileIndex }))
        .filter(({ file }) => fileMatchesCodeFilter(file, deferredCodeFilterText)),
    [deferredCodeFilterText, diffData?.files],
  );

  // The single file shown in file-by-file mode. Falls back to the first
  // visible file when the remembered path is missing (e.g. after switching to
  // a diff that no longer contains it).
  const activeSingleFileEntry = useMemo(() => {
    if (!isFileByFileView) return null;
    const found = activeSingleFilePath
      ? visibleDiffFiles.find((entry) => entry.file.path === activeSingleFilePath)
      : undefined;
    return found ?? visibleDiffFiles[0] ?? null;
  }, [activeSingleFilePath, isFileByFileView, visibleDiffFiles]);

  useEffect(
    () => updateCodeSearchHighlights(deferredCodeFilterText),
    [deferredCodeFilterText, diffMode, renderedFilePaths],
  );

  const toggleFileReviewed = useCallback(
    async (filePath: string) => {
      if (!diffData) return;

      const file = diffData.files.find((f) => f.path === filePath);
      if (!file) return;

      const wasViewed = viewedFiles.has(filePath);
      // Measure before the collapse re-renders: only re-anchor the header when
      // the user is scrolled past it (deep inside a long file), so the viewport
      // doesn't land in unrelated content after collapsing (#164). If the header
      // is already visible, stay stationary and let files below fill up (#402).
      const shouldScrollToHeader = !wasViewed && isFileScrolledPastContainerTop(filePath);
      await toggleFileViewed(filePath, file);

      // Update collapsed state based on viewed state
      setCollapsedFiles((prev) => {
        const newSet = new Set(prev);
        if (!wasViewed) {
          // Marking as viewed -> collapse the file
          newSet.add(filePath);
        } else {
          // Marking as not viewed -> expand the file
          newSet.delete(filePath);
        }
        return newSet;
      });

      if (shouldScrollToHeader) {
        setTimeout(() => {
          // In file-by-file mode the collapsed file is the only mounted one;
          // just snap back to its top instead of rendering the files above it.
          if (isFileByFileView) {
            diffScrollContainerRef.current?.scrollTo({ top: 0 });
            return;
          }
          scrollFileIntoDiffContainer(filePath);
        }, 100);
      }
    },
    [
      diffData,
      isFileByFileView,
      isFileScrolledPastContainerTop,
      scrollFileIntoDiffContainer,
      toggleFileViewed,
      viewedFiles,
    ],
  );

  const toggleFolderReviewed = useCallback(
    async (folderPath: string, reviewed: boolean) => {
      if (!diffData) return;

      const folderFiles = diffData.files.filter((file) => file.path.startsWith(`${folderPath}/`));
      if (folderFiles.length === 0) return;

      await setFilesViewed(folderFiles, reviewed);

      // Keep the collapse state of every file in the folder in sync with its viewed state
      setCollapsedFiles((prev) => {
        const newSet = new Set(prev);
        folderFiles.forEach((file) => {
          if (reviewed) {
            newSet.add(file.path);
          } else {
            newSet.delete(file.path);
          }
        });
        return newSet;
      });
    },
    [diffData, setFilesViewed],
  );

  const toggleFileCollapsed = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  }, []);

  const toggleAllFilesCollapsed = useCallback(
    (shouldCollapse: boolean) => {
      if (!diffData) return;

      if (shouldCollapse) {
        // Collapse all files
        setCollapsedFiles(new Set(diffData.files.map((f) => f.path)));
      } else {
        // Expand all files
        setCollapsedFiles(new Set());
      }
    },
    [diffData],
  );

  const handleMobileFileSelected = useCallback(() => {
    setIsFileTreeOpen(false);
  }, []);

  const handleDiffModeChange = useCallback((mode: DiffViewMode) => {
    setDiffMode(mode);
    try {
      window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    saveClientSettings({ diffViewMode: mode });
  }, []);

  const handleDiffLayoutModeChange = useCallback(
    (mode: DiffLayoutMode) => {
      setDiffLayoutMode(mode);
      try {
        window.localStorage.setItem(DIFF_LAYOUT_MODE_STORAGE_KEY, mode);
      } catch {
        // Ignore localStorage errors (e.g. disabled storage).
      }
      saveClientSettings({ diffLayoutMode: mode });

      if (mode === 'all-files' && activeSingleFilePath) {
        // Keep the file that was open in file-by-file view rendered and in view.
        ensureFileRendered(activeSingleFilePath);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const scrollContainer = diffScrollContainerRef.current;
            const target = document.getElementById(getFileElementId(activeSingleFilePath));
            if (!scrollContainer || !target) return;

            const containerRect = scrollContainer.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            scrollContainer.scrollTo({
              top: Math.max(0, scrollContainer.scrollTop + targetRect.top - containerRect.top),
            });
          });
        });
      }
    },
    [activeSingleFilePath, ensureFileRendered],
  );

  const toggleResolvedComments = useCallback(() => {
    setShowResolvedComments((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SHOW_RESOLVED_STORAGE_KEY, String(next));
      } catch {
        // Ignore localStorage errors (e.g. disabled storage).
      }
      return next;
    });
  }, []);

  // Lift expand state to App level so navigation and rendering share the same merged chunks
  const {
    isLoading: isExpandLoading,
    expandLines,
    expandAllBetweenChunks,
    prefetchFileContent,
    getMergedChunks,
    lastUpdatedAt,
  } = useExpandedLines({
    baseCommitish: diffData?.baseCommitish,
    targetCommitish: diffData?.targetCommitish,
    diffIdentity: diffDataVersion,
  });
  const {
    isLoading: isCodePreviewExpandLoading,
    expandLines: expandCodePreviewLines,
    expandAllBetweenChunks: expandAllCodePreviewBetweenChunks,
    prefetchFileContent: prefetchCodePreviewFileContent,
    getMergedChunks: getCodePreviewMergedChunks,
  } = useExpandedLines({
    baseCommitish: diffData?.baseCommitish,
    targetCommitish: diffData?.targetCommitish,
    diffIdentity: diffDataVersion,
  });

  const getMergedChunksRef = useRef(getMergedChunks);
  useEffect(() => {
    getMergedChunksRef.current = getMergedChunks;
  }, [getMergedChunks]);

  const [mergedChunksState, setMergedChunksState] = useState(EMPTY_MERGED_CHUNKS_STATE);
  const filesByPath = useMemo(() => {
    const map = new Map<string, DiffResponse['files'][number]>();
    diffData?.files.forEach((file) => {
      map.set(file.path, file);
    });
    return map;
  }, [diffData]);

  // Recompute merged chunks for the current fetched diff only.
  useEffect(() => {
    if (!diffData) {
      setMergedChunksState(EMPTY_MERGED_CHUNKS_STATE);
      return;
    }

    // In file-by-file mode only the mounted file needs merged chunks.
    const renderedPaths = activeSingleFileEntry
      ? new Set([activeSingleFileEntry.file.path])
      : renderedFilePaths;
    setMergedChunksState(
      buildMergedChunksState(diffDataVersion, renderedPaths, filesByPath, (file) =>
        getMergedChunksRef.current(file),
      ),
    );
  }, [
    activeSingleFileEntry,
    diffData,
    diffDataVersion,
    filesByPath,
    renderedFilePaths,
    lastUpdatedAt,
  ]);

  // Create files with merged chunks for keyboard navigation
  const navigableFiles = useMemo(() => {
    if (!diffData) return [];
    return diffData.files.map((file) => ({
      ...file,
      chunks:
        getMergedChunksForVersion(mergedChunksState, diffDataVersion, file.path) || file.chunks,
    }));
  }, [diffData, diffDataVersion, mergedChunksState]);

  const fileLineIndexByPath = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildFileLineIndex>>();
    navigableFiles.forEach((file) => {
      map.set(file.path, buildFileLineIndex(file));
    });
    return map;
  }, [navigableFiles]);

  const normalizedThreads = useMemo<CommentThread[]>(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        file: thread.filePath,
        line:
          typeof thread.position.line === 'number'
            ? thread.position.line
            : ([thread.position.line.start, thread.position.line.end] as [number, number]),
        side: thread.position.side,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        acceptedAt: thread.acceptedAt,
        changesRequestedAt: thread.changesRequestedAt,
        toVerifyAt: thread.toVerifyAt,
        readyAt: thread.readyAt,
        closedAt: thread.closedAt,
        resolvedAt: thread.resolvedAt,
        codeContent: thread.codeSnapshot?.content,
        isOutdated: isThreadOutdated(thread, fileLineIndexByPath.get(thread.filePath)),
        isOrphaned: !fileLineIndexByPath.has(thread.filePath),
        messages: thread.messages,
      })),
    [threads, fileLineIndexByPath],
  );
  const closedThreadCount = useMemo(
    () =>
      normalizedThreads.filter((thread) => Boolean(thread.closedAt || thread.resolvedAt)).length,
    [normalizedThreads],
  );
  const diffThreads = useMemo(
    () =>
      showResolvedComments
        ? normalizedThreads
        : normalizedThreads.filter((thread) => !thread.closedAt && !thread.resolvedAt),
    [normalizedThreads, showResolvedComments],
  );
  const codePreviewThread = useMemo(
    () => normalizedThreads.find((thread) => thread.id === codePreviewThreadId) ?? null,
    [codePreviewThreadId, normalizedThreads],
  );
  const codePreviewFile = useMemo(
    () =>
      codePreviewThread || codePreviewFilePath
        ? (diffData?.files.find(
            (file) => file.path === (codePreviewThread?.file ?? codePreviewFilePath),
          ) ?? null)
        : null,
    [codePreviewThread, codePreviewFilePath, diffData?.files],
  );
  const codePreviewMergedChunks = useMemo(
    () => (codePreviewFile ? getCodePreviewMergedChunks(codePreviewFile) : EMPTY_MERGED_CHUNKS),
    [codePreviewFile, getCodePreviewMergedChunks],
  );
  const codePreviewNavigableFile = useMemo(
    () => (codePreviewFile ? { ...codePreviewFile, chunks: codePreviewMergedChunks } : null),
    [codePreviewFile, codePreviewMergedChunks],
  );
  const codePreviewPosition = useMemo(() => {
    if (!codePreviewThread || !codePreviewNavigableFile) return null;
    const files = [codePreviewNavigableFile];
    return (
      findCommentPosition(codePreviewThread, files) ??
      findClosestCommentPosition(codePreviewThread, files)
    );
  }, [codePreviewNavigableFile, codePreviewThread]);
  const codePreviewHasHiddenLines = codePreviewMergedChunks.some(
    (chunk) => chunk.hiddenLinesBefore > 0 || chunk.hiddenLinesAfter !== 0,
  );

  useEffect(() => {
    if (!codePreviewFile || codePreviewMergedChunks.length === 0 || isCodePreviewExpandLoading)
      return;

    const expansionKey = `${codePreviewFile.path}:${codePreviewMergedChunks
      .map((chunk) => `${chunk.hiddenLinesBefore}/${chunk.hiddenLinesAfter}`)
      .join(',')}`;
    if (codePreviewExpansionKeyRef.current === expansionKey) return;

    if (codePreviewMergedChunks.some((chunk) => chunk.hiddenLinesAfter < 0)) {
      codePreviewExpansionKeyRef.current = expansionKey;
      void prefetchCodePreviewFileContent(codePreviewFile);
      return;
    }

    for (const chunk of codePreviewMergedChunks) {
      if (chunk.hiddenLinesBefore <= 0) continue;
      const firstChunkIndex = chunk.originalIndices[0];
      if (firstChunkIndex === undefined) continue;
      codePreviewExpansionKeyRef.current = expansionKey;
      void (firstChunkIndex === 0
        ? expandCodePreviewLines(codePreviewFile, firstChunkIndex, 'up', chunk.hiddenLinesBefore)
        : expandAllCodePreviewBetweenChunks(
            codePreviewFile,
            firstChunkIndex,
            chunk.hiddenLinesBefore,
          ));
      return;
    }

    const lastChunk = codePreviewMergedChunks.at(-1);
    const lastChunkIndex = lastChunk?.originalIndices.at(-1);
    if (lastChunk && lastChunk.hiddenLinesAfter > 0 && lastChunkIndex !== undefined) {
      codePreviewExpansionKeyRef.current = expansionKey;
      void expandCodePreviewLines(
        codePreviewFile,
        lastChunkIndex,
        'down',
        lastChunk.hiddenLinesAfter,
      );
    }
  }, [
    codePreviewFile,
    codePreviewMergedChunks,
    expandAllCodePreviewBetweenChunks,
    expandCodePreviewLines,
    isCodePreviewExpandLoading,
    prefetchCodePreviewFileContent,
  ]);

  const showAuthorBadges = useMemo(
    () => hasMultipleCommentAuthors(normalizedThreads.flatMap((thread) => thread.messages)),
    [normalizedThreads],
  );
  const threadsByFile = useMemo(() => {
    const map = new Map<string, CommentThread[]>();
    diffThreads.forEach((thread) => {
      const entry = map.get(thread.file);
      if (entry) {
        entry.push(thread);
      } else {
        map.set(thread.file, [thread]);
      }
    });
    return map;
  }, [diffThreads]);

  // State to trigger comment creation from keyboard
  const [commentTrigger, setCommentTrigger] = useState<{
    fileIndex: number;
    chunkIndex: number;
    lineIndex: number;
  } | null>(null);
  const fetchDiffDataRef = useRef<((selection?: DiffSelection) => Promise<void>) | null>(null);
  const [agentEventsRefreshSignal, setAgentEventsRefreshSignal] = useState(0);
  const agentEventsStatus = useAgentEventsStatus({ refreshSignal: agentEventsRefreshSignal });
  const bumpAgentEventsRefresh = useCallback(() => {
    setAgentEventsRefreshSignal((signal) => signal + 1);
  }, []);
  const [isFlushingAgentEvents, setIsFlushingAgentEvents] = useState(false);
  const handleFlushAgentEvents = useCallback(async () => {
    if (isFlushingAgentEvents) return;
    setIsFlushingAgentEvents(true);
    try {
      await fetch(resolveApiUrl('/api/agent-events/flush'), { method: 'POST' });
    } catch {
      // The status polling reflects the outcome; nothing else to do here.
    } finally {
      setIsFlushingAgentEvents(false);
      bumpAgentEventsRefresh();
    }
  }, [isFlushingAgentEvents, bumpAgentEventsRefresh]);
  const handleWatchReload = useCallback(async () => {
    await fetchDiffDataRef.current?.();
  }, []);
  const handleCommentsChanged = useCallback(async () => {
    try {
      const serverThreads = await fetchServerThreads();
      showExternalMessageNotification(findNewExternalMessages(threadsRef.current, serverThreads));
      skipNextCommentSyncRef.current = true;
      replaceThreads(serverThreads);
      if (commentsContextKey) {
        setBootstrappedCommentsKey(commentsContextKey);
      }
      bumpAgentEventsRefresh();
    } catch (commentsError) {
      console.error('Failed to refresh comments from server:', commentsError);
    }
  }, [commentsContextKey, fetchServerThreads, replaceThreads, bumpAgentEventsRefresh]);

  // File watch for reload functionality - initialize with callback
  const { shouldReload, reload, watchState } = useFileWatch(
    handleWatchReload,
    handleCommentsChanged,
  );

  // Track which file the mouse is over so `v` works without a cursor
  const hoveredFileIndexRef = useRef<number | null>(null);
  const getHoveredFileIndex = useCallback(() => hoveredFileIndexRef.current, []);

  const { cursor, isHelpOpen, setIsHelpOpen, setCursorPosition, rememberFilePosition } =
    useKeyboardNavigation({
      files: navigableFiles,
      comments: diffThreads,
      viewMode: diffMode,
      reviewedFiles: viewedFiles,
      onToggleReviewed: toggleFileReviewed,
      getHoveredFileIndex,
      onCreateComment: () => {
        if (cursor) {
          setCommentTrigger({
            fileIndex: cursor.fileIndex,
            chunkIndex: cursor.chunkIndex,
            lineIndex: cursor.lineIndex,
          });
        }
      },
      onCopyAllComments: () => {
        if (threads.length > 0) {
          void handleCopyAllComments();
        }
      },
      onDeleteAllComments: () => {
        if (threads.length > 0 && confirm('Delete all comments?')) {
          clearAllComments();
        }
      },
      onShowCommentsList: () => {
        selectMainView('comments');
      },
      onRefresh: () => {
        reload();
      },
    });

  // Viewed button in the diff header: silently remember the toggled file as
  // the navigation position, so keyboard navigation resumes from it without
  // showing any keyboard UI for a mouse interaction
  const handleViewedButtonToggle = useCallback(
    (filePath: string) => {
      void toggleFileReviewed(filePath);
      if (diffData) {
        const fileIndex = diffData.files.findIndex((f) => f.path === filePath);
        if (fileIndex !== -1) {
          rememberFilePosition(fileIndex);
        }
      }
    },
    [toggleFileReviewed, diffData, rememberFilePosition],
  );

  const scrollVisibleFileIntoDiffContainer = useCallback(
    (filePath: string) => {
      if (isFileByFileView) {
        // In file-by-file mode, swap the mounted file instead of rendering the
        // whole list up to the target.
        if (!visibleDiffFiles.some((entry) => entry.file.path === filePath)) {
          setCodeFilterText('');
        }
        setActiveSingleFilePath(filePath);
        const fileIndex = diffData?.files.findIndex((f) => f.path === filePath) ?? -1;
        if (fileIndex >= 0) {
          rememberFilePosition(fileIndex);
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            diffScrollContainerRef.current?.scrollTo({ top: 0 });
          });
        });
        return;
      }

      if (!deferredCodeFilterText.trim()) {
        scrollFileIntoDiffContainer(filePath);
        return;
      }

      ensureFileRendered(filePath);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const scrollContainer = diffScrollContainerRef.current;
          const target = document.getElementById(getFileElementId(filePath));
          if (!scrollContainer || !target) return;

          const containerRect = scrollContainer.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          scrollContainer.scrollTo({
            top: Math.max(0, scrollContainer.scrollTop + targetRect.top - containerRect.top),
          });
        });
      });
    },
    [
      deferredCodeFilterText,
      diffData,
      ensureFileRendered,
      isFileByFileView,
      rememberFilePosition,
      scrollFileIntoDiffContainer,
      visibleDiffFiles,
    ],
  );

  // Keep the rendered content in sync with the keyboard cursor. In file-by-file
  // mode that means mounting the cursor's file; otherwise it means rendering
  // every file up to it so the cursor line exists.
  useEffect(() => {
    if (!diffData || !cursor) return;

    const filePath = diffData.files[cursor.fileIndex]?.path;
    if (!filePath) return;

    if (isFileByFileView) {
      if (!visibleDiffFiles.some((entry) => entry.file.path === filePath)) return;
      if (activeSingleFilePath === filePath) return;
      setActiveSingleFilePath(filePath);
      requestAnimationFrame(() => {
        setCursorPosition(cursor);
      });
      return;
    }

    if (renderedFilePaths.has(filePath)) return;

    ensureFilesRenderedUpTo(filePath);
    requestAnimationFrame(() => {
      setCursorPosition(cursor);
    });
  }, [
    activeSingleFilePath,
    cursor,
    diffData,
    ensureFilesRenderedUpTo,
    isFileByFileView,
    renderedFilePaths,
    setCursorPosition,
    visibleDiffFiles,
  ]);

  const handleLineClick = useCallback(
    (fileIndex: number, chunkIndex: number, lineIndex: number, side: 'left' | 'right') => {
      setCursorPosition({
        fileIndex,
        chunkIndex,
        lineIndex,
        side,
      });
    },
    [setCursorPosition],
  );

  const handleCommentTriggerHandled = useCallback(() => {
    setCommentTrigger(null);
  }, [setCommentTrigger]);

  const handleGenerateThreadPrompt = useCallback(
    (thread: CommentThread) => generateThreadPrompt(thread.id),
    [generateThreadPrompt],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)),
      );
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const fetchDiffData = useCallback(
    async (selection?: DiffSelection) => {
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      activeDiffAbortControllerRef.current?.abort();
      const controller = new AbortController();
      activeDiffAbortControllerRef.current = controller;
      try {
        const requestedSelection =
          selection ??
          (hasUserSelectedRevisionRef.current ? selectedRevisionRef.current : undefined);
        const params = new URLSearchParams({
          ignoreWhitespace: String(ignoreWhitespace),
        });
        if (requestedSelection?.baseCommitish) params.set('base', requestedSelection.baseCommitish);
        if (requestedSelection?.targetCommitish)
          params.set('target', requestedSelection.targetCommitish);
        if (requestedSelection?.baseMode === 'merge-base')
          params.set('baseMode', requestedSelection.baseMode);

        const response = await fetch(resolveApiUrl(`/api/diff?${params}`), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Failed to fetch diff data');
        const data = (await response.json()) as DiffResponse;
        const reviewLabel = response.headers?.get?.('X-Difit-Review-Label');
        document.title = createReviewTitle(data, reviewLabel);
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        if (JSON.stringify(diffDataRef.current) !== JSON.stringify(data)) {
          diffDataRef.current = data;
          setDiffData(data);
          setDiffDataVersion((prev) => prev + 1);
        }

        // Update resolved revision state from server response
        setResolvedBaseRevision(
          data.baseCommitish && data.requestedBaseMode !== 'merge-base' ? data.baseCommitish : '',
        );
        if (data.targetCommitish) setResolvedTargetRevision(data.targetCommitish);

        if (!hasUserSelectedRevisionRef.current) {
          const requestedBase = data.requestedBaseCommitish ?? data.baseCommitish;
          const requestedTarget = data.requestedTargetCommitish ?? data.targetCommitish;
          if (requestedBase && requestedTarget) {
            setSelectedRevision(
              createDiffSelection(requestedBase, requestedTarget, data.requestedBaseMode),
            );
          }
        }

        // Lock files are now automatically marked as viewed by useViewedFiles hook
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') {
          return;
        }
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (activeDiffAbortControllerRef.current === controller) {
          activeDiffAbortControllerRef.current = null;
        }
        if (diffRequestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [ignoreWhitespace],
  );
  fetchDiffDataRef.current = fetchDiffData;

  useEffect(() => {
    void fetchDiffData();
  }, [fetchDiffData]);

  useEffect(() => {
    const scrollTop = pendingScrollRestoreRef.current;
    if (scrollTop === undefined || mainView !== 'diff' || !diffData) return;

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        diffScrollContainerRef.current?.scrollTo({ top: scrollTop });
        pendingScrollRestoreRef.current = undefined;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [diffData, mainView]);

  useEffect(() => {
    return () => {
      activeDiffAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isMobile && diffMode !== 'unified') {
      setDiffMode('unified');
    }
  }, [diffMode, isMobile]);

  // Hydrate UI settings from the server-persisted config so they survive
  // across ports (localStorage is origin-scoped and resets on a new port).
  // Settings the server doesn't know yet are seeded from localStorage.
  useEffect(() => {
    let cancelled = false;

    void fetchClientSettings().then((client) => {
      if (cancelled || !client) {
        return;
      }

      const seed: Record<string, unknown> = {};

      const remoteDiffViewMode = parseDiffViewMode(client.diffViewMode);
      if (remoteDiffViewMode && !initialWorkspaceStateRef.current.diffMode) {
        setDiffMode(remoteDiffViewMode);
      } else if (!remoteDiffViewMode) {
        const localDiffViewMode = getStoredDiffViewMode();
        if (localDiffViewMode) {
          seed.diffViewMode = localDiffViewMode;
        }
      }

      const remoteDiffLayoutMode = normalizeDiffLayoutMode(client.diffLayoutMode);
      if (remoteDiffLayoutMode) {
        setDiffLayoutMode(remoteDiffLayoutMode);
      } else {
        const localDiffLayoutMode = getStoredDiffLayoutMode();
        if (localDiffLayoutMode) {
          seed.diffLayoutMode = localDiffLayoutMode;
        }
      }

      if (typeof client.sidebarWidth === 'number' && Number.isFinite(client.sidebarWidth)) {
        setSidebarWidth(clampSidebarWidth(client.sidebarWidth));
      } else {
        const localSidebarWidth = getStoredSidebarWidth();
        if (localSidebarWidth !== null) {
          seed.sidebarWidth = localSidebarWidth;
        }
      }

      if (typeof client.sidebarOpen === 'boolean') {
        setIsFileTreeOpen(client.sidebarOpen);
      } else {
        const localSidebarOpen = getStoredSidebarOpen();
        if (localSidebarOpen !== null) {
          seed.sidebarOpen = localSidebarOpen;
        }
      }

      if (Object.keys(seed).length > 0) {
        saveClientSettings(seed);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const skipInitialSidebarWidthSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    // Skip the mount run so simply opening difit doesn't write the config file.
    if (skipInitialSidebarWidthSaveRef.current) {
      skipInitialSidebarWidthSaveRef.current = false;
      return;
    }
    saveClientSettings({ sidebarWidth });
  }, [sidebarWidth]);

  const skipInitialSidebarOpenSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(isFileTreeOpen));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    if (skipInitialSidebarOpenSaveRef.current) {
      skipInitialSidebarOpenSaveRef.current = false;
      return;
    }
    saveClientSettings({ sidebarOpen: isFileTreeOpen });
  }, [isFileTreeOpen]);

  // Fetch revision options on mount
  useEffect(() => {
    fetch(resolveApiUrl('/api/revisions'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: RevisionsResponse | null) => {
        setRevisionOptions(data);
        if (
          data?.resolvedBase &&
          normalizeBaseMode(currentRequestedBaseModeRef.current) !== 'merge-base'
        ) {
          setResolvedBaseRevision((prev) => prev || data.resolvedBase || '');
        }
        if (data?.resolvedTarget) {
          setResolvedTargetRevision((prev) => prev || data.resolvedTarget || '');
        }
      })
      .catch(() => setRevisionOptions(null));
  }, []);

  // Handle revision change
  const handleRevisionChange = useCallback(
    async (nextSelection: DiffSelection) => {
      // Skip if no actual change
      if (diffSelectionsEqual(nextSelection, selectedRevision)) return;

      hasUserSelectedRevisionRef.current = true;
      selectedRevisionRef.current = nextSelection;
      setSelectedRevision(nextSelection);
      setLoading(true);
      setError(null);
      await fetchDiffData(nextSelection);
    },
    [fetchDiffData, selectedRevision],
  );

  // Clear comments and viewed files on initial load if requested via CLI flag
  const hasCleanedRef = useRef(false);
  useEffect(() => {
    if (diffData?.clearComments && !hasCleanedRef.current) {
      hasCleanedRef.current = true;
      pendingBootstrapAfterLocalResetRef.current = true;
      clearAllComments({ resetAppliedCommentImportIds: true });
      clearViewedFiles();
      console.log(
        '✅ All existing comments and viewed files cleared as requested via --clean flag',
      );
    }
  }, [diffData?.clearComments, clearAllComments, clearViewedFiles]);

  useEffect(() => {
    if (!commentsContextKey || !hasLoadedComments) {
      return;
    }

    if (bootstrappedCommentsKey === commentsContextKey) {
      return;
    }

    if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
      return;
    }

    const shouldReplaceFromServer = pendingBootstrapAfterLocalResetRef.current;
    pendingBootstrapAfterLocalResetRef.current = false;

    bootstrappingCommentsKeyRef.current = commentsContextKey;
    let cancelled = false;

    const bootstrapComments = async () => {
      try {
        const serverThreads = await fetchServerThreads();
        const nextThreads = shouldReplaceFromServer
          ? serverThreads
          : mergeCommentThreads(serverThreads, threads).threads;
        if (cancelled) {
          return;
        }

        skipNextCommentSyncRef.current = true;
        replaceThreads(nextThreads);

        if (
          !shouldReplaceFromServer &&
          JSON.stringify(serverThreads) !== JSON.stringify(nextThreads)
        ) {
          await syncThreadsToServer(nextThreads);
        }
      } catch (commentsError) {
        if (!cancelled) {
          console.error('Failed to bootstrap comments from server:', commentsError);
        }
      } finally {
        if (!cancelled) {
          setBootstrappedCommentsKey(commentsContextKey);
        }
        if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
          bootstrappingCommentsKeyRef.current = null;
        }
      }
    };

    void bootstrapComments();

    return () => {
      cancelled = true;
      if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
        bootstrappingCommentsKeyRef.current = null;
      }
    };
  }, [
    bootstrappedCommentsKey,
    commentsContextKey,
    fetchServerThreads,
    hasLoadedComments,
    replaceThreads,
    syncThreadsToServer,
    threads,
  ]);

  useEffect(() => {
    if (!hasBootstrappedComments || hasSelectedInitialMainViewRef.current) {
      return;
    }

    hasSelectedInitialMainViewRef.current = true;
    setMainView(
      threads.some((thread) => !thread.closedAt && !thread.resolvedAt) ? 'comments' : 'diff',
    );
  }, [hasBootstrappedComments, threads]);

  // Trigger sparkle animation when all files are viewed
  useEffect(() => {
    if (diffData) {
      // Reset the trigger flag when not all files are viewed
      if (viewedFiles.size < diffData.files.length) {
        setHasTriggeredSparkles(false);
      }
      // Show sparkles when all files are viewed and not already triggered
      else if (viewedFiles.size === diffData.files.length && !hasTriggeredSparkles) {
        setShowSparkles(true);
        setHasTriggeredSparkles(true);
        // Hide sparkles after animation completes
        setTimeout(() => {
          setShowSparkles(false);
        }, 1000);
      }
    }
  }, [viewedFiles.size, diffData, hasTriggeredSparkles]);

  // Send comments to server whenever they change and before page unload
  useEffect(() => {
    if (!hasBootstrappedComments) {
      return;
    }

    const data = JSON.stringify({
      threads,
      baseVersion: serverCommentVersionRef.current ?? undefined,
      sessionEpoch: serverCommentSessionEpochRef.current ?? undefined,
    });
    const commentsApiUrl = getCommentApiUrl('/api/comments');

    // Also handle page unload
    const sendCommentsBeforeUnload = () => {
      // Use sendBeacon for reliable delivery during page unload, including empty states.
      navigator.sendBeacon(commentsApiUrl, data);
    };

    window.addEventListener('beforeunload', sendCommentsBeforeUnload);

    if (skipNextCommentSyncRef.current) {
      skipNextCommentSyncRef.current = false;
      return () => {
        window.removeEventListener('beforeunload', sendCommentsBeforeUnload);
      };
    }

    syncThreadsToServer(threads)
      .then(() => bumpAgentEventsRefresh())
      .catch((syncError) => {
        console.error('Failed to sync comments:', syncError);
      });

    return () => {
      window.removeEventListener('beforeunload', sendCommentsBeforeUnload);
    };
  }, [
    getCommentApiUrl,
    hasBootstrappedComments,
    syncThreadsToServer,
    threads,
    bumpAgentEventsRefresh,
  ]);

  // Establish SSE connection for tab close detection
  useEffect(() => {
    const eventSource = new EventSource(resolveEventSourceUrl('/api/heartbeat'));

    eventSource.onopen = () => {
      console.log('Connected to server heartbeat');
    };

    eventSource.onerror = () => {
      console.log('Server connection lost');
      eventSource.close();
    };

    // Cleanup on unmount
    return () => {
      eventSource.close();
    };
  }, []);

  const handleAddComment = useCallback(
    (
      file: string,
      line: LineNumber,
      body: string,
      codeContent?: string,
      side?: DiffSide,
    ): Promise<void> => {
      addThread({
        filePath: file,
        body,
        side: side || 'new',
        line: typeof line === 'number' ? line : { start: line[0], end: line[1] },
        codeSnapshot:
          codeContent !== undefined
            ? {
                content: codeContent,
                language: undefined,
              }
            : undefined,
      });
      return Promise.resolve();
    },
    [addThread],
  );

  const handleCopyAllComments = async () => {
    try {
      const prompt = generateAllCommentsPrompt({
        requestedBaseCommitish: diffData?.requestedBaseCommitish,
        requestedTargetCommitish: diffData?.requestedTargetCommitish,
        baseMode: normalizeBaseMode(diffData?.requestedBaseMode),
        resolvedBaseCommitish: diffData?.baseCommitish,
        resolvedTargetCommitish: diffData?.targetCommitish,
      });
      await copyTextToClipboard(prompt);
    } catch (error) {
      console.error('Failed to copy all comments prompt:', error);
    }
  };

  const handleReplyToThread = useCallback(
    (threadId: string, body: string): Promise<void> => {
      replyToThread({ threadId, body });
      return Promise.resolve();
    },
    [replyToThread],
  );

  const handleNavigateToComment = useCallback(
    (thread: CommentThread) => {
      if (!diffData) return;

      const fileIndex = diffData.files.findIndex((file) => file.path === thread.file);
      if (fileIndex === -1) return;

      const filePath = diffData.files[fileIndex]?.path;
      if (!filePath) return;

      // Expanded context lines live in navigableFiles rather than diffData.files.
      // This is especially common for outdated comments on unchanged lines.
      const position = findCommentPosition(thread, navigableFiles);

      setCodeFilterText('');
      if (isFileByFileView) {
        // Mount only the thread's file; renderedFilePaths is still bumped so
        // the pending-thread scroll effect re-runs once the content exists.
        setActiveSingleFilePath(filePath);
        ensureFileRendered(filePath);
      } else {
        ensureFilesRenderedUpTo(filePath);
      }
      setCollapsedFiles((current) => {
        if (!current.has(filePath)) return current;
        const next = new Set(current);
        next.delete(filePath);
        return next;
      });
      selectMainView('diff');

      if (position) {
        setPendingCommentThreadId(thread.id);
        setCursorPosition(position);
      } else {
        setPendingCommentThreadId(null);
        scrollFileIntoDiffContainer(filePath);
      }
    },
    [
      diffData,
      ensureFileRendered,
      ensureFilesRenderedUpTo,
      isFileByFileView,
      navigableFiles,
      scrollFileIntoDiffContainer,
      selectMainView,
      setCursorPosition,
    ],
  );

  const handleShowCode = useCallback(
    (thread: CommentThread) => {
      ensureFileRendered(thread.file);
      codePreviewExpansionKeyRef.current = null;
      setIsCodePreviewCollapsed(false);
      setCodePreviewFilePath(null);
      setCodePreviewThreadId(thread.id);
    },
    [ensureFileRendered],
  );

  const handleShowFileCode = useCallback(
    (filePath: string) => {
      ensureFileRendered(filePath);
      codePreviewExpansionKeyRef.current = null;
      setIsCodePreviewCollapsed(false);
      setCodePreviewThreadId(null);
      setCodePreviewFilePath(filePath);
    },
    [ensureFileRendered],
  );

  const handleCloseCodePreview = useCallback(() => {
    codePreviewExpansionKeyRef.current = null;
    setCodePreviewThreadId(null);
    setCodePreviewFilePath(null);
  }, []);

  const handleOpenInEditor = useCallback(
    async (filePath: string, lineNumber: number) => {
      try {
        const response = await fetch(resolveApiUrl('/api/open-in-editor'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filePath,
            line: lineNumber,
            editor: settings.editor,
          }),
        });

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          let message = response.statusText;
          if (
            payload &&
            typeof payload === 'object' &&
            'error' in payload &&
            typeof (payload as { error?: unknown }).error === 'string'
          ) {
            message = (payload as { error: string }).error;
          }
          console.error('Failed to open file in editor:', message);
        }
      } catch (error) {
        console.error('Failed to open file in editor:', error);
      }
    },
    [settings.editor],
  );

  const handleGlobalClick = (e: React.MouseEvent) => {
    // Clear cursor position
    setCursorPosition(null);

    // Check if clicking on a comment button
    const target = e.target as HTMLElement;
    const isCommentButton = target.closest('[data-comment-button="true"]');
    const isOpenInEditorButton = target.closest('[data-open-in-editor-button="true"]');
    const isShiftRangeClick = e.shiftKey && target.closest('[data-diff-line-row="true"]');

    // Close empty comment forms (unless clicking on a comment button)
    if (!isCommentButton && !isOpenInEditorButton && !isShiftRangeClick) {
      closeEmptyCommentForms(e);
    }
  };

  const closeEmptyCommentForms = (e: React.MouseEvent) => {
    const emptyForms = document.querySelectorAll('form[data-empty="true"]');
    emptyForms.forEach((form) => {
      // Don't close if clicking inside the form itself
      if (!form.contains(e.target as Node)) {
        const cancelButton = form.querySelector<HTMLButtonElement>('[data-comment-cancel="true"]');
        cancelButton?.click();
      }
    });
  };

  const reviewSwitcher = activeReviewId ? (
    <ReviewSwitcher
      activeReviewId={activeReviewId}
      reviews={reviews}
      sidebarWidth={sidebarWidth}
      sidebarOpen={isFileTreeOpen}
      isMobile={isMobile}
      onSelectReview={onSelectReview}
    />
  ) : null;

  if (loading) {
    return (
      <div className="flex h-screen flex-col bg-github-bg-primary">
        <ReviewLoadingHeader
          isMobile={isMobile}
          sidebarOpen={isFileTreeOpen}
          sidebarWidth={sidebarWidth}
        />
        {reviewSwitcher}
        <div className="flex flex-1 items-center justify-center text-base text-github-text-secondary">
          Loading diff...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col bg-github-bg-primary">
        <ReviewLoadingHeader
          isMobile={isMobile}
          sidebarOpen={isFileTreeOpen}
          sidebarWidth={sidebarWidth}
        />
        {reviewSwitcher}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <h2 className="mb-2 text-2xl text-github-danger">Error</h2>
          <p className="text-base text-github-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!diffData) {
    return (
      <div className="flex h-screen flex-col bg-github-bg-primary">
        <ReviewLoadingHeader
          isMobile={isMobile}
          sidebarOpen={isFileTreeOpen}
          sidebarWidth={sidebarWidth}
        />
        {reviewSwitcher}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <h2 className="mb-2 text-2xl text-github-danger">No data</h2>
          <p className="text-base text-github-text-secondary">No diff data available</p>
        </div>
      </div>
    );
  }

  const canOpenInEditor =
    diffData.openInEditorAvailable !== false &&
    settings.editor.id !== 'none' &&
    settings.editor.command.trim() !== '' &&
    settings.editor.argsTemplate.trim() !== '';
  const reviewsDashboardUrl = getReviewsDashboardUrl();

  return (
    <WordHighlightProvider>
      <div className="h-screen flex flex-col" onClickCapture={handleGlobalClick}>
        <header
          className={`shrink-0 bg-github-bg-secondary border-b border-github-border flex ${
            isMobile ? 'flex-col' : 'flex-row items-center'
          } ${isMobile ? 'min-h-[97px]' : 'min-h-[61px]'}`}
        >
          <div
            className={`flex items-center justify-between w-full ${
              isMobile ? 'px-3 py-2 gap-3' : 'px-4 py-3 gap-4 w-auto'
            } ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
            style={{
              width: isMobile ? '100%' : isFileTreeOpen ? `${sidebarWidth}px` : 'auto',
              minWidth: isMobile ? '0px' : isFileTreeOpen ? '200px' : 'auto',
              maxWidth: isMobile ? 'none' : isFileTreeOpen ? '600px' : 'none',
            }}
          >
            <h1>
              {reviewsDashboardUrl ? (
                <a href={reviewsDashboardUrl} title="Difit dashboard" aria-label="Difit dashboard">
                  <Logo
                    style={{
                      height: '18px',
                      color: 'var(--color-github-text-secondary)',
                    }}
                  />
                </a>
              ) : (
                <Logo
                  style={{
                    height: '18px',
                    color: 'var(--color-github-text-secondary)',
                  }}
                />
              )}
            </h1>
            <div className="flex items-center gap-1">
              {reviewsDashboardUrl && (
                <a
                  href={reviewsDashboardUrl}
                  className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                  title="Back to reviews"
                  aria-label="Back to reviews"
                >
                  <ArrowLeft size={18} />
                </a>
              )}
              <button
                onClick={() => setIsFileTreeOpen(!isFileTreeOpen)}
                className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                title={isFileTreeOpen ? 'Collapse file tree' : 'Expand file tree'}
                aria-expanded={isFileTreeOpen}
                aria-controls="file-tree-panel"
                aria-label="Toggle file tree panel"
              >
                {isFileTreeOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                title="Settings"
              >
                <Settings size={18} />
              </button>
            </div>
          </div>
          {!isMobile && (
            <div
              className={`border-r border-github-border ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                width: isFileTreeOpen ? '4px' : '0px',
                height: 'calc(100% - 16px)',
                margin: '8px 0',
                transform: 'translateX(-2px)',
              }}
            />
          )}
          <div
            className={`flex-1 flex flex-wrap items-center justify-between ${
              isMobile ? 'px-3 pb-2 gap-3' : 'px-4 py-3 gap-4'
            }`}
          >
            <div className={`flex flex-wrap items-center ${isMobile ? 'gap-2' : 'gap-3'}`}>
              <div className="flex bg-github-bg-tertiary border border-github-border rounded-md p-1">
                {!isMobile && (
                  <>
                    <button
                      onClick={() => {
                        selectMainView('diff');
                        handleDiffModeChange('split');
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                        mainView === 'diff' && diffMode === 'split'
                          ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                          : 'text-github-text-secondary hover:text-github-text-primary'
                      }`}
                    >
                      <Columns size={14} />
                      Split
                    </button>
                    <button
                      onClick={() => {
                        selectMainView('diff');
                        handleDiffModeChange('unified');
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                        mainView === 'diff' && diffMode === 'unified'
                          ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                          : 'text-github-text-secondary hover:text-github-text-primary'
                      }`}
                    >
                      <AlignLeft size={14} />
                      Unified
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => selectMainView('comments')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                    mainView === 'comments'
                      ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                      : 'text-github-text-secondary hover:text-github-text-primary'
                  }`}
                >
                  <List size={14} />
                  Comments ({threads.length})
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  handleDiffLayoutModeChange(isFileByFileView ? 'all-files' : 'file-by-file')
                }
                aria-pressed={isFileByFileView}
                title={
                  isFileByFileView
                    ? 'Showing one file at a time. Click to show all files.'
                    : 'Show one file at a time (useful for very large diffs)'
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs transition-colors ${
                  isFileByFileView
                    ? 'border-blue-500 bg-blue-500/10 text-github-text-primary'
                    : 'border-github-border text-github-text-secondary hover:bg-github-bg-tertiary hover:text-github-text-primary'
                }`}
              >
                <FileStack size={14} />
                <span className={isMobile ? 'sr-only' : undefined}>File by file</span>
              </button>
              {mainView === 'diff' && closedThreadCount > 0 && (
                <button
                  type="button"
                  aria-pressed={showResolvedComments}
                  aria-label={
                    showResolvedComments
                      ? 'Hide closed comments'
                      : `Show closed comments (${closedThreadCount})`
                  }
                  title={
                    showResolvedComments
                      ? 'Hide closed comments'
                      : `Show closed comments (${closedThreadCount})`
                  }
                  onClick={toggleResolvedComments}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs transition-colors ${
                    showResolvedComments
                      ? 'border-blue-500 bg-blue-500/10 text-github-text-primary'
                      : 'border-github-border text-github-text-secondary hover:bg-github-bg-tertiary hover:text-github-text-primary'
                  }`}
                >
                  {showResolvedComments ? <Eye size={14} /> : <EyeOff size={14} />}
                  <span className={isMobile ? 'sr-only' : undefined}>
                    Closed ({closedThreadCount})
                  </span>
                </button>
              )}
              {agentEventsStatus?.wakeAvailable && agentEventsStatus.pendingCount > 0 && (
                <SendToAgentButton
                  pendingCount={agentEventsStatus.pendingCount}
                  wakeOutstanding={agentEventsStatus.wakeOutstanding}
                  wakeScheduledAt={agentEventsStatus.wakeScheduledAt}
                  isFlushing={isFlushingAgentEvents}
                  isMobile={isMobile}
                  onFlush={() => void handleFlushAgentEvents()}
                />
              )}
              {/* File Watch Reload Button */}
              <ReloadButton
                shouldReload={shouldReload}
                isReloading={watchState.isReloading}
                onReload={reload}
                changeType={watchState.lastChangeType}
                compact={isMobile}
              />
            </div>
            <div
              className={`flex flex-wrap items-center text-sm text-github-text-secondary ${
                isMobile ? 'gap-3' : 'gap-4'
              }`}
            >
              {diffData.reviewUrl && (
                <a
                  href={buildGitLabMergeRequestUrl(diffData.reviewUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-github-accent bg-github-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:brightness-110"
                  title="Open merge request in GitLab"
                >
                  <ExternalLink size={14} />
                  Open MR
                </a>
              )}
              <div className="flex flex-col gap-1 items-center">
                <div className="text-xs relative">
                  {viewedFiles.size === diffData.files.length
                    ? 'All diffs difit-ed!'
                    : `${viewedFiles.size} / ${diffData.files.length} files viewed`}
                  <SparkleAnimation isActive={showSparkles} />
                </div>
                <div
                  className="relative h-2 bg-github-bg-tertiary rounded-full overflow-hidden"
                  style={{
                    width: '90px',
                    border: '1px solid var(--color-github-border)',
                  }}
                >
                  <div
                    className="absolute top-0 right-0 h-full transition-all duration-300 ease-out"
                    style={{
                      width: `${((diffData.files.length - viewedFiles.size) / diffData.files.length) * 100}%`,
                      backgroundColor: (() => {
                        const remainingPercent =
                          ((diffData.files.length - viewedFiles.size) / diffData.files.length) *
                          100;
                        if (remainingPercent > 50) return 'var(--color-github-accent)'; // green
                        if (remainingPercent > 20) return 'var(--color-github-warning)'; // yellow
                        return 'var(--color-github-danger)'; // red
                      })(),
                    }}
                  />
                </div>
              </div>
              {revisionOptions ? (
                <DiffQuickMenu
                  options={revisionOptions}
                  selection={selectedRevision}
                  resolvedBaseRevision={resolvedBaseRevision}
                  resolvedTargetRevision={resolvedTargetRevision}
                  onSelectDiff={(selection) => void handleRevisionChange(selection)}
                  onOpenAdvanced={() => setIsRevisionModalOpen(true)}
                  compact={!isDesktop}
                />
              ) : (
                <span className="text-xs">
                  Reviewing:{' '}
                  <code className="bg-github-bg-tertiary px-1.5 py-0.5 rounded text-xs text-github-text-primary">
                    {diffData.commit.includes('...') ? (
                      <>
                        <span className="text-github-text-secondary font-medium">
                          {diffData.commit.split('...')[0]}...
                        </span>
                        <span className="font-medium">{diffData.commit.split('...')[1]}</span>
                      </>
                    ) : (
                      diffData.commit
                    )}
                  </code>
                </span>
              )}
            </div>
          </div>
        </header>
        {reviewSwitcher}
        {diffData.reviewOffline && (
          <div
            role="alert"
            className="border-b border-amber-500 bg-amber-950/40 px-4 py-3 text-sm text-amber-200"
          >
            This review is offline. You are viewing a saved snapshot
            {diffData.reviewSnapshotAt
              ? ` from ${new Date(diffData.reviewSnapshotAt).toLocaleString()}`
              : ''}
            . Changes on disk will not appear until the review process reconnects.
          </div>
        )}
        {diffData.reviewStale && (
          <div
            role="alert"
            className="border-b border-github-danger bg-red-950/40 px-4 py-3 text-sm text-github-danger"
          >
            This checkout changed from{' '}
            <code className="font-mono text-github-text-primary">{diffData.reviewBranch}</code> to{' '}
            <code className="font-mono text-github-text-primary">
              {diffData.currentBranch ?? 'detached HEAD'}
            </code>
            . This review is read-only. Open Difit for the current branch to keep comments isolated.
          </div>
        )}
        {revisionOptions && (
          <RevisionDetailModal
            key={isRevisionModalOpen ? getDiffSelectionKey(selectedRevision) : 'closed'}
            isOpen={isRevisionModalOpen}
            onClose={() => setIsRevisionModalOpen(false)}
            options={revisionOptions}
            selection={selectedRevision}
            resolvedBaseRevision={resolvedBaseRevision}
            resolvedTargetRevision={resolvedTargetRevision}
            onApply={(selection) => void handleRevisionChange(selection)}
          />
        )}

        {(codePreviewThread || codePreviewFilePath) &&
          codePreviewFile &&
          codePreviewNavigableFile && (
            <CodePreviewModal
              thread={codePreviewThread ?? undefined}
              filePath={codePreviewThread?.file ?? codePreviewFilePath ?? ''}
              targetPosition={codePreviewPosition}
              isLoading={isCodePreviewExpandLoading || codePreviewHasHiddenLines}
              onClose={handleCloseCodePreview}
            >
              <DiffViewer
                file={codePreviewFile}
                threads={EMPTY_COMMENT_THREADS}
                showAuthorBadges={showAuthorBadges}
                reviewUrl={diffData.reviewUrl}
                diffMode={diffMode}
                reviewedFiles={viewedFiles}
                isChangedSinceViewed={changedSinceViewedFiles.has(codePreviewFile.path)}
                onToggleReviewed={handleViewedButtonToggle}
                collapsedFiles={
                  isCodePreviewCollapsed ? new Set([codePreviewFile.path]) : new Set()
                }
                onToggleCollapsed={() => setIsCodePreviewCollapsed((collapsed) => !collapsed)}
                onToggleAllCollapsed={setIsCodePreviewCollapsed}
                onAddComment={handleAddComment}
                onGenerateThreadPrompt={handleGenerateThreadPrompt}
                onRemoveThread={removeThread}
                onDeleteThread={deleteThread}
                onThreadStatusChange={handleThreadStatusChange}
                onReplyToThread={handleReplyToThread}
                onRemoveMessage={removeMessage}
                onUpdateMessage={updateMessage}
                onOpenInEditor={canOpenInEditor ? handleOpenInEditor : undefined}
                syntaxTheme={settings.syntaxTheme}
                baseCommitish={diffData.baseCommitish}
                targetCommitish={diffData.targetCommitish}
                cursor={codePreviewPosition}
                isFocused={true}
                fileIndex={0}
                mergedChunks={codePreviewMergedChunks}
                expandLines={expandCodePreviewLines}
                expandAllBetweenChunks={expandAllCodePreviewBetweenChunks}
                prefetchFileContent={prefetchCodePreviewFileContent}
                isExpandLoading={isCodePreviewExpandLoading}
                diffVersion={diffDataVersion}
              />
            </CodePreviewModal>
          )}

        {mainView === null && (
          <main className="flex flex-1 items-center justify-center text-sm text-github-text-secondary">
            Loading comments…
          </main>
        )}

        {mainView === 'comments' && (
          <CommentsView
            comments={normalizedThreads}
            showAuthorBadges={showAuthorBadges}
            reviewUrl={diffData.reviewUrl}
            files={diffData.files}
            onRemoveThread={removeThread}
            onDeleteThread={deleteThread}
            onThreadStatusChange={handleThreadStatusChange}
            onNavigateToCode={handleNavigateToComment}
            onShowCode={handleShowCode}
            onGenerateThreadPrompt={handleGenerateThreadPrompt}
            onReplyToThread={handleReplyToThread}
            onRemoveMessage={removeMessage}
            onUpdateMessage={updateMessage}
            syntaxTheme={settings.syntaxTheme}
          />
        )}

        {mainView === 'diff' && isMobile && isFileTreeOpen && (
          <button
            type="button"
            aria-label="Close file tree"
            className="fixed inset-0 bg-black/40 z-30"
            onClick={() => setIsFileTreeOpen(false)}
          />
        )}

        {mainView === 'diff' && isFileByFileView && activeSingleFileEntry && (
          <>
            <SingleFileToolbar
              filePath={activeSingleFileEntry.file.path}
              fileIndex={visibleDiffFiles.findIndex(
                (entry) => entry.fileIndex === activeSingleFileEntry.fileIndex,
              )}
              totalFiles={visibleDiffFiles.length}
              onShowAllFiles={() => handleDiffLayoutModeChange('all-files')}
            />
            <FileByFileNavButtons
              fileIndex={visibleDiffFiles.findIndex(
                (entry) => entry.fileIndex === activeSingleFileEntry.fileIndex,
              )}
              totalFiles={visibleDiffFiles.length}
              onSelectIndex={(index) => {
                const entry = visibleDiffFiles[index];
                if (entry) {
                  scrollVisibleFileIntoDiffContainer(entry.file.path);
                }
              }}
            />
          </>
        )}

        <div
          className={`flex flex-1 overflow-hidden relative ${mainView !== 'diff' ? 'hidden' : ''}`}
        >
          <div
            className={`relative overflow-hidden ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
            style={{
              width: isMobile ? '0px' : isFileTreeOpen ? `${sidebarWidth}px` : '0px',
            }}
          >
            <aside
              id="file-tree-panel"
              className={`bg-github-bg-secondary overflow-y-auto flex flex-col ${
                isMobile
                  ? 'fixed inset-y-0 right-0 z-40 w-[min(85vw,360px)] border-l border-github-border transition-transform duration-300 ease-out'
                  : 'relative border-r border-github-border'
              }`}
              style={{
                width: isMobile ? 'min(85vw, 360px)' : `${sidebarWidth}px`,
                minWidth: isMobile ? '0px' : '200px',
                maxWidth: isMobile ? 'none' : '600px',
                height: '100%',
                transform: isMobile
                  ? isFileTreeOpen
                    ? 'translateX(0)'
                    : 'translateX(100%)'
                  : undefined,
              }}
            >
              <div className="flex-1 overflow-y-auto">
                <FileList
                  files={diffData.files}
                  onScrollToFile={scrollVisibleFileIntoDiffContainer}
                  onFileSelected={isMobile ? handleMobileFileSelected : undefined}
                  comments={diffThreads}
                  reviewedFiles={viewedFiles}
                  onToggleReviewed={toggleFileReviewed}
                  onToggleFolderReviewed={toggleFolderReviewed}
                  selectedFileIndex={
                    cursor?.fileIndex ??
                    (isFileByFileView && activeSingleFileEntry
                      ? activeSingleFileEntry.fileIndex
                      : null)
                  }
                  codeFilterText={codeFilterText}
                  onCodeFilterTextChange={setCodeFilterText}
                />
              </div>
              {!isMobile && (
                <div className="p-4 border-t border-github-border flex justify-between items-center">
                  <button
                    onClick={() => setIsHelpOpen(true)}
                    className="flex items-center gap-1.5 text-github-text-secondary hover:text-github-text-primary transition-colors"
                    title="Keyboard shortcuts (Shift+?)"
                  >
                    <Keyboard size={16} />
                    <span className="text-sm">Shortcuts</span>
                  </button>
                  <a
                    href="https://github.com/yoshiko-pg/difit"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-github-text-secondary hover:text-github-text-primary transition-colors"
                    title="View on GitHub"
                  >
                    <span className="text-sm">Star on GitHub</span>
                    <GitHubIcon style={{ height: '18px', width: '18px' }} />
                  </a>
                </div>
              )}
            </aside>
          </div>

          {!isMobile && (
            <div
              className={`bg-github-border hover:bg-github-text-muted cursor-col-resize ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                width: isFileTreeOpen ? '4px' : '0px',
              }}
              onMouseDown={handleMouseDown}
              title="Drag to resize file list"
            />
          )}

          <main
            ref={diffScrollContainerRef}
            className={`flex-1 overflow-y-auto ${showMobileCommentsBar ? 'pb-16' : ''}`}
          >
            {visibleDiffFiles.map(({ file, fileIndex }) => {
              // In file-by-file mode only the active file is mounted.
              if (isFileByFileView && activeSingleFileEntry?.fileIndex !== fileIndex) {
                return null;
              }
              const fileThreads = threadsByFile.get(file.path) ?? EMPTY_COMMENT_THREADS;
              const mergedChunks =
                getMergedChunksForVersion(mergedChunksState, diffDataVersion, file.path) ??
                EMPTY_MERGED_CHUNKS;
              const isRendered = isFileByFileView || renderedFilePaths.has(file.path);
              return (
                <div
                  key={file.path}
                  id={getFileElementId(file.path)}
                  data-file-path={file.path}
                  data-rendered={isRendered ? 'true' : 'false'}
                  ref={(node) => registerLazyFileContainer(file.path, node)}
                  className="diff-file-section mb-6"
                  onMouseEnter={() => {
                    hoveredFileIndexRef.current = fileIndex;
                  }}
                  onMouseLeave={() => {
                    if (hoveredFileIndexRef.current === fileIndex) {
                      hoveredFileIndexRef.current = null;
                    }
                  }}
                >
                  {isRendered ? (
                    <DiffViewer
                      file={file}
                      threads={fileThreads}
                      showAuthorBadges={showAuthorBadges}
                      reviewUrl={diffData.reviewUrl}
                      diffMode={diffMode}
                      reviewedFiles={viewedFiles}
                      isChangedSinceViewed={changedSinceViewedFiles.has(file.path)}
                      onToggleReviewed={handleViewedButtonToggle}
                      collapsedFiles={collapsedFiles}
                      onToggleCollapsed={toggleFileCollapsed}
                      onToggleAllCollapsed={toggleAllFilesCollapsed}
                      onAddComment={handleAddComment}
                      onGenerateThreadPrompt={handleGenerateThreadPrompt}
                      onRemoveThread={removeThread}
                      onDeleteThread={deleteThread}
                      onThreadStatusChange={handleThreadStatusChange}
                      onReplyToThread={handleReplyToThread}
                      onRemoveMessage={removeMessage}
                      onUpdateMessage={updateMessage}
                      onOpenInEditor={canOpenInEditor ? handleOpenInEditor : undefined}
                      onShowCode={handleShowFileCode}
                      syntaxTheme={settings.syntaxTheme}
                      baseCommitish={diffData.baseCommitish}
                      targetCommitish={diffData.targetCommitish}
                      cursor={cursor?.fileIndex === fileIndex ? cursor : null}
                      isFocused={cursor?.fileIndex === fileIndex}
                      fileIndex={fileIndex}
                      onLineClick={handleLineClick}
                      commentTrigger={
                        commentTrigger?.fileIndex === fileIndex ? commentTrigger : null
                      }
                      onCommentTriggerHandled={handleCommentTriggerHandled}
                      mergedChunks={mergedChunks}
                      expandLines={expandLines}
                      expandAllBetweenChunks={expandAllBetweenChunks}
                      prefetchFileContent={prefetchFileContent}
                      isExpandLoading={isExpandLoading}
                      diffVersion={diffDataVersion}
                    />
                  ) : (
                    <div className="bg-github-bg-secondary border border-github-border rounded-md px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs uppercase tracking-wide text-github-text-muted">
                            Deferred Rendering
                          </div>
                          <div className="text-sm font-mono text-github-text-primary truncate">
                            {file.path}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => ensureFileRendered(file.path)}
                          className="px-3 py-1.5 text-xs rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary"
                        >
                          Load now
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </main>
        </div>

        {showMobileCommentsBar && (
          <div className="fixed bottom-0 left-0 right-0 z-20 bg-github-bg-secondary border-t border-github-border px-4 py-2 flex justify-end">
            <button
              type="button"
              onClick={() => selectMainView('comments')}
              className="mr-2 flex items-center gap-1.5 rounded border border-github-border bg-github-bg-tertiary px-3 py-1.5 text-xs text-github-text-primary"
            >
              <List size={12} />
              Threads ({threads.length})
            </button>
          </div>
        )}

        {isSettingsOpen && (
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            settings={settings}
            onSettingsChange={updateSettings}
          />
        )}

        <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
      </div>
    </WordHighlightProvider>
  );
}

function App() {
  const { activeReviewId, reviews, selectReview } = useReviewRegistry();

  return (
    <ReviewWorkspace
      key={activeReviewId ?? 'direct-viewer'}
      activeReviewId={activeReviewId}
      reviews={reviews}
      onSelectReview={selectReview}
    />
  );
}

export default App;
