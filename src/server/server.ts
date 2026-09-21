import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { type Server } from 'http';
import { join, dirname, isAbsolute, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import express, { type Express } from 'express';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { type DiffMode } from '../types/watch.js';
import { formatCommentsOutput } from '../utils/commentFormatting.js';
import {
  mergeCommentImports,
  mergeCommentThreads,
  normalizeCommentImports,
  serializeCommentImports,
} from '../utils/commentImports.js';
import {
  buildEditorSpawnSpec,
  CUSTOM_EDITOR_ID,
  NONE_EDITOR_ID,
  resolveEditorOption,
} from '../utils/editorOptions.js';
import { getFileExtension } from '../utils/fileUtils.js';
import { createId } from '../utils/createId.js';

import { FileWatcherService } from './file-watcher.js';
import { AgentEventInbox } from './agent-event-inbox.js';
import { GitDiffParser } from './git-diff.js';
import {
  type AuthService,
  getAuthenticatedPrincipal,
  getDefaultAuthService,
  monitorAuthenticatedConnection,
  requireAuthentication,
  requireBrowserMutationOrigin,
} from './auth.js';
import { logoutHandler } from './auth-http.js';
import { readCommentSessions, writeCommentSessions } from './comment-storage.js';
import {
  createReviewContext,
  getReviewBranchState,
  type ReviewBranchState,
} from './review-context.js';
import { registerReview, reuseExistingWorkingTreeIdentity } from './review-registry.js';
import { updateHapiReviewLink } from './hapi-review-link.js';
import { writeReviewSnapshot } from './review-snapshot.js';
import {
  restrictCrossSiteBrowserRequests,
  restrictRequestHosts,
  restrictRequestOrigins,
  setSecurityHeaders,
} from './request-security.js';
import { parseUserSettingsPatch, readUserConfig, updateUserClientSettings } from './user-config.js';

import {
  type BaseMode,
  type CommentImport,
  type Comment,
  type CommentThread,
  type DiffCommentThread,
  type DiffResponse,
  type DiffSelection,
  type GeneratedStatusResponse,
  type RevisionsResponse,
} from '@/types/diff.js';
import {
  createDiffSelection,
  diffSelectionsEqual,
  getDiffSelectionKey,
} from '../utils/diffSelection.js';

export interface ServerOptions {
  selection?: DiffSelection;
  stdinDiff?: string;
  preferredPort?: number;
  host?: string;
  openBrowser?: boolean;
  ignoreWhitespace?: boolean;
  clearComments?: boolean;
  commentImports?: CommentImport[];
  keepAlive?: boolean;
  diffMode?: DiffMode;
  repoPath?: string;
  contextLines?: number;
  includeUntracked?: boolean;
  reviewUrl?: string;
  authService?: AuthService;
  reviewer?: boolean;
  noWake?: boolean;
}

const GENERATED_STATUS_CACHE_TTL_MS = 60_000;
const MAX_DIFF_CACHE_ENTRIES = 8;

function createDiffCacheKey(selection: DiffSelection, ignoreWhitespace: boolean) {
  return `${getDiffSelectionKey(selection)}\u0000${ignoreWhitespace ? '1' : '0'}`;
}

function isMutableDiffSelection(selection: DiffSelection): boolean {
  return ['.', 'working', 'staged'].includes(selection.targetCommitish);
}

function getCachedDiffResponse(
  cache: Map<string, DiffResponse>,
  key: string,
): DiffResponse | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }

  // Refresh insertion order to keep the most recently used entry.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCachedDiffResponse(cache: Map<string, DiffResponse>, key: string, value: DiffResponse) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    cache.delete(oldestKey);
  }
}

interface CommentSessionState {
  threads: DiffCommentThread[];
  version: number;
}

function createResolvedCommentSelection(
  responseDiffData: DiffResponse,
  fallbackSelection: DiffSelection,
  stdinDiff: boolean,
): DiffSelection {
  const baseCommitish =
    responseDiffData.baseCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.baseCommitish);
  const targetCommitish =
    responseDiffData.targetCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.targetCommitish);
  const baseMode = responseDiffData.requestedBaseMode ?? fallbackSelection.baseMode;

  return createDiffSelection(baseCommitish, targetCommitish, baseMode);
}

export async function startServer(options: ServerOptions): Promise<{
  port: number;
  url: string;
  browserUrl?: string;
  isEmpty?: boolean;
  server?: Server;
}> {
  const app = express();
  const auth = options.authService ?? getDefaultAuthService();
  await auth.initialize();
  const repositoryPath = resolve(options.repoPath ?? process.cwd());
  const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
  const initialCommentImports = options.commentImports || [];
  const requestedInitialSelection = options.selection ?? createDiffSelection('', '');
  const createdReviewContext =
    options.stdinDiff || !options.selection
      ? undefined
      : await createReviewContext({
          repositoryPath,
          repositoryId,
          selection: requestedInitialSelection,
          reviewUrl: options.reviewUrl,
        });
  const reviewContext = createdReviewContext
    ? await reuseExistingWorkingTreeIdentity(createdReviewContext)
    : undefined;
  const initialSelection =
    reviewContext?.followsBranch && options.reviewUrl
      ? createDiffSelection(
          requestedInitialSelection.baseCommitish,
          '.',
          requestedInitialSelection.baseMode,
        )
      : requestedInitialSelection;
  const commentImportId =
    initialCommentImports.length > 0
      ? createHash('sha256').update(serializeCommentImports(initialCommentImports)).digest('hex')
      : undefined;
  const parser = new GitDiffParser(repositoryPath, options.includeUntracked);
  let agentEventInbox: AgentEventInbox | undefined;
  const fileWatcher = new FileWatcherService();
  const generatedStatusCache = new Map<
    string,
    { value: GeneratedStatusResponse; expiresAt: number }
  >();
  const diffDataCache = new Map<string, DiffResponse>();
  const initialIgnoreWhitespace = options.ignoreWhitespace || false;
  const parseBaseMode = (value: unknown): BaseMode | undefined => {
    if (value === 'merge-base') {
      return 'merge-base';
    }

    return undefined;
  };

  app.use(restrictRequestHosts(options.host ? [options.host] : []));
  app.use(restrictRequestOrigins());
  app.use(restrictCrossSiteBrowserRequests());
  app.use(setSecurityHeaders());
  app.use(express.json({ limit: '100kb' }));
  app.use(express.text({ limit: '100kb' })); // For sendBeacon text/plain requests
  app.use(requireAuthentication(auth));
  app.use(requireBrowserMutationOrigin());
  app.post('/auth/logout', logoutHandler(auth));

  const readBranchState = async (): Promise<ReviewBranchState> =>
    reviewContext ? getReviewBranchState(reviewContext) : { stale: false };

  app.use(async (req, res, next) => {
    const mutatesComments =
      req.method !== 'GET' &&
      (req.path === '/api/comments' ||
        req.path === '/api/comment-imports' ||
        req.path.startsWith('/api/comments/'));
    if (!mutatesComments || !reviewContext?.followsBranch) {
      next();
      return;
    }

    const branchState = await readBranchState();
    if (!branchState.stale) {
      next();
      return;
    }

    res.status(409).json({
      error: 'Review checkout changed branch; this review is read-only',
      code: 'REVIEW_BRANCH_CHANGED',
      expectedBranch: reviewContext.branch,
      currentBranch: branchState.currentBranch,
    });
  });

  // Skip validation if using stdin diff
  if (!options.stdinDiff) {
    const isValidCommit = await parser.validateCommit(initialSelection.targetCommitish);
    if (!isValidCommit) {
      throw new Error(`Invalid or non-existent commit: ${initialSelection.targetCommitish}`);
    }
  }

  // Generate initial diff data for isEmpty check
  let initialDiffData: DiffResponse;
  if (options.stdinDiff) {
    // Parse stdin diff directly
    initialDiffData = parser.parseStdinDiff(options.stdinDiff);
  } else {
    initialDiffData = await parser.parseDiff(
      initialSelection,
      initialIgnoreWhitespace,
      options.contextLines,
    );
    if (!isMutableDiffSelection(initialSelection)) {
      setCachedDiffResponse(
        diffDataCache,
        createDiffCacheKey(initialSelection, initialIgnoreWhitespace),
        initialDiffData,
      );
    }
  }

  // Function to invalidate cache when file changes are detected
  const invalidateCache = () => {
    diffDataCache.clear();
    generatedStatusCache.clear();
    parser.clearResolvedCommitCache();
  };

  // Track current revisions for cache invalidation
  let currentSelection = initialSelection;
  let currentCommentSelection = createResolvedCommentSelection(
    initialDiffData,
    initialSelection,
    Boolean(options.stdinDiff),
  );
  const createCommentSessionKey = (selection: DiffSelection): string =>
    reviewContext && (reviewContext.followsBranch || reviewContext.reviewUrl)
      ? reviewContext.sessionKey
      : getDiffSelectionKey(selection);

  function parseRepositoryRelativePath(filepath: unknown):
    | { ok: true; path: string }
    | {
        ok: false;
        error: 'Invalid file path' | 'File path outside repository';
      } {
    if (typeof filepath !== 'string' || filepath.length === 0) {
      return { ok: false, error: 'Invalid file path' };
    }

    const normalizedFilepath = filepath.replace(/\\/g, '/');
    const hasParentTraversal = normalizedFilepath.split('/').some((segment) => segment === '..');
    if (isAbsolute(filepath) || normalizedFilepath.startsWith('/') || hasParentTraversal) {
      return { ok: false, error: 'File path outside repository' };
    }

    const resolvedPath = resolve(repositoryPath, normalizedFilepath);
    if (resolvedPath !== repositoryPath && !resolvedPath.startsWith(`${repositoryPath}${sep}`)) {
      return { ok: false, error: 'File path outside repository' };
    }

    return { ok: true, path: normalizedFilepath };
  }

  interface EditorRequest {
    readonly id: string | undefined;
  }

  function parseEditorRequest(value: unknown): EditorRequest {
    if (!value || typeof value !== 'object') {
      return { id: undefined };
    }
    const candidate = value as { id?: unknown };
    return {
      id: typeof candidate.id === 'string' ? candidate.id : undefined,
    };
  }

  const commentSessions = new Map<string, CommentSessionState>(
    Object.entries(await readCommentSessions(repositoryId)),
  );
  const commentSessionEpoch = createId();
  let commentPersistenceQueue = Promise.resolve();
  const persistCommentSessions = (): Promise<void> => {
    const snapshot = new Map(
      [...commentSessions].map(([key, session]) => [
        key,
        { threads: structuredClone(session.threads), version: session.version },
      ]),
    );
    const persistence = commentPersistenceQueue
      .catch(() => undefined)
      .then(() => writeCommentSessions(repositoryId, snapshot));
    commentPersistenceQueue = persistence;
    return persistence;
  };
  if (
    reviewContext &&
    reviewContext.reviewUrl &&
    !reviewContext.followsBranch &&
    !commentSessions.has(reviewContext.sessionKey)
  ) {
    const legacySession = reviewContext.legacySessionKeys
      .map((key) => commentSessions.get(key))
      .find((session) => session !== undefined);
    if (legacySession) {
      commentSessions.set(reviewContext.sessionKey, structuredClone(legacySession));
      await persistCommentSessions();
    }
  }
  const initialCommentThreads = mergeCommentImports([], initialCommentImports).threads;
  if (initialCommentThreads.length > 0) {
    const key = createCommentSessionKey(currentCommentSelection);
    const existing = commentSessions.get(key);
    commentSessions.set(key, {
      threads: mergeCommentThreads(existing?.threads ?? [], initialCommentThreads).threads,
      version: (existing?.version ?? 0) + 1,
    });
    await persistCommentSessions();
  }

  function getCommentSelectionFromQuery(query: Record<string, unknown>): DiffSelection {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';

    if (!hasBase && !hasTarget && !hasBaseMode) {
      return currentCommentSelection;
    }

    return createDiffSelection(
      hasBase ? (query.base as string) : currentCommentSelection.baseCommitish,
      hasTarget ? (query.target as string) : currentCommentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : currentCommentSelection.baseMode,
    );
  }

  function getOrCreateCommentSession(selection: DiffSelection): CommentSessionState {
    const key = createCommentSessionKey(selection);
    const existing = commentSessions.get(key);
    if (existing) {
      return existing;
    }

    const nextSession: CommentSessionState = {
      threads: [],
      version: 0,
    };
    commentSessions.set(key, nextSession);
    return nextSession;
  }

  app.get('/api/review-context', async (_req, res) => {
    if (!reviewContext) {
      res.status(404).json({ error: 'Review context is not available' });
      return;
    }

    const branchState = await readBranchState();
    res.json({
      id: reviewContext.id,
      repositoryId: reviewContext.repositoryId,
      repositoryPath: reviewContext.repositoryPath,
      sessionKey: reviewContext.sessionKey,
      branch: reviewContext.branch,
      baseRef: reviewContext.baseRef,
      targetRef: reviewContext.targetRef,
      reviewUrl: reviewContext.reviewUrl,
      followsBranch: reviewContext.followsBranch,
      stale: branchState.stale,
      currentBranch: branchState.currentBranch,
      currentHead: branchState.currentHead,
    });
  });

  app.get('/api/diff', async (req, res) => {
    const branchState = await readBranchState();
    const ignoreWhitespace = req.query.ignoreWhitespace === 'true';
    const hasBase = typeof req.query.base === 'string';
    const hasTarget = typeof req.query.target === 'string';
    const hasBaseMode = typeof req.query.baseMode === 'string';
    const requestedSelection = createDiffSelection(
      hasBase ? (req.query.base as string) : currentSelection.baseCommitish,
      hasTarget ? (req.query.target as string) : currentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(req.query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : currentSelection.baseMode,
    );
    const shouldIncludeCommentImports =
      initialCommentImports.length > 0 &&
      (Boolean(options.stdinDiff) || diffSelectionsEqual(requestedSelection, initialSelection));

    let responseDiffData = initialDiffData;
    if (!options.stdinDiff && !branchState.stale) {
      const cacheKey = createDiffCacheKey(requestedSelection, ignoreWhitespace);
      const mutableSelection = isMutableDiffSelection(requestedSelection);
      const cached = mutableSelection ? undefined : getCachedDiffResponse(diffDataCache, cacheKey);
      if (cached) {
        responseDiffData = cached;
      } else {
        try {
          responseDiffData = await parser.parseDiff(
            requestedSelection,
            ignoreWhitespace,
            options.contextLines,
          );
        } catch (error) {
          console.error('Error fetching diff:', error);
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to fetch diff',
          });
          return;
        }
        if (!mutableSelection) {
          setCachedDiffResponse(diffDataCache, cacheKey, responseDiffData);
        }
        generatedStatusCache.clear();
      }
    }

    currentSelection = requestedSelection;

    currentCommentSelection = createResolvedCommentSelection(
      responseDiffData,
      requestedSelection,
      Boolean(options.stdinDiff),
    );

    const baseCommitish =
      responseDiffData.baseCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const targetCommitish =
      responseDiffData.targetCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const requestedBaseCommitish =
      responseDiffData.requestedBaseCommitish ??
      (requestedSelection.baseCommitish || (options.stdinDiff ? 'stdin' : undefined));
    const requestedTargetCommitish =
      responseDiffData.requestedTargetCommitish ??
      (requestedSelection.targetCommitish || (options.stdinDiff ? 'stdin' : undefined));
    const requestedBaseMode = responseDiffData.requestedBaseMode ?? requestedSelection.baseMode;

    const responsePayload: DiffResponse = {
      ...responseDiffData,
      ignoreWhitespace,
      openInEditorAvailable: !options.stdinDiff,
      baseCommitish,
      targetCommitish,
      requestedBaseCommitish,
      requestedTargetCommitish,
      requestedBaseMode,
      clearComments: options.clearComments,
      repositoryId,
      reviewUrl: options.reviewUrl,
      commentImports: shouldIncludeCommentImports ? initialCommentImports : undefined,
      commentImportId: shouldIncludeCommentImports ? commentImportId : undefined,
      reviewId: reviewContext?.id,
      reviewBranch: reviewContext?.branch,
      reviewStale: branchState.stale,
      currentBranch: branchState.currentBranch,
    };

    if (reviewContext && !branchState.stale && !hasBase && !hasTarget && !hasBaseMode) {
      await writeReviewSnapshot(reviewContext.id, {
        ...responsePayload,
        openInEditorAvailable: false,
        clearComments: false,
        commentImports: undefined,
        commentImportId: undefined,
      });
    }

    res.json(responsePayload);
  });

  app.get(/^\/api\/generated-status\/(.*)$/, async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Generated status is not available for stdin diff' });
      return;
    }

    try {
      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const normalizedFilepath = filepathResult.path;

      const ref = (req.query.ref as string) || currentSelection.targetCommitish || 'HEAD';
      const cacheKey = `${ref}:${normalizedFilepath}`;
      const now = Date.now();
      const cached = generatedStatusCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.json(cached.value);
        return;
      }

      const status = await parser.getGeneratedStatus(normalizedFilepath, ref);
      const response: GeneratedStatusResponse = {
        path: normalizedFilepath,
        ref,
        ...status,
      };
      generatedStatusCache.set(cacheKey, {
        value: response,
        expiresAt: now + GENERATED_STATUS_CACHE_TTL_MS,
      });

      res.json(response);
    } catch (error) {
      console.error('Error fetching generated status:', error);
      res.status(500).json({ error: 'Failed to get generated status' });
    }
  });

  // Get available revisions for revision selector
  app.get('/api/revisions', async (_req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Revision selection not available for stdin diff' });
      return;
    }

    try {
      const { branches, commits, originDefaultBranch, resolvedBase, resolvedTarget } =
        await parser.getRevisionOptions(
          currentSelection.baseCommitish,
          currentSelection.targetCommitish,
        );

      const response: RevisionsResponse = {
        specialOptions: [
          { value: '.', label: 'All Uncommitted Changes' },
          { value: 'staged', label: 'Staging Area' },
          { value: 'working', label: 'Working Directory' },
        ],
        branches,
        commits,
        originDefaultBranch,
        resolvedBase,
        resolvedTarget,
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching revisions:', error);
      res.status(500).json({ error: 'Failed to fetch revisions' });
    }
  });

  app.get(/^\/api\/line-count\/(.*)$/, async (req, res) => {
    try {
      if (options.stdinDiff) {
        res.status(404).json({ error: 'Line count not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const oldRef = req.query.oldRef as string | undefined;
      const oldPathResult = req.query.oldPath
        ? parseRepositoryRelativePath(req.query.oldPath)
        : { ok: true as const, path: filepath };
      if (!oldPathResult.ok) {
        res.status(400).json({ error: oldPathResult.error });
        return;
      }
      const newRef = req.query.newRef as string | undefined;
      const oldPath = oldPathResult.path;

      const result: { oldLineCount?: number; newLineCount?: number } = {};

      if (oldRef) {
        try {
          result.oldLineCount = await parser.getLineCount(oldPath, oldRef);
        } catch {
          result.oldLineCount = 0;
        }
      }
      if (newRef) {
        try {
          result.newLineCount = await parser.getLineCount(filepath, newRef);
        } catch {
          result.newLineCount = 0;
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Error fetching line count:', error);
      res.status(500).json({ error: 'Failed to get line count' });
    }
  });

  app.get(/^\/api\/blob\/(.*)$/, async (req, res) => {
    try {
      // If using stdin diff, blob content is not available
      if (options.stdinDiff) {
        res.status(404).json({ error: 'Blob content not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const ref = (req.query.ref as string) || 'HEAD';

      const blob = await parser.getBlobContent(filepath, ref);

      // Determine content type based on file extension
      const ext = getFileExtension(filepath);
      const contentTypes: { [key: string]: string } = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        bmp: 'image/bmp',
        svg: 'text/plain; charset=utf-8',
        webp: 'image/webp',
        ico: 'image/x-icon',
        tiff: 'image/tiff',
        tif: 'image/tiff',
        avif: 'image/avif',
        heic: 'image/heic',
        heif: 'image/heif',
      };

      const contentType = contentTypes[ext || ''] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(blob);
    } catch (error) {
      console.error('Error fetching blob:', error);
      res.status(404).json({ error: 'File not found' });
    }
  });

  function normalizeLineValue(line: unknown): DiffCommentThread['position']['line'] {
    if (Array.isArray(line) && line.length === 2) {
      const start = line[0] as unknown;
      const end = line[1] as unknown;
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start > 0 &&
        end > 0 &&
        start <= end
      ) {
        return { start, end };
      }
    }

    if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
      return line;
    }

    return 1;
  }

  function normalizeComment(comment: Comment): DiffCommentThread {
    const now = new Date().toISOString();
    const timestamp = typeof comment.timestamp === 'string' ? comment.timestamp : now;
    const threadId =
      typeof comment.id === 'string' && comment.id.length > 0
        ? comment.id
        : createHash('sha256').update(JSON.stringify(comment)).digest('hex').slice(0, 12);
    const filePath =
      typeof comment.file === 'string' && comment.file.length > 0 ? comment.file : '<unknown file>';

    return {
      id: threadId,
      filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      position: {
        side: comment.side ?? 'new',
        line: normalizeLineValue(comment.line),
      },
      codeSnapshot:
        typeof comment.codeContent === 'string'
          ? {
              content: comment.codeContent,
            }
          : undefined,
      messages: [
        {
          id: threadId,
          body: comment.body,
          author: comment.author,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  }

  function toCommentThread(thread: DiffCommentThread): CommentThread {
    return {
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
      messages: thread.messages,
    };
  }

  function normalizeThreadPayload(thread: CommentThread | DiffCommentThread): DiffCommentThread {
    if ('filePath' in thread && 'position' in thread) {
      return thread;
    }

    const threadId =
      typeof thread.id === 'string' && thread.id.length > 0
        ? thread.id
        : createHash('sha256').update(JSON.stringify(thread)).digest('hex').slice(0, 12);
    const now = new Date().toISOString();
    const messages =
      Array.isArray(thread.messages) && thread.messages.length > 0
        ? thread.messages.map((message, index) => ({
            id:
              typeof message.id === 'string' && message.id.length > 0
                ? message.id
                : `${threadId}:${index}`,
            body: message.body,
            author: message.author,
            createdAt: message.createdAt || thread.createdAt || now,
            updatedAt: message.updatedAt || message.createdAt || thread.updatedAt || now,
          }))
        : [
            {
              id: threadId,
              body: '',
              createdAt: thread.createdAt || now,
              updatedAt: thread.updatedAt || thread.createdAt || now,
            },
          ];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
      id: threadId,
      filePath:
        typeof thread.file === 'string' && thread.file.length > 0 ? thread.file : '<unknown file>',
      createdAt: thread.createdAt || firstMessage?.createdAt || now,
      updatedAt: thread.updatedAt || lastMessage?.updatedAt || thread.createdAt || now,
      acceptedAt: thread.acceptedAt,
      changesRequestedAt: thread.changesRequestedAt,
      toVerifyAt: thread.toVerifyAt,
      readyAt: thread.readyAt,
      closedAt: thread.closedAt,
      resolvedAt: thread.resolvedAt,
      position: {
        side: thread.side ?? 'new',
        line: normalizeLineValue(thread.line),
      },
      codeSnapshot:
        typeof thread.codeContent === 'string'
          ? {
              content: thread.codeContent,
            }
          : undefined,
      messages,
    };
  }

  function parseCommentsPayload(body: unknown): DiffCommentThread[] {
    const payload =
      typeof body === 'string'
        ? (JSON.parse(body) as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          })
        : (body as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          });

    if (Array.isArray(payload.threads)) {
      return payload.threads.map(normalizeThreadPayload);
    }

    if (Array.isArray(payload.comments)) {
      return payload.comments.map(normalizeComment);
    }

    return [];
  }

  // Version the client based its push on (omitted by older clients).
  function parseBaseVersion(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as { baseVersion?: unknown }).baseVersion;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  function parseSessionEpoch(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as { sessionEpoch?: unknown }).sessionEpoch;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  function parseCommentImportsPayload(body: unknown): CommentImport[] {
    if (typeof body === 'string') {
      return normalizeCommentImports(JSON.parse(body));
    }

    return normalizeCommentImports(body);
  }

  async function updateCommentSession(
    selection: DiffSelection,
    nextThreads: DiffCommentThread[],
    wakeAgent = false,
  ): Promise<boolean> {
    const session = getOrCreateCommentSession(selection);
    const previousThreads = session.threads;
    const previous = JSON.stringify(session.threads);
    const next = JSON.stringify(nextThreads);
    session.threads = nextThreads;

    if (previous === next) {
      return false;
    }

    session.version += 1;
    await persistCommentSessions();
    fileWatcher.broadcast({
      type: 'commentsChanged',
      version: session.version,
      timestamp: new Date().toISOString(),
    });
    if (wakeAgent) {
      await agentEventInbox?.recordChanges(previousThreads, nextThreads);
    }
    return true;
  }

  app.post('/api/comments', async (req, res) => {
    try {
      const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
      const body: unknown =
        typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body;
      const nextThreads = parseCommentsPayload(body);
      const baseVersion = parseBaseVersion(body);
      const sessionEpoch = parseSessionEpoch(body);
      const session = getOrCreateCommentSession(selection);

      if (sessionEpoch !== commentSessionEpoch) {
        res.status(409).json({
          success: false,
          staleClient: true,
          sessionEpoch: commentSessionEpoch,
          version: session.version,
          threads: session.threads,
        });
        return;
      }

      // Stale baseVersion means another writer (e.g. an agent) changed comments since the
      // client's last read, so merge rather than overwrite. A matching/absent version replaces.
      const isStale = typeof baseVersion === 'number' && baseVersion !== session.version;
      const resolvedThreads = isStale
        ? mergeCommentThreads(session.threads, nextThreads).threads
        : nextThreads;

      const principal = getAuthenticatedPrincipal(res.locals as Record<string, unknown>);
      await updateCommentSession(selection, resolvedThreads, principal.kind !== 'cli');

      res.json({
        success: true,
        merged: isStale,
        sessionEpoch: commentSessionEpoch,
        version: session.version,
        threads: session.threads,
      });
    } catch (error) {
      console.error('Error parsing comments:', error);
      res.status(400).json({ error: 'Invalid comment data' });
    }
  });

  app.post('/api/comment-imports', async (req, res) => {
    try {
      const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
      const session = getOrCreateCommentSession(selection);
      const commentImports = parseCommentImportsPayload(req.body);
      const importId = createHash('sha256')
        .update(serializeCommentImports(commentImports))
        .digest('hex');
      const merged = mergeCommentImports(session.threads, commentImports);
      const changed = await updateCommentSession(selection, merged.threads);

      res.json({
        success: true,
        changed,
        count: commentImports.length,
        importId,
        warnings: merged.warnings,
      });
    } catch (error) {
      console.error('Error parsing comment imports:', error);
      res.status(400).json({ error: 'Invalid comment import data' });
    }
  });

  app.post('/api/comments/:threadId/messages', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    const threadId = req.params.threadId;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'Comment body must not be empty' });
      return;
    }

    const existingThread = session.threads.find((thread) => thread.id === threadId);
    if (!existingThread) {
      res.status(404).json({ error: `Thread not found: ${threadId}` });
      return;
    }

    const now = new Date().toISOString();
    const message = {
      id: createId(),
      body,
      author: 'Agent',
      createdAt: now,
      updatedAt: now,
    };
    const nextThreads = session.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            updatedAt: now,
            messages: [...thread.messages, message],
          }
        : thread,
    );

    await updateCommentSession(selection, nextThreads);
    res.json({ success: true, threadId, message, version: session.version });
  });

  app.patch('/api/comments/:threadId/messages/:messageId', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    const threadId = req.params.threadId;
    const messageId = req.params.messageId;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'Comment body must not be empty' });
      return;
    }

    const existingThread = session.threads.find((thread) => thread.id === threadId);
    const existingMessage = existingThread?.messages.find((message) => message.id === messageId);
    if (!existingThread || !existingMessage) {
      res.status(404).json({ error: `Comment message not found: ${threadId}/${messageId}` });
      return;
    }

    const now = new Date().toISOString();
    const message = { ...existingMessage, body, updatedAt: now };
    const nextThreads = session.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            updatedAt: now,
            messages: thread.messages.map((item) => (item.id === messageId ? message : item)),
          }
        : thread,
    );

    await updateCommentSession(selection, nextThreads);
    res.json({ success: true, threadId, message, version: session.version });
  });

  app.delete('/api/comments/:threadId', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    const threadId = req.params.threadId;
    const existingThread = session.threads.find((thread) => thread.id === threadId);
    if (!existingThread) {
      res.status(404).json({ error: `Thread not found: ${threadId}` });
      return;
    }

    const now = new Date().toISOString();
    const nextThreads = session.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            updatedAt: now,
            acceptedAt: undefined,
            changesRequestedAt: undefined,
            toVerifyAt: undefined,
            readyAt: undefined,
            closedAt: undefined,
            resolvedAt: now,
          }
        : thread,
    );

    await updateCommentSession(selection, nextThreads);

    res.json({
      success: true,
      threadId,
      version: session.version,
    });
  });

  app.patch('/api/comments/:threadId/status', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    const threadId = req.params.threadId;
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (
      status !== 'open' &&
      status !== 'accepted' &&
      status !== 'changes_requested' &&
      status !== 'to_verify' &&
      status !== 'ready' &&
      status !== 'closed' &&
      status !== 'resolved'
    ) {
      res.status(400).json({ error: 'Invalid thread status' });
      return;
    }

    const existingThread = session.threads.find((thread) => thread.id === threadId);
    if (!existingThread) {
      res.status(404).json({ error: `Thread not found: ${threadId}` });
      return;
    }

    const now = new Date().toISOString();
    const nextThreads = session.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            updatedAt: now,
            acceptedAt: status === 'accepted' ? now : undefined,
            changesRequestedAt: status === 'changes_requested' ? now : undefined,
            toVerifyAt: status === 'to_verify' ? now : undefined,
            readyAt: status === 'ready' ? now : undefined,
            closedAt: status === 'closed' ? now : undefined,
            resolvedAt: status === 'resolved' ? now : undefined,
          }
        : thread,
    );

    const principal = getAuthenticatedPrincipal(res.locals as Record<string, unknown>);
    await updateCommentSession(selection, nextThreads, principal.kind !== 'cli');
    res.json({ success: true, threadId, status, version: session.version });
  });

  app.get('/api/agent-events', async (_req, res) => {
    if (!agentEventInbox) {
      res.status(404).json({ error: 'Agent event inbox is not available' });
      return;
    }
    res.json(await agentEventInbox.getBatch());
  });

  app.post('/api/agent-events/ack', async (req, res) => {
    if (!agentEventInbox) {
      res.status(404).json({ error: 'Agent event inbox is not available' });
      return;
    }
    const throughSeq = (req.body as { throughSeq?: unknown } | undefined)?.throughSeq;
    if (typeof throughSeq !== 'number' || !Number.isInteger(throughSeq) || throughSeq < 0) {
      res.status(400).json({ error: 'throughSeq must be a non-negative integer' });
      return;
    }
    res.json(await agentEventInbox.acknowledge(throughSeq));
  });

  app.get('/api/comments-json', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    res.json({
      sessionEpoch: commentSessionEpoch,
      version: session.version,
      threads: session.threads,
    });
  });

  app.get('/api/comments-output', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    res.type('text/plain');

    const unresolvedThreads = session.threads.filter(
      (thread) => !thread.closedAt && !thread.resolvedAt,
    );
    if (unresolvedThreads.length > 0) {
      const output = formatCommentsOutput(unresolvedThreads.map(toCommentThread));
      res.send(output);
    } else {
      res.send('');
    }
  });

  app.get('/api/user-settings', async (_req, res) => {
    const config = await readUserConfig();
    res.json(config);
  });

  app.put('/api/user-settings', async (req, res) => {
    let patch: Record<string, unknown> | null;
    try {
      const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      patch = parseUserSettingsPatch(body);
    } catch {
      patch = null;
    }

    if (!patch) {
      res.status(400).json({ error: 'Invalid user settings payload' });
      return;
    }

    try {
      const config = await updateUserClientSettings(patch);
      res.json(config);
    } catch (error) {
      console.error('Error saving user settings:', error);
      res.status(500).json({ error: 'Failed to save user settings' });
    }
  });

  app.post('/api/open-in-editor', async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Open in editor is not available for stdin diff' });
      return;
    }

    const { filePath, line, editor } = (req.body ?? {}) as {
      filePath?: unknown;
      line?: unknown;
      editor?: unknown;
    };

    if (typeof filePath !== 'string') {
      res.status(400).json({ error: 'Invalid request payload' });
      return;
    }

    const filepathResult = parseRepositoryRelativePath(filePath);
    if (!filepathResult.ok) {
      res.status(400).json({ error: filepathResult.error });
      return;
    }
    const resolvedPath = resolve(repositoryPath, filepathResult.path);

    const editorRequest = parseEditorRequest(editor);
    const editorId =
      editorRequest.id ?? process.env.DIFIT_EDITOR ?? process.env.EDITOR ?? undefined;

    const preset = resolveEditorOption(editorId);
    if (preset.id === NONE_EDITOR_ID) {
      res.status(400).json({
        error: 'Open in editor is disabled',
      });
      return;
    }

    let command = preset.command;
    let argsTemplate = preset.argsTemplate;
    if (preset.id === CUSTOM_EDITOR_ID) {
      const storedConfig = await readUserConfig();
      const storedEditor = storedConfig.client.editor;
      if (!storedEditor || typeof storedEditor !== 'object' || Array.isArray(storedEditor)) {
        res.status(400).json({ error: 'Custom editor is not configured in local settings' });
        return;
      }
      const candidate = storedEditor as {
        id?: unknown;
        command?: unknown;
        argsTemplate?: unknown;
      };
      if (
        candidate.id !== CUSTOM_EDITOR_ID ||
        typeof candidate.command !== 'string' ||
        typeof candidate.argsTemplate !== 'string' ||
        !candidate.command.trim() ||
        !candidate.argsTemplate.trim()
      ) {
        res.status(400).json({ error: 'Custom editor is not configured in local settings' });
        return;
      }
      command = candidate.command;
      argsTemplate = candidate.argsTemplate;
    }

    const lineNumber = (() => {
      const parsed = Number.parseInt(String(line ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();

    const spawnSpec = buildEditorSpawnSpec({
      command,
      argsTemplate,
      filePath: resolvedPath,
      lineNumber,
    });

    if (!spawnSpec) {
      res.status(500).json({ error: 'Invalid editor configuration' });
      return;
    }

    const launched = await new Promise<boolean>((resolvePromise) => {
      const child = spawn(spawnSpec.command, [...spawnSpec.args], {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') {
          console.error('Failed to launch editor CLI:', error);
        }
        resolvePromise(false);
      });
      child.once('spawn', () => {
        child.unref();
        resolvePromise(true);
      });
    });

    if (!launched) {
      res.status(500).json({
        error: `Failed to launch editor: command "${spawnSpec.command}" is not available on PATH`,
      });
      return;
    }

    res.json({ success: true });
  });

  // Function to output comments when server shuts down
  function outputFinalComments() {
    const session = getOrCreateCommentSession(currentCommentSelection);
    const unresolvedThreads = session.threads.filter(
      (thread) => !thread.closedAt && !thread.resolvedAt,
    );
    if (unresolvedThreads.length > 0) {
      console.log(formatCommentsOutput(unresolvedThreads.map(toCommentThread)));
    }
  }

  // SSE endpoint for file watching
  app.get('/api/watch', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    fileWatcher.addClient(res);
    const stopAuthMonitor = monitorAuthenticatedConnection(
      auth,
      getAuthenticatedPrincipal(res.locals as Record<string, unknown>),
      () => res.end(),
    );
    const keepAliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);

    req.on('close', () => {
      stopAuthMonitor();
      clearInterval(keepAliveInterval);
      fileWatcher.removeClient(res);
    });
  });

  // SSE endpoint to detect when tab is closed
  app.get('/api/heartbeat', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial heartbeat
    res.write('data: connected\n\n');

    const stopAuthMonitor = monitorAuthenticatedConnection(
      auth,
      getAuthenticatedPrincipal(res.locals as Record<string, unknown>),
      () => res.end(),
    );

    // Send heartbeat every 5 seconds
    const heartbeatInterval = setInterval(() => {
      res.write('data: heartbeat\n\n');
    }, 5000);

    // When client disconnects (tab closed, navigation, etc.)
    req.on('close', () => {
      stopAuthMonitor();
      clearInterval(heartbeatInterval);
      if (options.keepAlive) {
        console.log('Client disconnected, but server is staying alive (--keep-alive)');
        console.log('Press Ctrl+C to stop the server');
      } else {
        // Add a small delay to ensure any pending sendBeacon requests are processed
        setTimeout(async () => {
          console.log('Client disconnected, shutting down server...');

          // Stop file watcher
          await fileWatcher.stop();

          outputFinalComments();
          process.exit(0);
        }, 100);
      }
    });
  });

  // Always runs in production mode when distributed as a CLI tool
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'development';

  if (isProduction) {
    // Find client files relative to the CLI executable location
    const distPath = join(__dirname, '..', 'client');
    app.use(express.static(distPath));
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>difit - Dev Mode</title>
          </head>
          <body>
            <div id="root"></div>
            <script>
              console.log('difit development mode');
              console.log('Diff data available at /api/diff');
            </script>
          </body>
        </html>
      `);
    });
  }

  const { port, url, server } = await startServerWithFallback(
    app,
    options.preferredPort || 4966,
    !options.host || options.host === 'localhost' ? '127.0.0.1' : options.host,
  );

  const isReviewer = Boolean(
    options.reviewer ||
    options.noWake ||
    process.env.DIFIT_ROLE === 'reviewer' ||
    process.env.DIFIT_NO_WAKE === '1',
  );
  const hapiSessionId =
    process.env.VITEST || isReviewer ? undefined : process.env.HAPI_SESSION_ID?.trim();
  if (reviewContext) {
    const registration = await registerReview(reviewContext, port, process.pid, hapiSessionId);
    const baseCommitish =
      initialDiffData.baseCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const targetCommitish =
      initialDiffData.targetCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    await writeReviewSnapshot(reviewContext.id, {
      ...initialDiffData,
      ignoreWhitespace: initialIgnoreWhitespace,
      openInEditorAvailable: false,
      baseCommitish,
      targetCommitish,
      requestedBaseCommitish:
        initialDiffData.requestedBaseCommitish ?? initialSelection.baseCommitish,
      requestedTargetCommitish:
        initialDiffData.requestedTargetCommitish ?? initialSelection.targetCommitish,
      requestedBaseMode: initialDiffData.requestedBaseMode ?? initialSelection.baseMode,
      clearComments: false,
      repositoryId,
      reviewUrl: options.reviewUrl,
      reviewId: reviewContext.id,
      reviewBranch: reviewContext.branch,
      reviewStale: false,
      commentImports: undefined,
      commentImportId: undefined,
    });
    if (!process.env.VITEST || process.env.DIFIT_CONFIG_DIR?.trim()) {
      agentEventInbox = new AgentEventInbox({
        reviewId: reviewContext.id,
        port,
        hapiSessionId: registration.hapiSessionId,
      });
      await agentEventInbox.initialize();
      server.on('close', () => agentEventInbox?.dispose());
    }
  }

  // Security warning for non-localhost binding
  if (options.host && options.host !== '127.0.0.1' && options.host !== 'localhost') {
    console.warn('\n⚠️  WARNING: Server is accessible from external network!');
    console.warn(`   Binding to: ${options.host}:${port}`);
    console.warn('   Make sure this is intended and your network is secure.\n');
  }

  // Start file watcher
  if (options.diffMode) {
    try {
      await fileWatcher.start(options.diffMode, repositoryPath, 300, invalidateCache);
    } catch (error) {
      console.warn('⚠️  File watcher failed to start:', error);
      console.warn('   Continuing without file watching...');
    }
  }

  const publicOrigin = await auth.getPublicOrigin();
  const browserUrl =
    publicOrigin && reviewContext
      ? `${publicOrigin}/reviews/${encodeURIComponent(reviewContext.id)}/`
      : undefined;

  if (browserUrl && reviewContext && hapiSessionId) {
    void updateHapiReviewLink('attach', {
      hapiSessionId,
      reviewId: reviewContext.id,
      browserUrl,
      reviewUrl: reviewContext.reviewUrl,
      branch: reviewContext.branch,
    }).catch((error: unknown) => {
      console.warn(
        `Warning: Failed to attach DIFIT review to HAPI session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    });
  }

  // Check if diff is empty and skip browser opening
  if (initialDiffData.isEmpty) {
    // Don't open browser if no differences found
  } else if (options.openBrowser) {
    try {
      if (!browserUrl) {
        console.warn(
          'Browser access requires the configured HTTPS Difit hub; open this review from the dashboard.',
        );
      } else {
        await open(browserUrl);
      }
    } catch {
      console.warn('Failed to open browser automatically');
    }
  }

  return { port, url, browserUrl, isEmpty: initialDiffData.isEmpty || false, server };
}

async function startServerWithFallback(
  app: Express,
  preferredPort: number,
  host: string,
): Promise<{ port: number; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    // express's listen() method uses listen() method in node:net Server instance internally
    // https://expressjs.com/en/5x/api.html#app.listen
    // so, an error will be an instance of NodeJS.ErrnoException
    const server = app.listen(preferredPort, host, (err: NodeJS.ErrnoException | undefined) => {
      const displayHost = host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host;
      const url = `http://${displayHost}:${preferredPort}`;
      if (!err) {
        resolve({ port: preferredPort, url, server });
        return;
      }

      // Handling errors when failed to launch a server
      switch (err.code) {
        // Try another port until it succeeds
        case 'EADDRINUSE': {
          console.log(`Port ${preferredPort} is busy, trying ${preferredPort + 1}...`);
          return startServerWithFallback(app, preferredPort + 1, host)
            .then(({ port, url, server }) => {
              resolve({ port, url, server });
            })
            .catch(reject);
        }
        // Unexpected error
        default: {
          reject(new Error(`Failed to launch a server: ${err.message}`));
        }
      }
    });
  });
}
