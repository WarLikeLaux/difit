import type { execFile } from 'child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateHapiReviewLink } from './hapi-review-link.js';

afterEach(() => {
  delete process.env.HAPI_CLI_EXECUTABLE;
});

describe('HAPI review link', () => {
  it('uses argument-safe CLI invocation to attach a review', async () => {
    process.env.HAPI_CLI_EXECUTABLE = '/opt/hapi';
    const runMock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(null);
      return {};
    });
    const run = runMock as unknown as typeof execFile;

    await updateHapiReviewLink(
      'attach',
      {
        hapiSessionId: 'session-1',
        reviewId: 'review-1',
        browserUrl: 'https://difit.local/reviews/review-1/',
        reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
        branch: 'feature/review',
      },
      run,
    );

    expect(run).toHaveBeenCalledWith(
      '/opt/hapi',
      [
        'difit-review',
        'attach',
        '--session-id',
        'session-1',
        '--review-id',
        'review-1',
        '--url',
        'https://difit.local/reviews/review-1/',
        '--review-url',
        'https://gitlab.example.test/group/project/-/merge_requests/1',
        '--branch',
        'feature/review',
      ],
      { timeout: 15_000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('detaches without requiring a browser URL', async () => {
    const runMock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(null);
      return {};
    });
    const run = runMock as unknown as typeof execFile;

    await updateHapiReviewLink('detach', { hapiSessionId: 'session-1', reviewId: 'review-1' }, run);

    expect(runMock.mock.calls[0]?.[1]).toEqual([
      'difit-review',
      'detach',
      '--session-id',
      'session-1',
      '--review-id',
      'review-1',
    ]);
  });
});
