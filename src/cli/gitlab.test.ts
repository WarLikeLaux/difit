import { describe, expect, it } from 'vitest';

import { detectGitLabMergeRequestUrl, normalizeGitLabMergeRequestUrl } from './gitlab';

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

describe('detectGitLabMergeRequestUrl', () => {
  it('falls back to the current branch MR when the requested SHA is HEAD', () => {
    const execFile = ((command: string, args: string[]) => {
      if (command === 'glab' && args.includes('view')) throw new Error('MR not found by SHA');
      if (command === 'git' && args[1] === 'abc123') return 'abc123\n';
      if (command === 'git' && args[1] === 'HEAD') return 'abc123\n';
      if (command === 'git' && args[0] === 'branch') return 'feature/review\n';
      if (command === 'glab' && args.includes('list')) {
        return JSON.stringify([
          {
            web_url: 'https://gitlab.example.com/group/project/-/merge_requests/123',
          },
        ]);
      }
      throw new Error('Unexpected command');
    }) as typeof import('child_process').execFileSync;

    expect(detectGitLabMergeRequestUrl('/repo', 'abc123', execFile)).toBe(
      'https://gitlab.example.com/group/project/-/merge_requests/123',
    );
  });

  it('retries a working-tree lookup using the explicit source branch', () => {
    const execFile = ((command: string, args: string[]) => {
      if (command === 'glab' && args.includes('view')) throw new Error('Transient failure');
      if (command === 'git' && args[0] === 'branch') return 'feature/review\n';
      if (command === 'glab' && args.includes('list')) {
        expect(args).toContain('feature/review');
        return JSON.stringify([
          {
            web_url: 'https://gitlab.example.com/group/project/-/merge_requests/123',
          },
        ]);
      }
      throw new Error('Unexpected command');
    }) as typeof import('child_process').execFileSync;

    expect(detectGitLabMergeRequestUrl('/repo', '.', execFile)).toBe(
      'https://gitlab.example.com/group/project/-/merge_requests/123',
    );
  });

  it('does not fall back to an unrelated current branch MR', () => {
    const execFile = ((command: string, args: string[]) => {
      if (command === 'glab') throw new Error('MR not found by target');
      if (command === 'git' && args[1] === 'other-sha') return 'other-sha\n';
      if (command === 'git' && args[1] === 'HEAD') return 'head-sha\n';
      throw new Error('Unexpected command');
    }) as typeof import('child_process').execFileSync;

    expect(detectGitLabMergeRequestUrl('/repo', 'other-sha', execFile)).toBeUndefined();
  });
});
