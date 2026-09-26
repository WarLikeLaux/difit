import { describe, expect, it, vi } from 'vitest';

import { createReviewContext, getReviewBranchState } from './review-context.js';

function createGitMock(values: {
  head?: string;
  branch?: string;
  target?: string;
  base?: string;
  mergeBase?: string;
}) {
  const head = values.head ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  return {
    revparse: vi.fn(async (args: string[]) => {
      if (args[0] === '--abbrev-ref') return values.branch ?? 'feature/dashboard';
      if (args[0] === 'HEAD') return head;
      if (args[0] === 'base') return values.base ?? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      return values.target ?? head;
    }),
    raw: vi.fn(async () => values.mergeBase ?? 'cccccccccccccccccccccccccccccccccccccccc'),
  };
}

describe('review context', () => {
  it('keeps one branch review identity across new commits', async () => {
    const first = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: '.', baseMode: 'merge-base' },
      git: createGitMock({ head: 'aaaaaaaa', branch: 'feature/dashboard' }) as never,
    });
    const second = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: '.', baseMode: 'merge-base' },
      git: createGitMock({ head: 'dddddddd', branch: 'feature/dashboard' }) as never,
    });

    expect(first.id).toBe(second.id);
    expect(first.sessionKey).toBe(second.sessionKey);
    expect(first.followsBranch).toBe(true);
  });

  it('isolates reviews for different branches in one checkout', async () => {
    const first = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: '.' },
      git: createGitMock({ branch: 'feature/one' }) as never,
    });
    const second = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: '.' },
      git: createGitMock({ branch: 'feature/two' }) as never,
    });

    expect(first.id).not.toBe(second.id);
  });

  it('isolates reviews for different HAPI sessions on the same branch', async () => {
    const options = {
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
      git: createGitMock({ branch: 'feature/one' }) as never,
    };
    const first = await createReviewContext({ ...options, hapiSessionId: 'session-1' });
    const second = await createReviewContext({ ...options, hapiSessionId: 'session-2' });
    expect(first.id).not.toBe(second.id);
    expect(first.sessionKey).not.toBe(second.sessionKey);
  });

  it('marks a branch review stale after checkout changes branch', async () => {
    const context = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: '.' },
      git: createGitMock({ branch: 'feature/one' }) as never,
    });

    const state = await getReviewBranchState(
      context,
      createGitMock({ branch: 'feature/two' }) as never,
    );

    expect(state).toMatchObject({ stale: true, currentBranch: 'feature/two' });
  });

  it('treats a missing repository directory as stale instead of throwing', async () => {
    const context = await createReviewContext({
      repositoryPath: '/nonexistent/difit-missing-repo',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: '.' },
      git: createGitMock({ branch: 'feature/one' }) as never,
    });

    await expect(getReviewBranchState(context)).resolves.toEqual({ stale: true });
  });

  it('keeps an MR target immutable when the checkout has moved to another head', async () => {
    const context = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: 'old-target' },
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
      git: createGitMock({ head: 'aaaaaaaa', target: 'dddddddd' }) as never,
    });

    expect(context.followsBranch).toBe(false);
    expect(context.branch).toBeUndefined();
  });

  it('keeps an MR snapshot writable after the checkout changes branch', async () => {
    const context = await createReviewContext({
      repositoryPath: '/workspace/project',
      repositoryId: 'repository-id',
      selection: { baseCommitish: 'base', targetCommitish: 'aaaaaaaa' },
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
      git: createGitMock({ head: 'aaaaaaaa', branch: 'feature/review' }) as never,
    });

    const state = await getReviewBranchState(
      context,
      createGitMock({ head: 'dddddddd', branch: 'feature/other' }) as never,
    );

    expect(context).toMatchObject({
      branch: 'feature/review',
      followsBranch: false,
      sessionKey: `review:${context.id}`,
    });
    expect(state).toEqual({ stale: false });
  });
});
