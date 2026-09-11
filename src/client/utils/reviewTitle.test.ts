import { describe, expect, it } from 'vitest';
import { createReviewTitle } from './reviewTitle';

describe('createReviewTitle', () => {
  it('uses the proxy label for a legacy viewer without review metadata', () => {
    expect(createReviewTitle({ reviewId: null, reviewBranch: null }, 'feature/review')).toBe(
      'feature/review',
    );
  });

  it('falls back to review metadata and the application name', () => {
    expect(createReviewTitle({ reviewId: 'review-id', reviewBranch: 'feature/direct' })).toBe(
      'feature/direct',
    );
    expect(createReviewTitle({ reviewId: 'review-id' })).toBe('Snapshot');
    expect(createReviewTitle({})).toBe('DIFIT');
  });
});
