interface ReviewTitleData {
  reviewId?: string | null;
  reviewBranch?: string | null;
}

export function createReviewTitle(data: ReviewTitleData, proxyLabel?: string | null): string {
  const label =
    proxyLabel?.trim() || data.reviewBranch?.trim() || (data.reviewId ? 'Snapshot' : '');

  return label || 'DIFIT';
}
