import { describe, expect, it } from 'vitest';

import { buildGitLabDiffLineUrl, getGitLabLineFragment } from './gitlabLinks';

describe('getGitLabLineFragment', () => {
  it('prefixes added line numbers with A', () => {
    expect(getGitLabLineFragment({ type: 'add', content: 'added', newLineNumber: 258 })).toBe(
      'A258',
    );
  });

  it('uses the old position for context and deleted lines', () => {
    expect(
      getGitLabLineFragment({
        type: 'normal',
        content: 'context',
        oldLineNumber: 257,
        newLineNumber: 261,
      }),
    ).toBe('257');
  });
});

describe('buildGitLabDiffLineUrl', () => {
  it('builds a Rapid Diffs link with GitLab short file hash', async () => {
    await expect(
      buildGitLabDiffLineUrl(
        'https://gitlab.example.com/group/project/-/merge_requests/123/diffs',
        'src/services/logger.ts',
        'A60',
      ),
    ).resolves.toBe(
      'https://gitlab.example.com/group/project/-/merge_requests/123/diffs?file_path=src%2Fservices%2Flogger.ts#line_f1536cbbf_A60',
    );
  });
});
