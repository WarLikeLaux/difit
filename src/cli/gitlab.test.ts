import { describe, expect, it } from 'vitest';

import { normalizeGitLabMergeRequestUrl } from './gitlab';

describe('normalizeGitLabMergeRequestUrl', () => {
  it('normalizes a GitLab merge request changes URL', () => {
    expect(
      normalizeGitLabMergeRequestUrl(
        'https://gitlab.example.com/group/project/-/merge_requests/123/diffs',
      ),
    ).toBe('https://gitlab.example.com/group/project/-/merge_requests/123');
  });

  it('rejects non-merge-request URLs', () => {
    expect(
      normalizeGitLabMergeRequestUrl('https://gitlab.example.com/group/project'),
    ).toBeUndefined();
  });
});
