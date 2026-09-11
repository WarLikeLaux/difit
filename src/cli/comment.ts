import { Command, Option } from 'commander';

import { parseCommentImportValue } from '../utils/commentImports.js';

import { detectStdinSource, readStdin } from './utils.js';

interface CommentImportResponse {
  success?: boolean;
  importId?: string;
  count?: number;
  warnings?: string[];
}

interface CommentThreadsResponse {
  version?: number;
  threads?: Array<{ resolvedAt?: string }>;
}

type CommentOutputFormat = 'text' | 'json';
type MutableCommentStatus = 'open' | 'accepted';

async function fetchCommentOutput(port: number, format: CommentOutputFormat): Promise<string> {
  const endpoint = format === 'json' ? '/api/comments-json' : '/api/comments-output';
  const response = await fetch(`http://localhost:${port}${endpoint}`);

  if (!response.ok) {
    throw new Error('Failed to retrieve comments');
  }

  if (format === 'text') {
    return (await response.text()).trim();
  }

  const data = (await response.json()) as CommentThreadsResponse;
  return JSON.stringify({
    ...data,
    threads: data.threads?.filter((thread) => !thread.resolvedAt) ?? [],
  });
}

interface WatchCommentOutputOptions {
  maxConnections?: number;
  reconnectDelayMs?: number;
}

export async function watchCommentOutput(
  port: number,
  format: CommentOutputFormat,
  options: WatchCommentOutputOptions = {},
): Promise<void> {
  const maxConnections = options.maxConnections ?? Number.POSITIVE_INFINITY;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  let previousOutput: string | undefined;
  let connectionCount = 0;

  while (connectionCount < maxConnections) {
    connectionCount += 1;

    try {
      if (previousOutput === undefined) {
        previousOutput = await fetchCommentOutput(port, format);
        if (previousOutput) console.log(previousOutput);
      }

      const response = await fetch(`http://localhost:${port}/api/watch`, {
        headers: { Accept: 'text/event-stream' },
      });
      if (!response.ok || !response.body) {
        throw new Error('Failed to watch comments');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

          if (data) {
            let event: { type?: string };
            try {
              event = JSON.parse(data) as { type?: string };
            } catch {
              separatorIndex = buffer.indexOf('\n\n');
              continue;
            }

            if (event.type === 'commentsChanged') {
              const nextOutput = await fetchCommentOutput(port, format);
              if (nextOutput !== previousOutput) {
                previousOutput = nextOutput;
                if (nextOutput) console.log(nextOutput);
              }
            }
          }

          separatorIndex = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // A watcher is expected to outlive transient server and network failures.
    }

    if (connectionCount < maxConnections) {
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
    }
  }
}

function handleCommandError(error: unknown, port: number): never {
  if (error instanceof TypeError && error.message.includes('fetch failed')) {
    console.error(`Error: Cannot connect to difit server on port ${port}. Is the server running?`);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  process.exit(1);
}

async function parseCommentAddInput(json?: string): Promise<string> {
  if (typeof json === 'string') {
    return json;
  }

  if (detectStdinSource() === 'tty') {
    throw new Error('Provide comment JSON as an argument or via stdin');
  }

  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error('No comment JSON received from stdin');
  }

  return stdin;
}

function addStatusCommand(
  comment: Command,
  name: string,
  status: MutableCommentStatus,
  description: string,
): void {
  comment
    .command(name)
    .description(description)
    .argument('<threadIds...>', 'thread IDs to update')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadIds: string[], opts: { port: number }) => {
      try {
        const results = await Promise.all(
          threadIds.map(async (threadId) => {
            const response = await fetch(
              `http://localhost:${opts.port}/api/comments/${encodeURIComponent(threadId)}/status`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
              },
            );

            return { threadId, ok: response.ok, notFound: response.status === 404 };
          }),
        );
        const updated = results.filter((result) => result.ok).map((result) => result.threadId);
        const notFound = results
          .filter((result) => result.notFound)
          .map((result) => result.threadId);
        const failed = results
          .filter((result) => !result.ok && !result.notFound)
          .map((result) => result.threadId);

        console.log(
          JSON.stringify({
            success: notFound.length === 0 && failed.length === 0,
            status,
            updated,
            notFound,
            failed,
          }),
        );
        if (notFound.length > 0 || failed.length > 0) process.exit(1);
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });
}

export function createCommentCommand(): Command {
  const comment = new Command('comment').description(
    'Add, retrieve, or resolve comments on a running difit server',
  );

  comment
    .command('add')
    .description('Add comments to a running difit server')
    .argument('[json]', 'comment import JSON (object or array)')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (json: string | undefined, opts: { port: number }) => {
      try {
        const input = await parseCommentAddInput(json);
        const imports = parseCommentImportValue(input);

        const response = await fetch(`http://localhost:${opts.port}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imports),
        });

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          console.error(`Error: ${errorBody.error ?? 'Failed to add comments'}`);
          process.exit(1);
        }

        const result = (await response.json()) as CommentImportResponse;
        console.log(
          JSON.stringify({
            success: result.success ?? true,
            importId: result.importId,
            count: result.count ?? imports.length,
            warnings: result.warnings ?? [],
          }),
        );
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('get')
    .description('Retrieve comments from a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { port: number; format: string }) => {
      try {
        const output = await fetchCommentOutput(opts.port, opts.format as CommentOutputFormat);
        if (output) {
          console.log(output);
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('watch')
    .description('Stream comment updates from a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('json'),
    )
    .action(async (opts: { port: number; format: string }) => {
      try {
        await watchCommentOutput(opts.port, opts.format as CommentOutputFormat);
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('resolve')
    .alias('remove')
    .description('Mark comment threads as resolved on a running difit server')
    .argument('<threadIds...>', 'thread IDs to resolve')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadIds: string[], opts: { port: number }) => {
      try {
        const results = await Promise.all(
          threadIds.map(
            async (
              threadId,
            ): Promise<{
              threadId: string;
              status: 'resolved' | 'notFound' | 'error';
              error?: string;
            }> => {
              const response = await fetch(
                `http://localhost:${opts.port}/api/comments/${encodeURIComponent(threadId)}`,
                { method: 'DELETE' },
              );

              if (response.ok) {
                return { threadId, status: 'resolved' };
              }

              if (response.status === 404) {
                return { threadId, status: 'notFound' };
              }

              const errorBody = (await response.json().catch(() => ({}))) as {
                error?: string;
              };
              return {
                threadId,
                status: 'error',
                error: errorBody.error ?? `Failed to resolve thread ${threadId}`,
              };
            },
          ),
        );

        const resolved = results.filter((r) => r.status === 'resolved').map((r) => r.threadId);
        const notFound = results.filter((r) => r.status === 'notFound').map((r) => r.threadId);
        const errors = results
          .filter((r) => r.status === 'error')
          .map((r) => ({
            threadId: r.threadId,
            error: r.error ?? `Failed to resolve thread ${r.threadId}`,
          }));

        console.log(
          JSON.stringify({
            success: notFound.length === 0 && errors.length === 0,
            resolved,
            notFound,
            errors,
          }),
        );
        if (notFound.length > 0 || errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  addStatusCommand(comment, 'accept', 'accepted', 'Mark comment threads as accepted');
  addStatusCommand(comment, 'reopen', 'open', 'Move comment threads back to open');

  return comment;
}
