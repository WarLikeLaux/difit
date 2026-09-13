import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteReviewSnapshot,
  readReviewSnapshot,
  writeReviewSnapshot,
} from './review-snapshot.js';

describe('review snapshots', () => {
  let configDir: string;
  const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(join(tmpdir(), 'difit-snapshots-'));
    process.env.DIFIT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('persists and deletes the last renderable diff', async () => {
    await writeReviewSnapshot('review-1', {
      commit: 'abc1234',
      files: [],
      reviewId: 'review-1',
      reviewBranch: 'feature/one',
    });

    await expect(readReviewSnapshot('review-1')).resolves.toMatchObject({
      commit: 'abc1234',
      reviewId: 'review-1',
    });

    await deleteReviewSnapshot('review-1');
    await expect(readReviewSnapshot('review-1')).resolves.toBeUndefined();
  });
});
