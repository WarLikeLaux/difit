import { ChevronDown } from 'lucide-react';

import type { ActiveReview } from '../reviews/reviewRegistry';

interface ReviewSwitcherProps {
  activeReviewId: string;
  reviews: ActiveReview[];
  sidebarWidth: number;
  sidebarOpen: boolean;
  isMobile: boolean;
  onSelectReview: (reviewId: string) => void;
}

const MAX_VISIBLE_REVIEWS = 4;

function getVisibleReviews(reviews: ActiveReview[], activeReviewId: string): ActiveReview[] {
  if (reviews.length <= MAX_VISIBLE_REVIEWS) return reviews;

  const active = reviews.find((review) => review.id === activeReviewId);
  const visible = reviews.filter((review) => review.id !== activeReviewId).slice(0, 3);
  return active ? [active, ...visible] : reviews.slice(0, MAX_VISIBLE_REVIEWS);
}

export function ReviewSwitcher({
  activeReviewId,
  reviews,
  sidebarWidth,
  sidebarOpen,
  isMobile,
  onSelectReview,
}: ReviewSwitcherProps) {
  if (reviews.length === 0) return null;

  const visibleReviews = getVisibleReviews(reviews, activeReviewId);
  const hiddenReviews = reviews.filter(
    (review) => !visibleReviews.some((visible) => visible.id === review.id),
  );

  return (
    <div className="flex h-9 shrink-0 border-b border-github-border bg-github-bg-secondary">
      {!isMobile && (
        <div
          className="shrink-0 border-r border-github-border"
          style={{ width: sidebarOpen ? `${sidebarWidth + 4}px` : '0px' }}
          aria-hidden="true"
        />
      )}
      <nav
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-2 pt-1"
        aria-label="Active reviews"
      >
        {visibleReviews.map((review) => {
          const active = review.id === activeReviewId;
          return (
            <button
              key={review.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectReview(review.id)}
              title={`${review.repositoryName} / ${review.label}`}
              className={`flex min-w-0 max-w-80 shrink-0 items-center gap-2 rounded-t border border-b-0 px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-400 ${
                active
                  ? 'border-blue-500 bg-github-bg-primary text-github-text-primary'
                  : 'border-github-border bg-github-bg-tertiary text-github-text-secondary hover:bg-github-bg-primary hover:text-github-text-primary'
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-label="Running" />
              <span className="truncate">
                <span className="font-medium">{review.repositoryName}</span>
                <span className="text-github-text-muted"> / </span>
                {review.label}
              </span>
              {review.unreadCount > 0 && (
                <span
                  className="inline-flex min-w-5 shrink-0 justify-center rounded-full bg-github-bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-github-text-primary"
                  aria-label={`${review.unreadCount} updated threads`}
                >
                  {review.unreadCount}
                </span>
              )}
            </button>
          );
        })}
        {hiddenReviews.length > 0 && (
          <label className="relative flex shrink-0 items-center rounded-t border border-b-0 border-github-border bg-github-bg-tertiary text-github-text-secondary hover:bg-github-bg-primary hover:text-github-text-primary">
            <span className="flex items-center gap-1 px-3 text-xs">
              More ({hiddenReviews.length})
              <ChevronDown size={13} />
            </span>
            <select
              aria-label="More active reviews"
              value=""
              onChange={(event) => {
                if (event.target.value) onSelectReview(event.target.value);
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value="" disabled>
                Select review
              </option>
              {hiddenReviews.map((review) => (
                <option key={review.id} value={review.id}>
                  {review.repositoryName} / {review.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </nav>
    </div>
  );
}
