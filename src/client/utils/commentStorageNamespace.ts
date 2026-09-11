export function getCommentStorageNamespace(
  repositoryId?: string,
  reviewId?: string,
): string | undefined {
  return reviewId ? `${repositoryId ?? 'default'}:review:${reviewId}` : repositoryId;
}
