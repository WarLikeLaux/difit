import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CommentForm } from './CommentForm';

describe('CommentForm', () => {
  it('marks the cancel action independently from other form buttons', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <CommentForm onSubmit={vi.fn()} onCancel={onCancel} selectedCode="const value = 1;" />,
    );

    const cancelButton = container.querySelector<HTMLButtonElement>('[data-comment-cancel="true"]');
    expect(cancelButton).toBe(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(cancelButton!);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('submits on Enter and keeps Shift+Enter for a new line', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'First line' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('First line');
  });
});
