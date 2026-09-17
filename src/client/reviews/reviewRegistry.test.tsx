import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveReviewId, getReviewPath, useReviewRegistry } from './reviewRegistry';

class MockEventSource {
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}
}

describe('reviewRegistry', () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    window.history.replaceState(null, '', '/reviews/review-one/');
    window.sessionStorage.clear();
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 'review-one',
              repositoryName: 'api',
              label: 'feature/one',
              running: true,
              available: true,
              updatedAt: '2026-09-17T10:00:00.000Z',
              threads: [],
            },
            {
              id: 'review-two',
              repositoryName: 'web',
              label: 'feature/two',
              running: true,
              available: true,
              updatedAt: '2026-09-17T10:01:00.000Z',
              threads: [],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', originalFetch);
    vi.stubGlobal('EventSource', originalEventSource);
    vi.restoreAllMocks();
  });

  it('parses and builds encoded review paths', () => {
    expect(getActiveReviewId('/reviews/review%20one/comments')).toBe('review one');
    expect(getReviewPath('review one')).toBe('/reviews/review%20one/');
  });

  it('switches reviews with history state without reloading the page', async () => {
    const reload = vi.spyOn(window.location, 'reload');
    const { result } = renderHook(() => useReviewRegistry());

    await waitFor(() => expect(result.current.reviews).toHaveLength(2));
    act(() => result.current.selectReview('review-two'));

    expect(result.current.activeReviewId).toBe('review-two');
    expect(window.location.pathname).toBe('/reviews/review-two/');
    expect(reload).not.toHaveBeenCalled();
  });
});
