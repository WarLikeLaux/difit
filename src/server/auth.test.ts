import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIE_NAME, AuthService, monitorAuthenticatedConnection } from './auth.js';

function requestWithHeaders(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    get: (name: string) => normalized[name.toLowerCase()],
  } as Request;
}

describe('AuthService', () => {
  let root: string;
  let now: number;
  let auth: AuthService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-auth-'));
    now = Date.parse('2026-09-12T00:00:00.000Z');
    auth = new AuthService({
      configDirectory: root,
      now: () => now,
      sessionTtlMs: 1_000,
    });
    await auth.initialize();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates private persistent credentials without storing browser session tokens', async () => {
    const accessKey = await auth.getAccessKey();
    const token = await auth.createBrowserSession(accessKey);
    expect(token).toBeTruthy();

    const authDirectory = join(root, 'auth');
    expect((await fs.stat(authDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(authDirectory, 'access.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(authDirectory, 'cli-token'))).mode & 0o777).toBe(0o600);

    const sessionFiles = await fs.readdir(join(authDirectory, 'sessions'));
    expect(sessionFiles).toHaveLength(1);
    expect(sessionFiles[0]).not.toContain(token);
    expect(
      await fs.readFile(join(authDirectory, 'sessions', sessionFiles[0]), 'utf8'),
    ).not.toContain(token);

    const restarted = new AuthService({
      configDirectory: root,
      now: () => now,
      sessionTtlMs: 1_000,
    });
    expect(
      await restarted.authenticateRequest(
        requestWithHeaders({ Cookie: `${AUTH_COOKIE_NAME}=${token}` }),
      ),
    ).toMatchObject({ kind: 'browser' });
  });

  it('issues a host-only secure lax cookie with a 30-day production lifetime', () => {
    const productionAuth = new AuthService({ configDirectory: root });
    const cookie = productionAuth.createSessionCookie('opaque-session');
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=opaque-session`);
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });

  it('enforces expiry, logout, and access-key rotation on the server', async () => {
    const accessKey = await auth.getAccessKey();
    const firstToken = await auth.createBrowserSession(accessKey);
    const secondToken = await auth.createBrowserSession(accessKey);
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();

    const firstRequest = requestWithHeaders({ Cookie: `${AUTH_COOKIE_NAME}=${firstToken}` });
    const secondRequest = requestWithHeaders({ Cookie: `${AUTH_COOKIE_NAME}=${secondToken}` });
    const firstPrincipal = await auth.authenticateRequest(firstRequest);
    expect(firstPrincipal).toMatchObject({ kind: 'browser' });
    await auth.revokeBrowserSession(firstPrincipal!);
    expect(await auth.authenticateRequest(firstRequest)).toBeUndefined();
    expect(await auth.authenticateRequest(secondRequest)).toMatchObject({ kind: 'browser' });

    await auth.rotateAccessKey();
    expect(await auth.authenticateRequest(secondRequest)).toBeUndefined();
    expect(await auth.createBrowserSession(accessKey)).toBeUndefined();

    const freshKey = await auth.getAccessKey();
    const expiringToken = await auth.createBrowserSession(freshKey);
    now += 1_001;
    expect(
      await auth.authenticateRequest(
        requestWithHeaders({ Cookie: `${AUTH_COOKIE_NAME}=${expiringToken}` }),
      ),
    ).toBeUndefined();
  });

  it('uses an independent CLI bearer and revalidates long-lived browser access', async () => {
    const authorization = await auth.getCliAuthorizationHeader();
    const cliPrincipal = await auth.authenticateRequest(
      requestWithHeaders({ Authorization: authorization }),
    );
    expect(cliPrincipal).toMatchObject({ kind: 'cli' });
    await auth.rotateCliToken();
    expect(await auth.isPrincipalValid(cliPrincipal!)).toBe(false);

    const token = await auth.createBrowserSession(await auth.getAccessKey());
    const principal = await auth.authenticateRequest(
      requestWithHeaders({ Cookie: `${AUTH_COOKIE_NAME}=${token}` }),
    );
    expect(principal).toMatchObject({ kind: 'browser' });

    const closed = vi.fn();
    const stop = monitorAuthenticatedConnection(auth, principal!, closed, 10);
    await auth.revokeBrowserSession(principal!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toHaveBeenCalledOnce();
    stop();
  });

  it('rejects malformed, unknown, and wrong authentication material', async () => {
    expect(await auth.createBrowserSession('wrong')).toBeUndefined();
    expect(await auth.authenticateRequest(requestWithHeaders({}))).toBeUndefined();
    expect(
      await auth.authenticateRequest(requestWithHeaders({ Authorization: 'Bearer wrong' })),
    ).toBeUndefined();
    expect(
      await auth.authenticateRequest(requestWithHeaders({ Cookie: `${AUTH_COOKIE_NAME}=unknown` })),
    ).toBeUndefined();
  });
});
