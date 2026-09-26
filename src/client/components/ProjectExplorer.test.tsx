import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectExplorer } from './ProjectExplorer';

afterEach(() => vi.unstubAllGlobals());

describe('ProjectExplorer', () => {
  it('finds files by path and opens code search results at their line', async () => {
    const openFile = vi.fn();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/project/files')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ files: ['README.md', 'src/first.ts', 'src/second.ts'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          matches: [{ path: 'src/second.ts', line: 12, text: 'needle()' }],
          truncated: false,
        }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ProjectExplorer onOpenFile={openFile} />);
    await screen.findByText('Project files');
    fireEvent.change(screen.getByPlaceholderText('Find project file...'), {
      target: { value: 'README' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }));
    expect(openFile).toHaveBeenCalledWith('README.md', undefined);

    fireEvent.change(screen.getByPlaceholderText('Search project code...'), {
      target: { value: 'needle' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /src\/second\.ts:12/ }));
    expect(openFile).toHaveBeenCalledWith('src/second.ts', 12);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/project/search?q=needle'),
      expect.anything(),
    );
  });
});
