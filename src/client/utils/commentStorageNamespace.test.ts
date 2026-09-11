import { describe, expect, it } from 'vitest';
import { getCommentStorageNamespace } from './commentStorageNamespace';

describe('getCommentStorageNamespace', () => {
  it('isolates reviews of the same repository', () => {
    expect(getCommentStorageNamespace('repository', 'review-one')).not.toBe(
      getCommentStorageNamespace('repository', 'review-two'),
    );
  });

  it('keeps the legacy repository namespace without a review id', () => {
    expect(getCommentStorageNamespace('repository')).toBe('repository');
  });
});
