import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DiffCommentThread } from '../types/diff.js';

import {
  buildLesson,
  captureResolvedLessons,
  extractCodeWindow,
  findResolvedTransitions,
} from './lesson-capture.js';
import { computeRepositoryId, readLessons } from './lesson-storage.js';

function createThread(id: string, overrides: Partial<DiffCommentThread> = {}): DiffCommentThread {
  return {
    id,
    filePath: 'src/a.ts',
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T09:30:00.000Z',
    position: { side: 'new', line: 10 },
    messages: [],
    ...overrides,
  };
}

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
  const directory = await fs.mkdtemp(join(tmpdir(), 'difit-lessons-capture-'));
  configDirectories.push(directory);
  process.env.DIFIT_CONFIG_DIR = directory;
  return directory;
}

describe('findResolvedTransitions', () => {
  it('captures open threads becoming resolved or closed', () => {
    const previous = [createThread('t1'), createThread('t2')];
    const next = [
      { ...previous[0], resolvedAt: '2026-09-25T10:00:00.000Z' },
      { ...previous[1], closedAt: '2026-09-25T10:00:00.000Z' },
    ];

    const transitions = findResolvedTransitions(previous, next);

    expect(transitions.map((transition) => [transition.thread.id, transition.outcome])).toEqual([
      ['t1', 'resolved'],
      ['t2', 'closed'],
    ]);
  });

  it('ignores threads that were already finished and threads that stay unfinished', () => {
    const previous = [
      createThread('done', { resolvedAt: '2026-09-25T09:00:00.000Z' }),
      createThread('working', { acceptedAt: '2026-09-25T09:00:00.000Z' }),
    ];
    const next = [
      { ...previous[0], resolvedAt: '2026-09-25T10:00:00.000Z' },
      { ...previous[1], acceptedAt: '2026-09-25T10:00:00.000Z' },
    ];

    expect(findResolvedTransitions(previous, next)).toEqual([]);
  });

  it('recaptures a reopened thread when it finishes again', () => {
    const resolved = createThread('t1', { resolvedAt: '2026-09-25T09:00:00.000Z' });
    const reopened = createThread('t1');
    const resolvedAgain = createThread('t1', { resolvedAt: '2026-09-25T11:00:00.000Z' });

    expect(findResolvedTransitions([resolved], [reopened])).toEqual([]);

    const transitions = findResolvedTransitions([reopened], [resolvedAgain]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].finishedAt).toBe('2026-09-25T11:00:00.000Z');
  });

  it('captures a thread closed straight from accepted', () => {
    const accepted = createThread('t1', { acceptedAt: '2026-09-25T09:00:00.000Z' });
    const closed = createThread('t1', { closedAt: '2026-09-25T12:00:00.000Z' });

    const transitions = findResolvedTransitions([accepted], [closed]);

    expect(transitions.map((transition) => transition.outcome)).toEqual(['closed']);
  });
});

describe('extractCodeWindow', () => {
  const content = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n');

  it('returns context lines around a single line', () => {
    const lines = extractCodeWindow(content, 25).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe('line 15');
    expect(lines.at(-1)).toBe('line 35');
  });

  it('clamps to the file boundaries', () => {
    const head = extractCodeWindow(content, 2).split('\n');
    expect(head[0]).toBe('line 1');
    const tail = extractCodeWindow(content, 49).split('\n');
    expect(tail.at(-1)).toBe('line 50');
  });

  it('honours a line range', () => {
    const lines = extractCodeWindow(content, { start: 25, end: 28 }).split('\n');
    expect(lines).toHaveLength(24);
    expect(lines[0]).toBe('line 15');
    expect(lines.at(-1)).toBe('line 38');
  });
});

describe('buildLesson', () => {
  const transition = {
    thread: createThread('t1', {
      resolvedAt: '2026-09-25T10:00:00.000Z',
      codeSnapshot: { content: 'old code', language: 'ts' },
      messages: [
        {
          id: 'm1',
          body: 'Fix this',
          author: 'User',
          createdAt: '2026-09-25T09:10:00.000Z',
          updatedAt: '2026-09-25T09:10:00.000Z',
        },
      ],
    }),
    outcome: 'resolved' as const,
    finishedAt: '2026-09-25T10:00:00.000Z',
  };

  it('builds a lesson with the before snapshot, messages, and an after window', async () => {
    const lesson = await buildLesson(transition, {
      reviewId: 'review-1',
      branch: 'custom',
      actor: 'browser',
      readWorkingContent: async () => 'line 1\nfixed code\nline 3',
    });

    expect(lesson).toMatchObject({
      threadId: 't1',
      reviewId: 'review-1',
      branch: 'custom',
      outcome: 'resolved',
      resolvedBy: 'browser',
      capturedAt: '2026-09-25T10:00:00.000Z',
      codeBefore: { content: 'old code', language: 'ts' },
      codeAfter: { content: 'line 1\nfixed code\nline 3' },
    });
    expect(lesson.messages).toEqual([
      { author: 'User', body: 'Fix this', createdAt: '2026-09-25T09:10:00.000Z' },
    ]);
  });

  it('records an unavailableReason when the working tree cannot be read', async () => {
    const lesson = await buildLesson(transition, {
      actor: 'hub',
      readWorkingContent: async () => {
        throw new Error('File path outside repository');
      },
    });

    expect(lesson.codeAfter).toEqual({ unavailableReason: 'File path outside repository' });
  });

  it('decodes Buffer results from the reader', async () => {
    const lesson = await buildLesson(transition, {
      actor: 'cli',
      readWorkingContent: async () => Buffer.from('buffered code', 'utf-8'),
    });

    expect(lesson.codeAfter).toEqual({ content: 'buffered code' });
  });
});

describe('captureResolvedLessons', () => {
  it('persists lessons for finished transitions into the repository store', async () => {
    await useConfigDirectory();

    await captureResolvedLessons({
      previousThreads: [createThread('t1')],
      nextThreads: [createThread('t1', { resolvedAt: '2026-09-25T10:00:00.000Z' })],
      repositoryPath: '/some/repo',
      reviewId: 'review-1',
      branch: 'custom',
      resolvedBy: 'browser',
      readWorkingContent: async () => 'after code',
    });

    const lessons = await readLessons(computeRepositoryId('/some/repo'));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      threadId: 't1',
      reviewId: 'review-1',
      branch: 'custom',
      resolvedBy: 'browser',
      codeAfter: { content: 'after code' },
    });
  });

  it('skips writes without an actor and never throws on reader failures', async () => {
    await useConfigDirectory();
    const next = [createThread('t1', { resolvedAt: '2026-09-25T10:00:00.000Z' })];

    await captureResolvedLessons({
      previousThreads: [],
      nextThreads: next,
      repositoryPath: '/some/repo',
      readWorkingContent: async () => 'x',
    });
    expect(await readLessons(computeRepositoryId('/some/repo'))).toEqual([]);

    await captureResolvedLessons({
      previousThreads: [],
      nextThreads: next,
      repositoryPath: '/some/repo',
      resolvedBy: 'browser',
      readWorkingContent: async () => {
        throw new Error('boom');
      },
    });
    const lessons = await readLessons(computeRepositoryId('/some/repo'));
    expect(lessons).toHaveLength(1);
    expect(lessons[0].codeAfter).toEqual({ unavailableReason: 'boom' });
  });
});
