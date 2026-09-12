import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth-client.js', () => ({
  authenticatedFetch: vi.fn(),
}));

const { authenticatedFetch } = await import('./auth-client.js');
const { createReviewCommand } = await import('./review-command.js');

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('review context command', () => {
  it('requires a viewer port', () => {
    const context = createReviewCommand().commands.find((command) => command.name() === 'context');

    expect(context).toBeDefined();
    expect(context?.options.find((option) => option.long === '--port')?.mandatory).toBe(true);
  });

  it('prints context obtained through the authenticated CLI client', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      Response.json({ id: 'review-id', reviewUrl: 'https://example.test/review/1' }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createReviewCommand().parseAsync(['context', '--port', '4966'], { from: 'user' });

    expect(authenticatedFetch).toHaveBeenCalledWith('http://localhost:4966/api/review-context');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ id: 'review-id', reviewUrl: 'https://example.test/review/1' }),
    );
  });
});
