import type { DiffViewMode } from '../../types/diff';

type StoredMainView = 'diff' | 'comments';

export interface ReviewWorkspaceState {
  mainView?: StoredMainView;
  diffMode?: DiffViewMode;
  codeFilterText?: string;
  diffScrollTop?: number;
}

const STORAGE_PREFIX = 'difit.reviewWorkspace.';

export function readReviewWorkspaceState(reviewId: string | null): ReviewWorkspaceState {
  if (!reviewId) return {};

  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(`${STORAGE_PREFIX}${reviewId}`) ?? '{}',
    );
    return value && typeof value === 'object' ? (value as ReviewWorkspaceState) : {};
  } catch {
    return {};
  }
}

export function writeReviewWorkspaceState(
  reviewId: string | null,
  state: ReviewWorkspaceState,
): void {
  if (!reviewId) return;

  try {
    window.sessionStorage.setItem(`${STORAGE_PREFIX}${reviewId}`, JSON.stringify(state));
  } catch {
    // Session storage is an optional enhancement.
  }
}
