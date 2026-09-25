import type { DiffCommentThread, DiffLineRange } from '../types/diff.js';
import type { LessonActor, LessonCodeAfter, LessonOutcome, ReviewLesson } from '../types/lesson.js';

import { getThreadStatus } from './agent-event-inbox.js';
import { GitDiffParser } from './git-diff.js';
import { computeRepositoryId, upsertLessons } from './lesson-storage.js';

const LESSON_CODE_WINDOW_CONTEXT_LINES = 10;

/** Reads the current content of a file; strings and Buffers are both accepted, failures become `unavailableReason`. */
type WorkingContentReader = (filePath: string) => Promise<string | Buffer>;

export interface ResolvedTransition {
  thread: DiffCommentThread;
  outcome: LessonOutcome;
  /** Timestamp of the finishing transition itself, when the thread carries one. */
  finishedAt?: string;
}

/**
 * Returns threads that moved into resolved or closed between the two thread
 * lists. Threads that were already finished before keep their original lesson.
 */
export function findResolvedTransitions(
  previousThreads: readonly DiffCommentThread[],
  nextThreads: readonly DiffCommentThread[],
): ResolvedTransition[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread]));
  const isFinished = (status: string): boolean => status === 'resolved' || status === 'closed';

  const transitions: ResolvedTransition[] = [];
  for (const thread of nextThreads) {
    const status = getThreadStatus(thread);
    const outcome: LessonOutcome | undefined =
      status === 'resolved' ? 'resolved' : status === 'closed' ? 'closed' : undefined;
    if (!outcome) continue;

    const previousThread = previousById.get(thread.id);
    if (previousThread && isFinished(getThreadStatus(previousThread))) continue;

    transitions.push({
      thread,
      outcome,
      finishedAt: outcome === 'resolved' ? thread.resolvedAt : thread.closedAt,
    });
  }
  return transitions;
}

/** Extracts a window of context lines around the thread position from full file content. */
export function extractCodeWindow(
  content: string,
  line: DiffLineRange,
  contextLines = LESSON_CODE_WINDOW_CONTEXT_LINES,
): string {
  const lines = content.split('\n');
  // Drop the empty segment produced by a trailing newline so windows stay clean.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const firstLine = typeof line === 'number' ? line : line.start;
  const lastLine = typeof line === 'number' ? line : line.end;
  const from = Math.max(0, firstLine - 1 - contextLines);
  const to = Math.min(lines.length, lastLine + contextLines);
  return lines.slice(from, to).join('\n');
}

function createDefaultWorkingContentReader(repositoryPath: string): WorkingContentReader {
  const parser = new GitDiffParser(repositoryPath);
  return (filePath) => parser.getBlobContent(filePath, 'working');
}

export interface BuildLessonOptions {
  reviewId?: string;
  branch?: string;
  actor: LessonActor;
  /** Overrides the capture timestamp; defaults to the transition timestamp, then now. */
  capturedAt?: string;
  readWorkingContent: WorkingContentReader;
}

export async function buildLesson(
  transition: ResolvedTransition,
  options: BuildLessonOptions,
): Promise<ReviewLesson> {
  const { thread } = transition;
  let codeAfter: LessonCodeAfter;
  try {
    const raw = await options.readWorkingContent(thread.filePath);
    const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
    codeAfter = { content: extractCodeWindow(content, thread.position.line) };
  } catch (error) {
    codeAfter = {
      unavailableReason: error instanceof Error ? error.message : 'Unknown read error',
    };
  }

  return {
    threadId: thread.id,
    ...(options.reviewId ? { reviewId: options.reviewId } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    outcome: transition.outcome,
    resolvedBy: options.actor,
    capturedAt: options.capturedAt ?? transition.finishedAt ?? new Date().toISOString(),
    filePath: thread.filePath,
    position: thread.position,
    ...(thread.codeSnapshot ? { codeBefore: thread.codeSnapshot } : {}),
    codeAfter,
    messages: thread.messages.map(({ author, body, createdAt }) => ({ author, body, createdAt })),
  };
}

export interface CaptureResolvedLessonsOptions {
  previousThreads: readonly DiffCommentThread[];
  nextThreads: readonly DiffCommentThread[];
  repositoryPath: string;
  /** Precomputed repository id; derived from the path when absent. */
  repositoryId?: string;
  reviewId?: string;
  branch?: string;
  /** Who performed the finishing transition; absent means the write cannot finish a thread. */
  resolvedBy?: LessonActor;
  readWorkingContent?: WorkingContentReader;
}

/**
 * Captures a lesson for every thread that finished between the two thread
 * lists. Best-effort by contract: any failure is swallowed so the comment
 * write that triggered the capture is never affected.
 */
export async function captureResolvedLessons(
  options: CaptureResolvedLessonsOptions,
): Promise<void> {
  const actor = options.resolvedBy;
  try {
    if (!actor) return;

    const transitions = findResolvedTransitions(options.previousThreads, options.nextThreads);
    if (transitions.length === 0) return;

    const readWorkingContent =
      options.readWorkingContent ?? createDefaultWorkingContentReader(options.repositoryPath);
    const lessons = await Promise.all(
      transitions.map((transition) =>
        buildLesson(transition, {
          reviewId: options.reviewId,
          branch: options.branch,
          actor,
          readWorkingContent,
        }),
      ),
    );
    const repositoryId = options.repositoryId ?? computeRepositoryId(options.repositoryPath);
    await upsertLessons(repositoryId, lessons);
  } catch {
    // Lesson capture must never break the comment write path.
  }
}
