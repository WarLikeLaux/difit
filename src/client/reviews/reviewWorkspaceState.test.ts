import { beforeEach, describe, expect, it } from 'vitest';

import { readReviewWorkspaceState, writeReviewWorkspaceState } from './reviewWorkspaceState';

describe('reviewWorkspaceState', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('keeps workspace state isolated by review', () => {
    writeReviewWorkspaceState('review-one', {
      mainView: 'comments',
      diffMode: 'unified',
      codeFilterText: 'needle',
      diffScrollTop: 420,
    });

    expect(readReviewWorkspaceState('review-one')).toEqual({
      mainView: 'comments',
      diffMode: 'unified',
      codeFilterText: 'needle',
      diffScrollTop: 420,
    });
    expect(readReviewWorkspaceState('review-two')).toEqual({});
  });
});
