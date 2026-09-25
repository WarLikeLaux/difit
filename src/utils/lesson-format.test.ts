import { describe, expect, it } from 'vitest';

import type { ReviewLesson } from '../types/lesson.js';

import { formatLessonsMarkdown, renderLessonMarkdown, selectLessons } from './lesson-format.js';

function createLesson(overrides: Partial<ReviewLesson> = {}): ReviewLesson {
  return {
    threadId: 't1',
    outcome: 'resolved',
    resolvedBy: 'browser',
    capturedAt: '2026-09-25T10:00:00.000Z',
    filePath: 'src/a.ts',
    position: { side: 'new', line: 10 },
    codeBefore: { content: 'before code', language: 'ts' },
    codeAfter: { content: 'after code' },
    messages: [{ author: 'User', body: 'Fix this', createdAt: '2026-09-25T09:00:00.000Z' }],
    ...overrides,
  };
}

describe('renderLessonMarkdown', () => {
  it('renders the before, feedback, and after sections', () => {
    const lesson = createLesson({
      branch: 'custom',
      messages: [
        { author: 'User', body: 'Guard the empty case', createdAt: '2026-09-25T09:10:00.000Z' },
        { author: 'Agent', body: 'Fixed', createdAt: '2026-09-25T09:40:00.000Z' },
      ],
    });

    const markdown = renderLessonMarkdown(lesson);

    expect(markdown).toContain('## Lesson: src/a.ts:L10');
    expect(markdown).toContain(
      'custom · 2026-09-25T10:00:00.000Z · outcome: resolved · resolved by: browser',
    );
    expect(markdown).toContain('### Code before');
    expect(markdown).toContain('before code');
    expect(markdown).toContain('**User** (2026-09-25T09:10:00.000Z):');
    expect(markdown).toContain('Guard the empty case');
    expect(markdown).toContain('**Agent** (2026-09-25T09:40:00.000Z):');
    expect(markdown).toContain('### Code after');
    expect(markdown).toContain('after code');
  });

  it('renders line ranges, missing snapshots, and unavailable code after', () => {
    const lesson = createLesson({
      position: { side: 'old', line: { start: 5, end: 8 } },
      codeBefore: undefined,
      codeAfter: { unavailableReason: 'File deleted' },
      messages: [],
    });

    const markdown = renderLessonMarkdown(lesson);

    expect(markdown).toContain('src/a.ts:L5-L8');
    expect(markdown).toContain('No code snapshot was captured with this thread.');
    expect(markdown).toContain('No messages.');
    expect(markdown).toContain('Code after was not captured: File deleted');
  });

  it('falls back to User for messages without an author', () => {
    const lesson = createLesson({
      messages: [{ body: 'Looks wrong', createdAt: '2026-09-25T09:00:00.000Z' }],
    });

    expect(renderLessonMarkdown(lesson)).toContain('**User** (2026-09-25T09:00:00.000Z):');
  });
});

describe('selectLessons', () => {
  const older = createLesson({
    threadId: 'old',
    capturedAt: '2026-09-20T10:00:00.000Z',
    filePath: 'src/old.ts',
  });
  const newer = createLesson({
    threadId: 'new',
    messages: [
      { author: 'User', body: 'cache invalidation', createdAt: '2026-09-25T09:00:00.000Z' },
    ],
  });

  it('sorts newest first', () => {
    expect(selectLessons([older, newer], {}).map((lesson) => lesson.threadId)).toEqual([
      'new',
      'old',
    ]);
  });

  it('filters by file path substring', () => {
    expect(
      selectLessons([older, newer], { filePath: 'old' }).map((lesson) => lesson.threadId),
    ).toEqual(['old']);
  });

  it('filters by a case-insensitive content query', () => {
    expect(
      selectLessons([older, newer], { query: 'CACHE INVALIDATION' }).map(
        (lesson) => lesson.threadId,
      ),
    ).toEqual(['new']);
  });

  it('applies the limit after sorting', () => {
    expect(selectLessons([older, newer], { limit: 1 }).map((lesson) => lesson.threadId)).toEqual([
      'new',
    ]);
  });
});

describe('formatLessonsMarkdown', () => {
  it('reports the empty case', () => {
    expect(formatLessonsMarkdown([])).toBe('No lessons recorded yet.');
  });

  it('joins lessons with separators', () => {
    const markdown = formatLessonsMarkdown([createLesson(), createLesson({ threadId: 't2' })]);
    expect(markdown.split('\n\n---\n\n')).toHaveLength(2);
  });
});
