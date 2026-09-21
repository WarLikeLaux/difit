import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

import { simpleGit } from 'simple-git';
import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffMode } from '../types/watch.js';

import { AuthService } from './auth.js';
import { writeCommentSessions } from './comment-storage.js';
import {
  getHubReviews as getSecuredHubReviews,
  startHubServer as startSecuredHubServer,
  type HubServerOptions,
} from './hub-server.js';
import { startServer as startSecuredServer, type ServerOptions } from './server.js';

globalThis.fetch = fetch as never;
const testAuthService = new AuthService({ disabled: true });
const startServer = (options: ServerOptions) =>
  startSecuredServer({ ...options, authService: options.authService ?? testAuthService });
const startHubServer = (port: number, host: string, options: HubServerOptions = {}) =>
  startSecuredHubServer(port, host, {
    ...options,
    authService: options.authService ?? testAuthService,
  });
const getHubReviews = () => getSecuredHubReviews(testAuthService);

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('branch review lifecycle', () => {
  let root: string;
  let repositoryPath: string;
  let configPath: string;
  let reviewServer: Server | undefined;
  let hubServer: Server | undefined;
  const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-review-lifecycle-'));
    repositoryPath = join(root, 'checkout');
    configPath = join(root, 'config');
    await fs.mkdir(repositoryPath);
    process.env.DIFIT_CONFIG_DIR = configPath;

    const git = simpleGit(repositoryPath);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.invalid');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    await git.checkoutLocalBranch('feature/one');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'base\nfeature\n');
    await git.add('.');
    await git.commit('feature');
  });

  afterEach(async () => {
    await closeServer(hubServer);
    await closeServer(reviewServer);
    if (originalConfigDir === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps comments across commits and blocks writes after a branch switch', async () => {
    const git = simpleGit(repositoryPath);
    const base = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    const first = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = first.server;

    const createdAt = new Date().toISOString();
    const initialComments = (await (
      await fetch(`http://localhost:${first.port}/api/comments-json`)
    ).json()) as { sessionEpoch: string };
    const createResponse = await fetch(`http://localhost:${first.port}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionEpoch: initialComments.sessionEpoch,
        threads: [
          {
            id: 'thread-one',
            filePath: 'example.txt',
            position: { side: 'new', line: 2 },
            createdAt,
            updatedAt: createdAt,
            messages: [
              {
                id: 'message-one',
                author: 'User',
                body: 'Please check this line',
                createdAt,
                updatedAt: createdAt,
              },
            ],
          },
        ],
      }),
    });
    expect(createResponse.status).toBe(200);
    await closeServer(reviewServer);
    reviewServer = undefined;

    await fs.appendFile(join(repositoryPath, 'example.txt'), 'next commit\n');
    await git.add('.');
    await git.commit('next');

    const second = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = second.server;

    const commentsResponse = await fetch(`http://localhost:${second.port}/api/comments-json`);
    const comments = (await commentsResponse.json()) as { threads: Array<{ id: string }> };
    expect(comments.threads.map((thread) => thread.id)).toContain('thread-one');

    const reviews = await getHubReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      branch: 'feature/one',
      followsBranch: true,
      running: true,
      stale: false,
      counts: { open: 1 },
    });

    let terminatedPid: number | undefined;
    const hub = await startHubServer(9345, '127.0.0.1', {
      publicOrigin: 'https://difit.example.test',
      terminateProcess: (pid) => {
        terminatedPid = pid;
      },
    });
    hubServer = hub.server;
    const hubPageResponse = await fetch(`http://localhost:${hub.port}/`);
    const hubPage = await hubPageResponse.text();
    const nonce = hubPage.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeTruthy();
    expect(hubPageResponse.headers.get('Content-Security-Policy')).toContain(
      `script-src 'self' 'nonce-${nonce}'`,
    );
    expect(hubPageResponse.headers.get('Content-Security-Policy')).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(hubPage).toContain('Search reviews');
    expect(hubPage).toContain('Recent activity');
    expect(hubPage).toContain('Filter by repository');
    expect(hubPage).not.toContain('Log out');
    expect(hubPage).not.toContain('data-filter=');
    expect(hubPage).not.toContain('Technical details');
    expect(hubPage).not.toContain('data-all-reviews');
    const wrongPublicOrigin = await fetch(`http://localhost:${hub.port}/api/reviews`, {
      headers: {
        Host: 'difit.example.test',
        Origin: 'http://difit.example.test',
      },
    });
    expect(wrongPublicOrigin.status).toBe(403);
    const hubResponse = await fetch(`http://localhost:${hub.port}/api/reviews`);
    expect(hubResponse.status).toBe(200);
    const hubReviews = (await hubResponse.json()) as Array<{ id: string; viewerUrl?: string }>;
    expect(hubReviews).toHaveLength(1);
    expect(hubReviews[0]?.viewerUrl).toBe(`/reviews/${hubReviews[0]?.id}/`);
    const proxiedDiff = await fetch(
      `http://localhost:${hub.port}${hubReviews[0]?.viewerUrl}api/diff`,
      {
        headers: {
          Host: 'difit.example.test',
          Origin: 'https://difit.example.test',
        },
      },
    );
    expect(proxiedDiff.status).toBe(200);
    expect(proxiedDiff.headers.get('X-Difit-Review-Label')).toBe('feature/one');
    await expect(proxiedDiff.json()).resolves.toMatchObject({ reviewId: hubReviews[0]?.id });

    const closeResponse = await fetch(
      `http://localhost:${hub.port}/api/reviews/${hubReviews[0]?.id}/close`,
      { method: 'POST' },
    );
    expect(closeResponse.status).toBe(200);
    await expect(closeResponse.json()).resolves.toEqual({ success: true });
    expect(terminatedPid).toBe(process.pid);

    await git.checkoutLocalBranch('feature/two');
    const staleResponse = await fetch(`http://localhost:${second.port}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads: [] }),
    });
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      code: 'REVIEW_BRANCH_CHANGED',
      expectedBranch: 'feature/one',
      currentBranch: 'feature/two',
    });

    const staleDiff = (await (await fetch(`http://localhost:${second.port}/api/diff`)).json()) as {
      reviewStale: boolean;
      currentBranch: string;
    };
    expect(staleDiff).toMatchObject({ reviewStale: true, currentBranch: 'feature/two' });
  });

  it('keeps a review interactive while its agent is offline and delivers queued feedback later', async () => {
    const git = simpleGit(repositoryPath);
    const base = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    const first = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = first.server;

    const context = (await (
      await fetch(`http://localhost:${first.port}/api/review-context`)
    ).json()) as { id: string };
    await closeServer(reviewServer);
    reviewServer = undefined;

    const hub = await startHubServer(9345, '127.0.0.1');
    hubServer = hub.server;
    const reviewPath = `/reviews/${context.id}`;
    const archivedDiff = await fetch(`http://localhost:${hub.port}${reviewPath}/api/diff`);
    expect(archivedDiff.status).toBe(200);
    await expect(archivedDiff.json()).resolves.toMatchObject({
      reviewId: context.id,
      reviewBranch: 'feature/one',
      openInEditorAvailable: false,
      reviewOffline: true,
      reviewSnapshotAt: expect.any(String),
    });

    const comments = (await (
      await fetch(`http://localhost:${hub.port}${reviewPath}/api/comments-json`)
    ).json()) as { sessionEpoch: string; version: number };
    const createdAt = new Date().toISOString();
    const queuedResponse = await fetch(`http://localhost:${hub.port}${reviewPath}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionEpoch: comments.sessionEpoch,
        baseVersion: comments.version,
        threads: [
          {
            id: 'offline-thread',
            filePath: 'example.txt',
            position: { side: 'new', line: 2 },
            createdAt,
            updatedAt: createdAt,
            messages: [
              {
                id: 'offline-message',
                author: 'User',
                body: 'Wait for the matching branch agent',
                createdAt,
                updatedAt: createdAt,
              },
            ],
          },
        ],
      }),
    });
    expect(queuedResponse.status).toBe(200);
    await expect(getHubReviews()).resolves.toEqual([
      expect.objectContaining({
        id: context.id,
        agentConnected: false,
        pendingMessages: 1,
        viewerUrl: `${reviewPath}/`,
      }),
    ]);

    const second = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = second.server;
    const events = (await (
      await fetch(`http://localhost:${second.port}/api/agent-events`)
    ).json()) as { reviewId: string; events: Array<{ threadId: string }> };
    expect(events.reviewId).toBe(context.id);
    expect(events.events).toEqual([
      expect.objectContaining({ type: 'userMessage', threadId: 'offline-thread' }),
    ]);

    await closeServer(reviewServer);
    reviewServer = undefined;
    const deleteResponse = await fetch(`http://localhost:${hub.port}/api/reviews/${context.id}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(200);
    await expect(getHubReviews()).resolves.toEqual([]);
    expect(await fetch(`http://localhost:${hub.port}${reviewPath}/api/diff`)).toMatchObject({
      status: 404,
    });
  });

  it('migrates comments from the previous commit-based MR session', async () => {
    const git = simpleGit(repositoryPath);
    const base = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    const head = (await git.revparse(['HEAD'])).trim();
    const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
    const createdAt = new Date().toISOString();
    await writeCommentSessions(
      repositoryId,
      new Map([
        [
          `${base.slice(0, 7)}:${head.slice(0, 7)}:merge-base`,
          {
            version: 1,
            threads: [
              {
                id: 'legacy-thread',
                filePath: 'example.txt',
                position: { side: 'new', line: 2 },
                createdAt,
                updatedAt: createdAt,
                messages: [
                  {
                    id: 'legacy-message',
                    body: 'Existing review comment',
                    createdAt,
                    updatedAt: createdAt,
                  },
                ],
              },
            ],
          },
        ],
      ]),
    );

    const started = await startServer({
      selection: { baseCommitish: base, targetCommitish: head, baseMode: 'merge-base' },
      repoPath: repositoryPath,
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.SPECIFIC,
    });
    reviewServer = started.server;

    const comments = (await (
      await fetch(`http://localhost:${started.port}/api/comments-json`)
    ).json()) as { threads: Array<{ id: string }> };
    expect(comments.threads.map((thread) => thread.id)).toContain('legacy-thread');
  });

  it('does not migrate an ambiguous working-tree session into a branch review', async () => {
    const git = simpleGit(repositoryPath);
    const base = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
    const createdAt = new Date().toISOString();
    await writeCommentSessions(
      repositoryId,
      new Map([
        [
          `${base.slice(0, 7)}:.:merge-base`,
          {
            version: 1,
            threads: [
              {
                id: 'ambiguous-thread',
                filePath: 'example.txt',
                position: { side: 'new', line: 2 },
                createdAt,
                updatedAt: createdAt,
                messages: [
                  {
                    id: 'ambiguous-message',
                    body: 'Comment from an unknown branch',
                    createdAt,
                    updatedAt: createdAt,
                  },
                ],
              },
            ],
          },
        ],
      ]),
    );

    const started = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = started.server;

    const comments = (await (
      await fetch(`http://localhost:${started.port}/api/comments-json`)
    ).json()) as { threads: Array<{ id: string }> };
    expect(comments.threads).toEqual([]);
  });

  it('rejects comment state held by a browser from a previous server process', async () => {
    const git = simpleGit(repositoryPath);
    const base = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
    const first = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = first.server;
    const firstComments = (await (
      await fetch(`http://localhost:${first.port}/api/comments-json`)
    ).json()) as { sessionEpoch: string };
    await closeServer(reviewServer);
    reviewServer = undefined;

    const second = await startServer({
      selection: { baseCommitish: base, targetCommitish: '.', baseMode: 'merge-base' },
      repoPath: repositoryPath,
      preferredPort: 9340,
      openBrowser: false,
      keepAlive: true,
      diffMode: DiffMode.DOT,
    });
    reviewServer = second.server;
    const createdAt = new Date().toISOString();
    const staleWrite = await fetch(`http://localhost:${second.port}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionEpoch: firstComments.sessionEpoch,
        threads: [
          {
            id: 'stale-thread',
            filePath: 'example.txt',
            position: { side: 'new', line: 2 },
            createdAt,
            updatedAt: createdAt,
            messages: [
              {
                id: 'stale-message',
                body: 'Comment cached by an old browser tab',
                createdAt,
                updatedAt: createdAt,
              },
            ],
          },
        ],
      }),
    });

    expect(staleWrite.status).toBe(409);
    await expect(staleWrite.json()).resolves.toMatchObject({ staleClient: true, threads: [] });
    const currentComments = (await (
      await fetch(`http://localhost:${second.port}/api/comments-json`)
    ).json()) as { threads: Array<{ id: string }> };
    expect(currentComments.threads).toEqual([]);
  });
});
