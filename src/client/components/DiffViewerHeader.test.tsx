import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type { DiffFile } from '../../types/diff';

import { DiffViewerHeader } from './DiffViewerHeader';

const file: DiffFile = {
  path: 'src/app.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  chunks: [],
};

const baseProps = {
  file,
  isCollapsed: false,
  isReviewed: false,
  onToggleCollapsed: vi.fn(),
  onToggleAllCollapsed: vi.fn(),
  onToggleReviewed: vi.fn(),
};

describe('DiffViewerHeader', () => {
  it('shows the "Updated" badge when the file changed since last viewed', () => {
    render(<DiffViewerHeader {...baseProps} isChangedSinceViewed />);

    const badge = screen.getByLabelText('Updated since you last viewed this file');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Updated');
    expect(badge).toHaveAttribute('title', 'Updated since you last viewed this file');
  });

  it('hides the "Updated" badge once the file is marked as reviewed', () => {
    render(<DiffViewerHeader {...baseProps} isChangedSinceViewed isReviewed />);

    expect(
      screen.queryByLabelText('Updated since you last viewed this file'),
    ).not.toBeInTheDocument();
  });

  it('hides the "Updated" badge when the file is unchanged since last viewed', () => {
    render(<DiffViewerHeader {...baseProps} isChangedSinceViewed={false} />);

    expect(
      screen.queryByLabelText('Updated since you last viewed this file'),
    ).not.toBeInTheDocument();
  });

  it('links the file header to its GitLab diff', () => {
    render(
      <DiffViewerHeader
        {...baseProps}
        reviewUrl="https://gitlab.example.com/group/project/-/merge_requests/123/diffs"
      />,
    );

    expect(screen.getByRole('link', { name: 'Open src/app.ts in GitLab diff' })).toHaveAttribute(
      'href',
      'https://gitlab.example.com/group/project/-/merge_requests/123/diffs?file_path=src%2Fapp.ts',
    );
    expect(screen.getByRole('link', { name: 'Open src/app.ts in GitLab diff' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('opens the file in the configured editor from the header actions', () => {
    const onOpenInEditor = vi.fn();
    render(<DiffViewerHeader {...baseProps} onOpenInEditor={onOpenInEditor} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));

    expect(onOpenInEditor).toHaveBeenCalledWith('src/app.ts', 1);
  });

  it('previews the full file from the header when Show Code is available', () => {
    const onShowCode = vi.fn();
    render(<DiffViewerHeader {...baseProps} onShowCode={onShowCode} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show Code' }));

    expect(onShowCode).toHaveBeenCalledWith('src/app.ts');
  });

  it('hides the Show Code action when no preview handler is provided', () => {
    render(<DiffViewerHeader {...baseProps} />);

    expect(screen.queryByRole('button', { name: 'Show Code' })).not.toBeInTheDocument();
  });
});
