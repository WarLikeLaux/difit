import { resolve } from 'path';

import { Command } from 'commander';

import { readCommentSessions } from '../server/comment-storage.js';
import { buildLesson, findResolvedTransitions } from '../server/lesson-capture.js';
import { GitDiffParser } from '../server/git-diff.js';
import {
  computeRepositoryId,
  readLessons,
  readLessonsByRepositoryPath,
  upsertLessons,
} from '../server/lesson-storage.js';
import type { ReviewLesson } from '../types/lesson.js';
import { formatLessonsMarkdown, selectLessons } from '../utils/lesson-format.js';

interface LessonsCommandOptions {
  repo?: string;
  format?: string;
  file?: string;
  query?: string;
  limit?: string;
}

interface LessonsBackfillOptions {
  repo?: string;
}

function resolveRepositoryPath(repo?: string): string {
  return resolve(repo?.trim() || process.cwd());
}

function parseLessonLimit(limit?: string): number | undefined {
  if (limit === undefined) return undefined;
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--limit must be a positive integer');
  }
  return parsed;
}

export function createLessonsCommand(): Command {
  const command = new Command('lessons');
  command.description('Read or backfill the review lessons captured for a repository');
  // Keeps --repo bound to whichever subcommand appears in the argument list.
  command.enablePositionalOptions();

  command
    .option('--repo <path>', 'Repository path (defaults to the current directory)')
    .option('--format <format>', 'Output format: md or json', 'md')
    .option('--file <substring>', 'Only lessons whose file path contains this substring')
    .option('--query <substring>', 'Only lessons whose content contains this substring')
    .option('--limit <count>', 'Maximum number of lessons to print (newest first)')
    .action(async (options: LessonsCommandOptions) => {
      try {
        const repositoryPath = resolveRepositoryPath(options.repo);
        const lessons = await readLessonsByRepositoryPath(repositoryPath);
        const selected = selectLessons(lessons, {
          filePath: options.file,
          query: options.query,
          limit: parseLessonLimit(options.limit),
        });

        if (selected.length === 0) {
          console.log(`No lessons recorded yet for ${repositoryPath}`);
          return;
        }
        if (options.format === 'json') {
          console.log(
            JSON.stringify({ repositoryPath, count: selected.length, lessons: selected }, null, 2),
          );
          return;
        }
        console.log(formatLessonsMarkdown(selected));
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exitCode = 1;
      }
    });

  command
    .command('backfill')
    .description('Import already resolved and closed comment threads into the lessons store')
    .option('--repo <path>', 'Repository path (defaults to the current directory)')
    .action(async (options: LessonsBackfillOptions) => {
      try {
        const repositoryPath = resolveRepositoryPath(options.repo);
        const repositoryId = computeRepositoryId(repositoryPath);
        const sessions = await readCommentSessions(repositoryId);
        const knownThreadIds = new Set(
          (await readLessons(repositoryId)).map((lesson) => lesson.threadId),
        );

        const threads = Object.values(sessions).flatMap((session) => session.threads);
        const finished = findResolvedTransitions([], threads);
        const pending = finished.filter((transition) => !knownThreadIds.has(transition.thread.id));

        const parser = new GitDiffParser(repositoryPath);
        const lessons: ReviewLesson[] = [];
        let failed = 0;
        for (const transition of pending) {
          try {
            lessons.push(
              await buildLesson(transition, {
                actor: 'cli',
                readWorkingContent: (filePath) => parser.getBlobContent(filePath, 'working'),
              }),
            );
          } catch {
            failed += 1;
          }
        }

        await upsertLessons(repositoryId, lessons);
        console.log(
          JSON.stringify(
            {
              repositoryId,
              added: lessons.length,
              skipped: finished.length - pending.length,
              failed,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exitCode = 1;
      }
    });

  return command;
}
