import { type AuthService, getDefaultAuthService } from '../server/auth.js';

export async function authenticatedFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  auth: AuthService = getDefaultAuthService(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', await auth.getCliAuthorizationHeader());
  return fetch(input, { ...init, headers });
}
