import { afterEach, describe, expect, it } from 'vitest';

import { getReviewBasePath, getReviewsDashboardUrl, resolveApiUrl } from './apiUrl';

describe('review proxy URLs', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('keeps direct viewer API URLs unchanged', () => {
    window.history.replaceState(null, '', '/');

    expect(resolveApiUrl('/api/diff')).toBe('/api/diff');
    expect(getReviewsDashboardUrl()).toBeNull();
  });

  it('routes viewer APIs through the review path', () => {
    window.history.replaceState(null, '', '/reviews/review-id/comments');

    expect(getReviewBasePath()).toBe('/reviews/review-id');
    expect(resolveApiUrl('/api/diff?target=HEAD')).toBe('/reviews/review-id/api/diff?target=HEAD');
    expect(getReviewsDashboardUrl()).toBe('/');
  });
});
