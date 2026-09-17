import { beforeEach, describe, expect, it } from 'vitest';

import { readCommentDraft, removeCommentDraft, writeCommentDraft } from './commentDrafts';

describe('commentDrafts', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/reviews/review-one/');
    window.sessionStorage.clear();
  });

  it('isolates drafts by review path', () => {
    writeCommentDraft('reply:thread-one', 'First review draft');
    window.history.replaceState(null, '', '/reviews/review-two/');

    expect(readCommentDraft('reply:thread-one', '')).toBe('');
    writeCommentDraft('reply:thread-one', 'Second review draft');

    window.history.replaceState(null, '', '/reviews/review-one/');
    expect(readCommentDraft('reply:thread-one', '')).toBe('First review draft');
    removeCommentDraft('reply:thread-one');
    expect(readCommentDraft('reply:thread-one', '')).toBe('');
  });
});
