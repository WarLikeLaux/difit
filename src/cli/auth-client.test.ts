import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../server/auth.js';

import { authenticatedFetch } from './auth-client.js';

describe('authenticatedFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds the private CLI credential without putting it in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthService({ disabled: true });

    await authenticatedFetch('http://127.0.0.1:4966/api/diff', {}, auth);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4966/api/diff');
    expect(url).not.toContain('token');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer difit-test-cli-token-disabled',
    );
  });
});
