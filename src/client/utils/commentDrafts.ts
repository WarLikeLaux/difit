import { getReviewBasePath } from './apiUrl';

const STORAGE_PREFIX = 'difit.commentDraft.';

function getCommentDraftStorageKey(draftKey: string): string {
  return `${STORAGE_PREFIX}${getReviewBasePath() || 'direct'}:${draftKey}`;
}

export function readCommentDraft(draftKey: string, fallback: string): string {
  try {
    return window.sessionStorage.getItem(getCommentDraftStorageKey(draftKey)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeCommentDraft(draftKey: string, body: string): void {
  try {
    const storageKey = getCommentDraftStorageKey(draftKey);
    if (body) window.sessionStorage.setItem(storageKey, body);
    else window.sessionStorage.removeItem(storageKey);
  } catch {
    // Session storage is an optional enhancement.
  }
}

export function removeCommentDraft(draftKey: string): void {
  try {
    window.sessionStorage.removeItem(getCommentDraftStorageKey(draftKey));
  } catch {
    // Session storage is an optional enhancement.
  }
}
