import { render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectFilePreview } from './ProjectFilePreview';

afterEach(() => vi.unstubAllGlobals());

describe('ProjectFilePreview', () => {
  it('highlights PHP syntax in the current file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => '<?php\nnamespace app\\models;\nclass Example {}\n',
      })),
    );

    const { container } = render(
      <HotkeysProvider>
        <ProjectFilePreview path="models/Example.php" onClose={vi.fn()} />
      </HotkeysProvider>,
    );

    expect(await screen.findByText('models/Example.php')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('.token.keyword')).toHaveTextContent('namespace');
    });
    expect(screen.getByText('class')).toBeInTheDocument();
  });
});
