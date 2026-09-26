import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readReviewRegistrations,
  registerReview,
  reuseExistingWorkingTreeIdentity,
} from './review-registry.js';

describe('review registry', () => {
  let configDir: string;
  const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(join(tmpdir(), 'difit-reviews-'));
    process.env.DIFIT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('persists runtime metadata without source-specific defaults', async () => {
    await registerReview(
      {
        id: 'review-id',
        sessionKey: 'review:review-id',
        repositoryId: 'repository-id',
        repositoryPath: '/workspace/project',
        branch: 'feature/dashboard',
        baseRef: 'base',
        targetRef: '.',
        baseMode: 'merge-base',
        followsBranch: true,
        initialHead: 'abcdef',
        legacySessionKeys: [],
      },
      5001,
      1234,
      'hapi-session-1',
    );

    expect(await readReviewRegistrations()).toEqual([
      expect.objectContaining({
        id: 'review-id',
        repositoryPath: '/workspace/project',
        branch: 'feature/dashboard',
        port: 5001,
        agentAttached: true,
        hapiSessionId: 'hapi-session-1',
      }),
    ]);
  });

  it('keeps a known snapshot branch when restarted from another checkout branch', async () => {
    const context = {
      id: 'review-id',
      sessionKey: 'review:review-id',
      repositoryId: 'repository-id',
      repositoryPath: '/workspace/project',
      branch: 'feature/dashboard',
      baseRef: 'base',
      targetRef: 'target',
      baseMode: 'merge-base' as const,
      followsBranch: false,
      initialHead: 'abcdef',
      legacySessionKeys: [],
    };
    await registerReview(context, 5001);
    await registerReview({ ...context, branch: undefined }, 5002);

    expect(await readReviewRegistrations()).toEqual([
      expect.objectContaining({ branch: 'feature/dashboard', port: 5002 }),
    ]);
  });

  it('keeps the HAPI session identity when a review is reopened outside the agent shell', async () => {
    const context = {
      id: 'review-id',
      sessionKey: 'review:review-id',
      repositoryId: 'repository-id',
      repositoryPath: '/workspace/project',
      branch: 'feature/dashboard',
      baseRef: 'base',
      targetRef: '.',
      baseMode: 'merge-base' as const,
      followsBranch: true,
      initialHead: 'abcdef',
      legacySessionKeys: [],
    };
    await registerReview(context, 5001, 1234, 'hapi-session-1');
    await registerReview(context, 5002, 5678);

    expect(await readReviewRegistrations()).toEqual([
      expect.objectContaining({
        hapiSessionId: 'hapi-session-1',
        agentAttached: false,
        port: 5002,
      }),
    ]);
  });

  it('keeps a branch review identity when its MR is discovered later', async () => {
    const existingContext = {
      id: 'branch-review-id',
      sessionKey: 'review:branch-review-id',
      repositoryId: 'repository-id',
      repositoryPath: '/workspace/project',
      branch: 'feature/dashboard',
      baseRef: 'develop',
      targetRef: '.',
      baseMode: 'direct' as const,
      followsBranch: true,
      initialHead: 'abcdef',
      legacySessionKeys: [],
    };
    await registerReview(existingContext, 5001);

    const resolved = await reuseExistingWorkingTreeIdentity({
      ...existingContext,
      id: 'mr-derived-id',
      sessionKey: 'review:mr-derived-id',
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
    });

    expect(resolved).toMatchObject({
      id: 'branch-review-id',
      sessionKey: 'review:branch-review-id',
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
    });
    expect(resolved.legacySessionKeys).toContain('review:mr-derived-id');
  });

  it('reuses an older branch review only for its HAPI session', async () => {
    const oldReview = {
      id: 'legacy-review-id',
      sessionKey: 'review:legacy-review-id',
      repositoryId: 'repository-id',
      repositoryPath: '/workspace/project',
      branch: 'feature/dashboard',
      baseRef: 'HEAD',
      targetRef: '.',
      baseMode: 'direct' as const,
      followsBranch: true,
      initialHead: 'abcdef',
      legacySessionKeys: [],
    };
    await registerReview(oldReview, 5001, 1234, 'session-1');
    const scopedReview = {
      ...oldReview,
      id: 'scoped-review-id',
      sessionKey: 'review:scoped-review-id',
    };

    await expect(
      reuseExistingWorkingTreeIdentity(scopedReview, 'session-1'),
    ).resolves.toMatchObject({
      id: 'legacy-review-id',
      sessionKey: 'review:legacy-review-id',
    });
    await expect(reuseExistingWorkingTreeIdentity(scopedReview, 'session-2')).resolves.toEqual(
      scopedReview,
    );
  });

  it('keeps the original review identity when the same MR is reopened', async () => {
    const existingContext = {
      id: 'branch-review-id',
      sessionKey: 'review:branch-review-id',
      repositoryId: 'repository-id',
      repositoryPath: '/workspace/project',
      branch: 'feature/dashboard',
      baseRef: 'develop',
      targetRef: '.',
      baseMode: 'direct' as const,
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
      followsBranch: true,
      initialHead: 'abcdef',
      legacySessionKeys: [],
    };
    const original = await registerReview(existingContext, 5001);
    const duplicateContext = {
      ...existingContext,
      id: 'mr-derived-id',
      sessionKey: 'review:mr-derived-id',
    };
    const duplicate = await registerReview(duplicateContext, 5002);
    await fs.writeFile(
      join(configDir, 'reviews', `${original.id}.json`),
      `${JSON.stringify({ ...original, startedAt: '2026-09-15T10:00:00.000Z' }, null, 2)}\n`,
    );
    await fs.writeFile(
      join(configDir, 'reviews', `${duplicate.id}.json`),
      `${JSON.stringify({ ...duplicate, startedAt: '2026-09-15T11:00:00.000Z' }, null, 2)}\n`,
    );

    const resolved = await reuseExistingWorkingTreeIdentity(duplicateContext);

    expect(resolved).toMatchObject({
      id: 'branch-review-id',
      sessionKey: 'review:branch-review-id',
    });
    expect(resolved.legacySessionKeys).toContain('review:mr-derived-id');
  });

  it('does not reuse an identity from a different MR on the same branch', async () => {
    const existingContext = {
      id: 'first-review-id',
      sessionKey: 'review:first-review-id',
      repositoryId: 'repository-id',
      repositoryPath: '/workspace/project',
      branch: 'feature/dashboard',
      baseRef: 'develop',
      targetRef: '.',
      baseMode: 'direct' as const,
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/1',
      followsBranch: true,
      initialHead: 'abcdef',
      legacySessionKeys: [],
    };
    await registerReview(existingContext, 5001);

    const nextContext = {
      ...existingContext,
      id: 'second-review-id',
      sessionKey: 'review:second-review-id',
      reviewUrl: 'https://gitlab.example.test/group/project/-/merge_requests/2',
    };

    await expect(reuseExistingWorkingTreeIdentity(nextContext)).resolves.toEqual(nextContext);
  });
});
