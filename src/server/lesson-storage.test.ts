import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReviewLesson } from '../types/lesson.js';

import {
  MAX_LESSONS_PER_REPOSITORY,
  computeRepositoryId,
  readAllLessons,
  readLessons,
  readLessonsByRepositoryPath,
  upsertLessons,
} from './lesson-storage.js';

const configDirectories: string[] = [];
const previousConfigDirectory = process.env.DIFIT_CONFIG_DIR;

afterEach(async () => {
  for (const directory of configDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  if (previousConfigDirectory === undefined) delete process.env.DIFIT_CONFIG_DIR;
  else process.env.DIFIT_CONFIG_DIR = previousConfigDirectory;
});

async function useConfigDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'difit-lessons-'));
  configDirectories.push(directory);
  process.env.DIFIT_CONFIG_DIR = directory;
  return directory;
}

function createLesson(threadId: string, overrides: Partial<ReviewLesson> = {}): ReviewLesson {
  return {
    threadId,
    outcome: 'resolved',
    resolvedBy: 'browser',
    capturedAt: '2026-09-25T10:00:00.000Z',
    filePath: 'src/a.ts',
    position: { side: 'new', line: 10 },
    codeBefore: { content: 'before' },
    codeAfter: { content: 'after' },
    messages: [{ author: 'User', body: 'Fix this', createdAt: '2026-09-25T09:00:00.000Z' }],
    ...overrides,
  };
}

describe('lesson storage', () => {
  it('computes a stable repository id from the resolved path', () => {
    const id = computeRepositoryId('/tmp/some/repo');
    expect(id).toBe(computeRepositoryId('/tmp/some/repo/.'));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips lessons through the repository store', async () => {
    await useConfigDirectory();
    const repositoryId = computeRepositoryId('/repo');

    await upsertLessons(repositoryId, [createLesson('t1')]);

    const lessons = await readLessons(repositoryId);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ threadId: 't1', filePath: 'src/a.ts' });
  });

  it('upserts by thread id so the latest close wins', async () => {
    await useConfigDirectory();
    const repositoryId = computeRepositoryId('/repo');

    await upsertLessons(repositoryId, [createLesson('t1', { outcome: 'resolved' })]);
    await upsertLessons(repositoryId, [
      createLesson('t1', { outcome: 'closed' }),
      createLesson('t2'),
    ]);

    const lessons = await readLessons(repositoryId);
    expect(lessons.map((lesson) => lesson.threadId).sort()).toEqual(['t1', 't2']);
    expect(lessons.find((lesson) => lesson.threadId === 't1')?.outcome).toBe('closed');
  });

  it('evicts the oldest lessons beyond the repository cap', async () => {
    await useConfigDirectory();
    const repositoryId = computeRepositoryId('/repo');
    const lessons = Array.from({ length: MAX_LESSONS_PER_REPOSITORY + 10 }, (_, index) =>
      createLesson(`t${index}`),
    );

    await upsertLessons(repositoryId, lessons);

    const stored = await readLessons(repositoryId);
    expect(stored).toHaveLength(MAX_LESSONS_PER_REPOSITORY);
    expect(stored.some((lesson) => lesson.threadId === 't0')).toBe(false);
    expect(stored.some((lesson) => lesson.threadId === `t${MAX_LESSONS_PER_REPOSITORY + 9}`)).toBe(
      true,
    );
  });

  it('reads every repository store and supports path lookups', async () => {
    await useConfigDirectory();

    await upsertLessons(computeRepositoryId('/repo-a'), [createLesson('a1')]);
    await upsertLessons(computeRepositoryId('/repo-b'), [createLesson('b1')]);

    const all = await readAllLessons();
    expect(all.map((lesson) => lesson.threadId).sort()).toEqual(['a1', 'b1']);
    expect(all.every((lesson) => lesson.repositoryId.length === 64)).toBe(true);

    const byPath = await readLessonsByRepositoryPath('/repo-a');
    expect(byPath.map((lesson) => lesson.threadId)).toEqual(['a1']);
  });

  it('tolerates a corrupted store and returns no lessons', async () => {
    const directory = await useConfigDirectory();
    const repositoryId = computeRepositoryId('/repo');
    await fs.mkdir(join(directory, 'lessons'), { recursive: true });
    await fs.writeFile(join(directory, 'lessons', `${repositoryId}.json`), '{broken');

    expect(await readLessons(repositoryId)).toEqual([]);
  });

  it('stays disabled without DIFIT_CONFIG_DIR while running under tests', async () => {
    delete process.env.DIFIT_CONFIG_DIR;

    await upsertLessons(computeRepositoryId('/repo'), [createLesson('t1')]);

    expect(await readLessons(computeRepositoryId('/repo'))).toEqual([]);
  });
});
