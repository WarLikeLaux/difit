import type { DiffLineRange } from '../types/diff.js';
import type { ReviewLesson } from '../types/lesson.js';

export interface LessonSelectionOptions {
  filePath?: string;
  query?: string;
  limit?: number;
}

/** Filters by file-path substring and full-text query, newest first, bounded by limit. */
export function selectLessons(
  lessons: readonly ReviewLesson[],
  options: LessonSelectionOptions,
): ReviewLesson[] {
  const query = options.query?.trim().toLowerCase();
  const filePath = options.filePath?.trim().toLowerCase();
  const selected = lessons
    .filter((lesson) => !filePath || lesson.filePath.toLowerCase().includes(filePath))
    .filter((lesson) => {
      if (!query) return true;
      const haystack = [
        lesson.filePath,
        ...lesson.messages.map((message) => `${message.author ?? ''} ${message.body}`),
        lesson.codeBefore?.content ?? '',
        'content' in lesson.codeAfter
          ? lesson.codeAfter.content
          : lesson.codeAfter.unavailableReason,
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  return typeof options.limit === 'number' ? selected.slice(0, options.limit) : selected;
}

function formatLineRange(line: DiffLineRange): string {
  if (typeof line === 'number') return `L${line}`;
  return `L${line.start}-L${line.end}`;
}

function codeFence(language: string | undefined, content: string): string {
  // Four backticks so code containing ordinary triple-backtick fences survives.
  return `\`\`\`\`${language ?? ''}\n${content}\n\`\`\`\``;
}

export function renderLessonMarkdown(lesson: ReviewLesson): string {
  const parts: string[] = [];
  parts.push(`## Lesson: ${lesson.filePath}:${formatLineRange(lesson.position.line)}`);

  const meta = [
    lesson.branch,
    lesson.capturedAt,
    `outcome: ${lesson.outcome}`,
    `resolved by: ${lesson.resolvedBy}`,
  ]
    .filter(Boolean)
    .join(' · ');
  parts.push(meta);

  parts.push('### Code before');
  parts.push(
    lesson.codeBefore
      ? codeFence(lesson.codeBefore.language, lesson.codeBefore.content)
      : 'No code snapshot was captured with this thread.',
  );

  parts.push('### Feedback');
  if (lesson.messages.length === 0) {
    parts.push('No messages.');
  } else {
    for (const message of lesson.messages) {
      parts.push(`**${message.author || 'User'}** (${message.createdAt}):`);
      parts.push(message.body);
    }
  }

  parts.push('### Code after');
  parts.push(
    'content' in lesson.codeAfter
      ? codeFence(lesson.codeBefore?.language, lesson.codeAfter.content)
      : `Code after was not captured: ${lesson.codeAfter.unavailableReason}`,
  );

  return parts.join('\n\n');
}

export function formatLessonsMarkdown(lessons: readonly ReviewLesson[]): string {
  if (lessons.length === 0) return 'No lessons recorded yet.';
  return lessons.map(renderLessonMarkdown).join('\n\n---\n\n');
}
