import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readReviewRegistrations, registerReview } from './review-registry.js';

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
    );

    expect(await readReviewRegistrations()).toEqual([
      expect.objectContaining({
        id: 'review-id',
        repositoryPath: '/workspace/project',
        branch: 'feature/dashboard',
        port: 5001,
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
});
