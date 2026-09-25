import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

import type { ReviewLesson } from '../types/lesson.js';

import { ensurePrivateDirectory, writePrivateFile } from './private-storage.js';

export const MAX_LESSONS_PER_REPOSITORY = 200;

const STORE_VERSION = 1 as const;

function getLessonStorageDirectory(): string {
  const configDir = process.env.DIFIT_CONFIG_DIR?.trim();
  return configDir || join(homedir(), '.difit');
}

function isLessonStorageDisabled(): boolean {
  return process.env.NODE_ENV === 'test' && !process.env.DIFIT_CONFIG_DIR?.trim();
}

function getLessonStorePath(repositoryId: string): string {
  return join(getLessonStorageDirectory(), 'lessons', `${repositoryId}.json`);
}

/**
 * Stable repository identifier shared by the viewer, the hub, the CLI, and MCP
 * so every consumer resolves lessons for the same store file.
 */
export function computeRepositoryId(repositoryPath: string): string {
  return createHash('sha256').update(resolve(repositoryPath)).digest('hex');
}

function isReviewLesson(value: unknown): value is ReviewLesson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ReviewLesson>;
  return (
    typeof candidate.threadId === 'string' &&
    (candidate.outcome === 'resolved' || candidate.outcome === 'closed') &&
    typeof candidate.resolvedBy === 'string' &&
    typeof candidate.capturedAt === 'string' &&
    typeof candidate.filePath === 'string' &&
    Boolean(candidate.position) &&
    typeof candidate.position === 'object' &&
    Array.isArray(candidate.messages)
  );
}

export async function readLessons(repositoryId: string): Promise<ReviewLesson[]> {
  if (isLessonStorageDisabled()) return [];

  try {
    const raw = await fs.readFile(getLessonStorePath(repositoryId), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

    const lessons = (parsed as { lessons?: unknown }).lessons;
    if (!Array.isArray(lessons)) return [];
    return lessons.filter(isReviewLesson);
  } catch {
    return [];
  }
}

/** Reads lessons across every repository store, tagging each with its repository id. */
export async function readAllLessons(): Promise<Array<ReviewLesson & { repositoryId: string }>> {
  if (isLessonStorageDisabled()) return [];

  let names: string[];
  try {
    const entries = await fs.readdir(join(getLessonStorageDirectory(), 'lessons'), {
      withFileTypes: true,
    });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const stores = await Promise.all(
    names.map(async (name): Promise<Array<ReviewLesson & { repositoryId: string }>> => {
      const repositoryId = name.slice(0, -'.json'.length);
      return (await readLessons(repositoryId)).map((lesson) => ({ ...lesson, repositoryId }));
    }),
  );
  return stores.flat();
}

/** Convenience lookup by repository path; without a path it returns lessons for every repository. */
export async function readLessonsByRepositoryPath(
  repositoryPath?: string,
): Promise<Array<ReviewLesson & { repositoryId?: string }>> {
  if (!repositoryPath) return readAllLessons();
  return readLessons(computeRepositoryId(repositoryPath));
}

const storeWriteQueues = new Map<string, Promise<void>>();

function enqueueStoreWrite(repositoryId: string, operation: () => Promise<void>): Promise<void> {
  const previous = storeWriteQueues.get(repositoryId) ?? Promise.resolve();
  const operationPromise = previous.then(operation, operation);
  storeWriteQueues.set(
    repositoryId,
    operationPromise.catch(() => undefined),
  );
  return operationPromise;
}

/**
 * Merges lessons into the repository store, keyed by thread id so the latest
 * close of a thread wins. Keeps at most {@link MAX_LESSONS_PER_REPOSITORY}
 * lessons, evicting the oldest entries first.
 */
export async function upsertLessons(
  repositoryId: string,
  lessons: readonly ReviewLesson[],
): Promise<void> {
  if (lessons.length === 0 || isLessonStorageDisabled()) return;

  await enqueueStoreWrite(repositoryId, async () => {
    const existing = await readLessons(repositoryId);
    const byThreadId = new Map(existing.map((lesson) => [lesson.threadId, lesson]));
    for (const lesson of lessons) byThreadId.set(lesson.threadId, lesson);
    const merged = [...byThreadId.values()].slice(-MAX_LESSONS_PER_REPOSITORY);

    const path = getLessonStorePath(repositoryId);
    const serialized = `${JSON.stringify({ version: STORE_VERSION, lessons: merged }, null, 2)}\n`;

    await ensurePrivateDirectory(getLessonStorageDirectory());
    await ensurePrivateDirectory(dirname(path));
    await writePrivateFile(path, serialized);
  });
}
