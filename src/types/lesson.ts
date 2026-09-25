import type { DiffCommentCodeSnapshot, DiffCommentMessage, DiffCommentPosition } from './diff.js';

/**
 * Final state of a thread at the moment its lesson was captured. A lesson is
 * written exactly once per transition into one of these states; reopen and a
 * later re-resolve replace the stored lesson.
 */
export type LessonOutcome = 'resolved' | 'closed';

/** Principal kind that performed the finishing transition; `hub` covers offline resolves on the archived dashboard. */
export type LessonActor = 'browser' | 'cli' | 'test' | 'hub';

/**
 * Working-tree state captured when the thread finished: either a window of code
 * around the thread position, or the reason the file could not be read.
 */
export type LessonCodeAfter = { content: string } | { unavailableReason: string };

/** Conversation worth replaying in a lesson; message ids and edit stamps are noise here. */
type ReviewLessonMessage = Pick<DiffCommentMessage, 'author' | 'body' | 'createdAt'>;

export interface ReviewLesson {
  threadId: string;
  reviewId?: string;
  branch?: string;
  outcome: LessonOutcome;
  resolvedBy: LessonActor;
  capturedAt: string;
  filePath: string;
  position: DiffCommentPosition;
  /** Code as it looked when the thread was created, straight from the thread snapshot. */
  codeBefore?: DiffCommentCodeSnapshot;
  codeAfter: LessonCodeAfter;
  messages: ReviewLessonMessage[];
}
