import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ActiveReviewThread {
  updatedAt: string;
}

export interface ActiveReview {
  id: string;
  repositoryName: string;
  label: string;
  running: boolean;
  available: boolean;
  stale: boolean;
  updatedAt: string;
  threads: ActiveReviewThread[];
  unreadCount: number;
}

type HubReviewPayload = Omit<ActiveReview, 'unreadCount'>;

const REVIEW_PATH_PATTERN = /^\/reviews\/([^/]+)/;
const LAST_SEEN_STORAGE_PREFIX = 'difit.reviewSwitcher.lastSeen.';

export function getActiveReviewId(pathname = window.location.pathname): string | null {
  const match = pathname.match(REVIEW_PATH_PATTERN);
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function getReviewPath(reviewId: string): string {
  return `/reviews/${encodeURIComponent(reviewId)}/`;
}

function readLastSeen(reviewId: string): string | null {
  try {
    return window.sessionStorage.getItem(`${LAST_SEEN_STORAGE_PREFIX}${reviewId}`);
  } catch {
    return null;
  }
}

function writeLastSeen(reviewId: string, updatedAt: string): void {
  try {
    window.sessionStorage.setItem(`${LAST_SEEN_STORAGE_PREFIX}${reviewId}`, updatedAt);
  } catch {
    // Session storage is an optional enhancement.
  }
}

function withUnreadCount(review: HubReviewPayload, activeReviewId: string): ActiveReview {
  const lastSeen = readLastSeen(review.id);
  if (!lastSeen || review.id === activeReviewId) {
    writeLastSeen(review.id, review.updatedAt);
    return { ...review, unreadCount: 0 };
  }

  const seenTimestamp = Date.parse(lastSeen);
  const unreadCount = review.threads.filter(
    (thread) => Date.parse(thread.updatedAt) > seenTimestamp,
  ).length;
  return { ...review, unreadCount };
}

export interface ReviewRegistry {
  activeReviewId: string | null;
  reviews: ActiveReview[];
  selectReview: (reviewId: string) => void;
}

export function useReviewRegistry(): ReviewRegistry {
  const [activeReviewId, setActiveReviewId] = useState(getActiveReviewId);
  const activeReviewIdRef = useRef(activeReviewId);
  activeReviewIdRef.current = activeReviewId;
  const [reviews, setReviews] = useState<ActiveReview[]>([]);

  const refresh = useCallback(async () => {
    if (!activeReviewIdRef.current) return;

    try {
      const response = await fetch('/api/reviews');
      if (!response.ok) return;
      const payload = (await response.json()) as HubReviewPayload[];
      const currentReviewId = activeReviewIdRef.current;
      if (!currentReviewId) return;
      setReviews(
        payload
          .filter((review) => review.running && review.available && !review.stale)
          .map((review) => withUnreadCount(review, currentReviewId)),
      );
    } catch {
      // A direct viewer has no hub registry; keep the switcher hidden.
    }
  }, []);

  useEffect(() => {
    if (!activeReviewId) return;

    void refresh();
    const events = new EventSource('/api/events');
    events.onmessage = () => void refresh();
    events.onerror = () => undefined;
    return () => events.close();
  }, [activeReviewId, refresh]);

  useEffect(() => {
    const handlePopState = () => setActiveReviewId(getActiveReviewId());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const selectReview = useCallback(
    (reviewId: string) => {
      if (reviewId === activeReviewIdRef.current) return;
      const review = reviews.find((candidate) => candidate.id === reviewId);
      if (review) writeLastSeen(review.id, review.updatedAt);
      window.history.pushState({ difitReviewId: reviewId }, '', getReviewPath(reviewId));
      setActiveReviewId(reviewId);
    },
    [reviews],
  );

  return useMemo(
    () => ({ activeReviewId, reviews, selectReview }),
    [activeReviewId, reviews, selectReview],
  );
}
