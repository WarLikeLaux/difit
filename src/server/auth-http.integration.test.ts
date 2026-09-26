import { promises as fs } from 'node:fs';
import { request as createHttpRequest, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { simpleGit } from 'simple-git';
import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiffSelection } from '../utils/diffSelection.js';

import { AuthService } from './auth.js';
import { startHubServer } from './hub-server.js';
import { startServer } from './server.js';

globalThis.fetch = fetch as never;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('browser and CLI authentication', () => {
  const originalConfigDirectory = process.env.DIFIT_CONFIG_DIR;
  let root: string;
  let repositoryPath: string;
  let auth: AuthService;
  let viewerServer: Server | undefined;
  let hubServer: Server | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-auth-http-'));
    process.env.DIFIT_CONFIG_DIR = join(root, 'config');
    repositoryPath = join(root, 'repo');
    await fs.mkdir(repositoryPath);
    const git = simpleGit(repositoryPath);
    await git.init();
    await git.addConfig('user.email', 'security-test@example.invalid');
    await git.addConfig('user.name', 'Security Test');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'before\n');
    await git.add('.');
    await git.commit('before');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'after\n');
    await git.add('.');
    await git.commit('after');
    auth = new AuthService({ configDirectory: process.env.DIFIT_CONFIG_DIR });
  });

  afterEach(async () => {
    await closeServer(hubServer);
    await closeServer(viewerServer);
    await fs.rm(root, { recursive: true, force: true });
    if (originalConfigDirectory === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDirectory;
  });

  it('returns to an open-review link after browser login', async () => {
    const hub = await startHubServer(await availablePort(), '127.0.0.1', {
      authService: auth,
      publicOrigin: 'https://reviews.example.test',
    });
    hubServer = hub.server;
    const hubUrl = `http://127.0.0.1:${hub.port}`;
    const next = `/open?repo=${encodeURIComponent(repositoryPath)}&branch=feature%2Freview&hapiSessionId=session-1`;
    const navigate = await fetch(`${hubUrl}${next}`, {
      headers: { Host: 'reviews.example.test', Accept: 'text/html' },
      redirect: 'manual',
    });
    expect(navigate.status).toBe(303);
    const loginPath = navigate.headers.get('location');
    expect(loginPath).toBe(`/auth/login?next=${encodeURIComponent(next)}`);

    const loginPage = await fetch(`${hubUrl}${loginPath}`, {
      headers: { Host: 'reviews.example.test' },
    });
    expect(await loginPage.text()).toContain(`/auth/login?next=${encodeURIComponent(next)}`);
    const login = await fetch(`${hubUrl}${loginPath}`, {
      method: 'POST',
      body: new URLSearchParams({ accessKey: await auth.getAccessKey() }).toString(),
      headers: {
        Host: 'reviews.example.test',
        Origin: 'https://reviews.example.test',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe(next);
  });

  it('protects hub, proxy, direct viewer, mutations, and an open SSE after logout', async () => {
    const viewer = await startServer({
      authService: auth,
      host: '127.0.0.1',
      preferredPort: await availablePort(),
      repoPath: repositoryPath,
      selection: createDiffSelection('HEAD^', 'HEAD'),
      keepAlive: true,
    });
    viewerServer = viewer.server;
    const hubPort = await availablePort();
    const hub = await startHubServer(hubPort, '127.0.0.1', {
      authService: auth,
      publicOrigin: 'https://reviews.example.test',
    });
    hubServer = hub.server;
    const hubUrl = `http://127.0.0.1:${hub.port}`;
    const browserHeaders = {
      Host: 'reviews.example.test',
      Origin: 'https://reviews.example.test',
      'Sec-Fetch-Site': 'same-origin',
    };

    expect(
      (await fetch(`${hubUrl}/api/reviews`, { headers: { Host: browserHeaders.Host } })).status,
    ).toBe(401);
    expect((await fetch(`http://127.0.0.1:${viewer.port}/api/diff`)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${viewer.port}/api/open-in-editor`, {
          method: 'POST',
          body: JSON.stringify({ filepath: 'example.txt' }),
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${viewer.port}/api/diff`, {
          headers: { Authorization: await auth.getCliAuthorizationHeader() },
        })
      ).status,
    ).toBe(200);

    const accessKey = await auth.getAccessKey();
    const login = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ accessKey }).toString(),
      headers: {
        ...browserHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-difit_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain=');
    const cookie = setCookie.split(';', 1)[0];

    const authenticatedHeaders = { ...browserHeaders, Cookie: cookie };
    const reviewsResponse = await fetch(`${hubUrl}/api/reviews`, {
      headers: authenticatedHeaders,
    });
    expect(reviewsResponse.status).toBe(200);
    const reviews = (await reviewsResponse.json()) as Array<{ id: string }>;
    expect(reviews).toHaveLength(1);
    const reviewId = reviews[0]?.id;
    expect(
      (
        await fetch(`${hubUrl}/reviews/${reviewId}/api/diff`, {
          headers: authenticatedHeaders,
        })
      ).status,
    ).toBe(200);

    const crossSiteNavigation = await new Promise<{ status: number; contentType: string }>(
      (resolve, reject) => {
        const request = createHttpRequest(
          {
            hostname: '127.0.0.1',
            port: hub.port,
            path: `/reviews/${reviewId}/`,
            headers: {
              Host: browserHeaders.Host,
              Cookie: cookie,
              Accept: 'text/html',
              Referer: 'https://hapi.local/',
              'Sec-Fetch-Site': 'cross-site',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-User': '?1',
            },
          },
          (result) => {
            result.resume();
            result.on('end', () =>
              resolve({
                status: result.statusCode ?? 0,
                contentType: String(result.headers['content-type'] ?? ''),
              }),
            );
          },
        );
        request.on('error', reject);
        request.end();
      },
    );
    expect(crossSiteNavigation.status).toBe(200);
    expect(crossSiteNavigation.contentType).toContain('text/html');

    expect(
      (
        await fetch(`${hubUrl}/api/reviews/not-found/close`, {
          method: 'POST',
          headers: { Host: browserHeaders.Host, Cookie: cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${hubUrl}/api/reviews/not-found/close`, {
          method: 'POST',
          headers: { ...authenticatedHeaders, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    const hostileStatuses = await Promise.all(
      [
        { ...authenticatedHeaders, Origin: 'null' },
        { ...authenticatedHeaders, Origin: 'https://reviews.example.test:444' },
        {
          ...authenticatedHeaders,
          Origin: 'https://reviews.example.test',
          'Sec-Fetch-Site': 'same-site',
        },
        {
          ...authenticatedHeaders,
          Host: 'evil.example.test',
          'X-Forwarded-Host': 'reviews.example.test',
          'X-Forwarded-Proto': 'https',
        },
      ].map(
        async (headers) =>
          (
            await fetch(`${hubUrl}/api/reviews/not-found/close`, {
              method: 'POST',
              headers,
            })
          ).status,
      ),
    );
    // Undici owns the actual Host header. The final request keeps a valid transport Host and proves
    // that spoofed forwarded headers are ignored rather than replacing it.
    expect(hostileStatuses).toEqual([403, 403, 403, 404]);

    const page = await fetch(`${hubUrl}/`, { headers: authenticatedHeaders });
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');

    await closeServer(hubServer);
    hubServer = undefined;
    auth = new AuthService({ configDirectory: process.env.DIFIT_CONFIG_DIR });
    const restartedHub = await startHubServer(hubPort, '127.0.0.1', {
      authService: auth,
      publicOrigin: 'https://reviews.example.test',
    });
    hubServer = restartedHub.server;
    expect((await fetch(`${hubUrl}/api/reviews`, { headers: authenticatedHeaders })).status).toBe(
      200,
    );

    const events = await fetch(`${hubUrl}/api/events`, { headers: authenticatedHeaders });
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const viewerEvents = await fetch(`${hubUrl}/reviews/${reviewId}/api/heartbeat`, {
      headers: authenticatedHeaders,
    });
    expect(viewerEvents.status).toBe(200);
    const viewerReader = viewerEvents.body!.getReader();
    expect((await viewerReader.read()).done).toBe(false);

    const logout = await fetch(`${hubUrl}/auth/logout`, {
      method: 'POST',
      headers: authenticatedHeaders,
      redirect: 'manual',
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${hubUrl}/api/reviews`, { headers: authenticatedHeaders })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`http://127.0.0.1:${viewer.port}/api/diff`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);

    const closed = await Promise.race([
      (async () => {
        while (!(await reader.read()).done) {
          // Wait for the server-side session monitor to close the stream.
        }
        return true;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500)),
    ]);
    expect(closed).toBe(true);
    const viewerClosed = await Promise.race([
      (async () => {
        while (!(await viewerReader.read()).done) {
          // Wait for the child viewer to observe the revoked shared session.
        }
        return true;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500)),
    ]);
    expect(viewerClosed).toBe(true);
  });
});
