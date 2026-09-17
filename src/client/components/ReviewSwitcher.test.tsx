import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ActiveReview } from '../reviews/reviewRegistry';

import { ReviewSwitcher } from './ReviewSwitcher';

const reviews: ActiveReview[] = [
  {
    id: 'review-one',
    repositoryName: 'api',
    label: 'feature/one',
    running: true,
    available: true,
    updatedAt: '2026-09-17T10:00:00.000Z',
    threads: [],
    unreadCount: 0,
  },
  {
    id: 'review-two',
    repositoryName: 'web',
    label: 'feature/two',
    running: true,
    available: true,
    updatedAt: '2026-09-17T10:01:00.000Z',
    threads: [],
    unreadCount: 2,
  },
];

describe('ReviewSwitcher', () => {
  it('shows active reviews and switches without using links', async () => {
    const user = userEvent.setup();
    const onSelectReview = vi.fn();
    render(
      <ReviewSwitcher
        activeReviewId="review-one"
        reviews={reviews}
        sidebarWidth={280}
        sidebarOpen={true}
        isMobile={false}
        onSelectReview={onSelectReview}
      />,
    );

    expect(screen.getByRole('button', { name: /api \/ feature\/one/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByLabelText('2 updated threads')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /web \/ feature\/two/ }));
    expect(onSelectReview).toHaveBeenCalledWith('review-two');
  });
});
