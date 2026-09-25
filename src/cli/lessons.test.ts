import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeCommentSessions } from '../server/comment-storage.js';
import { computeRepositoryId, readLessons, upsertLessons } from '../server/lesson-storage.js';
import type { DiffCommentThread } from '../types/diff.js';

const { createLessonsCommand } = await import('./lessons.js');

const configDirectories: string[] = [];
const previousConfigDirectory = process.env.DIFIT_CONFIG_DIR;

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const directory of configDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  if (previousConfigDirectory === undefined) delete process.env.DIFIT_CONFIG_DIR;
  else process.env.DIFIT_CONFIG_DIR = previousConfigDirectory;
});

async function useConfigDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'difit-lessons-cli-'));
  configDirectories.push(directory);
  process.env.DIFIT_CONFIG_DIR = directory;
  return directory;
}

async function createFakeRepository(): Promise<string> {
  const repositoryPath = await fs.mkdtemp(join(tmpdir(), 'difit-lessons-repo-'));
  configDirectories.push(repositoryPath);
  await fs.mkdir(join(repositoryPath, 'src'), { recursive: true });
  await fs.writeFile(join(repositoryPath, 'src', 'a.ts'), 'fixed line\n', 'utf-8');
  return repositoryPath;
}

function createThread(id: string, overrides: Partial<DiffCommentThread> = {}): DiffCommentThread {
  return {
    id,
    filePath: 'src/a.ts',
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T09:30:00.000Z',
    position: { side: 'new', line: 1 },
    messages: [
      {
        id: `${id}-m1`,
        body: 'Guard the empty case',
        author: 'User',
        createdAt: '2026-09-25T09:10:00.000Z',
        updatedAt: '2026-09-25T09:10:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('difit lessons command', () => {
  it('prints stored lessons as markdown by default', async () => {
    const configDirectory = await useConfigDirectory();
    const repositoryPath = await createFakeRepository();
    await upsertLessons(computeRepositoryId(repositoryPath), [
      {
        threadId: 't1',
        outcome: 'resolved',
        resolvedBy: 'browser',
        capturedAt: '2026-09-25T10:00:00.000Z',
        filePath: 'src/a.ts',
        position: { side: 'new', line: 1 },
        codeBefore: { content: 'original' },
        codeAfter: { content: 'fixed line' },
        messages: [
          { author: 'User', body: 'Guard the empty case', createdAt: '2026-09-25T09:10:00.000Z' },
        ],
      },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createLessonsCommand().parseAsync(['--repo', repositoryPath], { from: 'user' });

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('## Lesson: src/a.ts:L1');
    expect(output).toContain('Guard the empty case');
    expect(output).toContain('fixed line');
    expect(configDirectory).toBeTruthy();
  });

  it('reports when no lessons are recorded', async () => {
    await useConfigDirectory();
    const repositoryPath = await createFakeRepository();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createLessonsCommand().parseAsync(['--repo', repositoryPath], { from: 'user' });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('No lessons recorded yet'));
  });

  it('backfills resolved threads once and skips them on the next run', async () => {
    await useConfigDirectory();
    const repositoryPath = await createFakeRepository();
    const repositoryId = computeRepositoryId(repositoryPath);
    const sessionKey = 'review:review-1';
    await writeCommentSessions(
      repositoryId,
      new Map([
        [
          sessionKey,
          {
            threads: [
              createThread('t1', { resolvedAt: '2026-09-25T10:00:00.000Z' }),
              createThread('t2'),
            ],
            version: 1,
          },
        ],
      ]),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createLessonsCommand().parseAsync(['backfill', '--repo', repositoryPath], {
      from: 'user',
    });

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ repositoryId, added: 1, skipped: 0, failed: 0 }, null, 2),
    );
    const lessons = await readLessons(repositoryId);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      threadId: 't1',
      outcome: 'resolved',
      resolvedBy: 'cli',
      capturedAt: '2026-09-25T10:00:00.000Z',
      codeAfter: { content: 'fixed line' },
    });
    expect(lessons[0].messages).toEqual([
      { author: 'User', body: 'Guard the empty case', createdAt: '2026-09-25T09:10:00.000Z' },
    ]);

    await createLessonsCommand().parseAsync(['backfill', '--repo', repositoryPath], {
      from: 'user',
    });
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ repositoryId, added: 0, skipped: 1, failed: 0 }, null, 2),
    );
    expect(await readLessons(repositoryId)).toHaveLength(1);
  });

  it('records an unavailableReason for files missing from the working tree', async () => {
    await useConfigDirectory();
    const repositoryPath = await createFakeRepository();
    const repositoryId = computeRepositoryId(repositoryPath);
    await writeCommentSessions(
      repositoryId,
      new Map([
        [
          'review:review-1',
          {
            threads: [
              createThread('t-gone', {
                filePath: 'src/deleted.ts',
                resolvedAt: '2026-09-25T10:00:00.000Z',
              }),
            ],
            version: 1,
          },
        ],
      ]),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createLessonsCommand().parseAsync(['backfill', '--repo', repositoryPath], {
      from: 'user',
    });

    const lessons = await readLessons(repositoryId);
    expect(lessons).toHaveLength(1);
    expect('unavailableReason' in lessons[0].codeAfter).toBe(true);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ repositoryId, added: 1, skipped: 0, failed: 0 }, null, 2),
    );
  });
});
