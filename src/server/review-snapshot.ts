import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import type { DiffResponse } from '../types/diff.js';

import { ensurePrivateDirectory, writePrivateFile } from './private-storage.js';

interface StoredReviewSnapshot {
  version: 1;
  reviewId: string;
  capturedAt: string;
  diff: DiffResponse;
}

function getConfigDirectory(): string {
  const configDir = process.env.DIFIT_CONFIG_DIR?.trim();
  return configDir || join(homedir(), '.difit');
}

function getSnapshotPath(reviewId: string): string {
  return join(getConfigDirectory(), 'review-snapshots', `${reviewId}.json`);
}

function isStoredReviewSnapshot(value: unknown): value is StoredReviewSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredReviewSnapshot>;
  return (
    candidate.version === 1 &&
    typeof candidate.reviewId === 'string' &&
    typeof candidate.capturedAt === 'string' &&
    Boolean(candidate.diff) &&
    typeof candidate.diff === 'object' &&
    !Array.isArray(candidate.diff) &&
    Array.isArray(candidate.diff.files)
  );
}

export async function writeReviewSnapshot(reviewId: string, diff: DiffResponse): Promise<void> {
  const path = getSnapshotPath(reviewId);
  const snapshot: StoredReviewSnapshot = {
    version: 1,
    reviewId,
    capturedAt: new Date().toISOString(),
    diff: structuredClone(diff),
  };
  await ensurePrivateDirectory(getConfigDirectory());
  await ensurePrivateDirectory(dirname(path));
  await writePrivateFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function readReviewSnapshot(reviewId: string): Promise<DiffResponse | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(getSnapshotPath(reviewId), 'utf8'));
    return isStoredReviewSnapshot(parsed) && parsed.reviewId === reviewId
      ? structuredClone(parsed.diff)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteReviewSnapshot(reviewId: string): Promise<void> {
  await fs.rm(getSnapshotPath(reviewId), { force: true });
}
