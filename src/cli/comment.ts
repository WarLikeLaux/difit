import { Command, Option } from 'commander';
import { promises as fs } from 'fs';
import { dirname } from 'path';

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
  threads?: Array<{
    id: string;
    filePath: string;
    position: unknown;
    toVerifyAt?: string;
    readyAt?: string;
    resolvedAt?: string;
    messages: Array<{
      id: string;
      body: string;
      author?: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
}

type CommentOutputFormat = 'text' | 'json';
type MutableCommentStatus = 'open' | 'accepted' | 'to_verify' | 'ready';

interface CommentWatchCursor {
  version: 1;
  messages: Record<string, string>;
  toVerifyThreads: Record<string, string>;
}

interface UserCommentEvent {
  threadId: string;
  filePath: string;
  position: unknown;
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface ToVerifyEvent {
  event: 'toVerify';
  threadId: string;
  filePath: string;
  position: unknown;
  toVerifyAt: string;
  messages: NonNullable<CommentThreadsResponse['threads']>[number]['messages'];
}

function getCursorMessageKey(event: Pick<UserCommentEvent, 'threadId' | 'id'>): string {
  return JSON.stringify([event.threadId, event.id]);
}

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
  cursorFile?: string;
}

async function fetchCommentThreads(port: number): Promise<CommentThreadsResponse> {
  const response = await fetch(`http://localhost:${port}/api/comments-json`);
  if (!response.ok) throw new Error('Failed to retrieve comments');
  return (await response.json()) as CommentThreadsResponse;
}

function getUserCommentEvents(data: CommentThreadsResponse): UserCommentEvent[] {
  return (data.threads ?? [])
    .flatMap((thread) =>
      thread.messages
        .filter((message) => message.author?.trim() === 'User')
        .map((message) => ({
          threadId: thread.id,
          filePath: thread.filePath,
          position: thread.position,
          id: message.id,
          body: message.body,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })),
    )
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    );
}

async function readWatchCursor(path: string): Promise<CommentWatchCursor | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<CommentWatchCursor>;
    if (parsed.version !== 1 || !parsed.messages || typeof parsed.messages !== 'object') {
      throw new Error(`Invalid comment watch cursor: ${path}`);
    }
    return {
      version: 1,
      messages: parsed.messages,
      toVerifyThreads:
        parsed.toVerifyThreads && typeof parsed.toVerifyThreads === 'object'
          ? parsed.toVerifyThreads
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeWatchCursor(path: string, cursor: CommentWatchCursor): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, path);
}

async function emitUnseenCommentEvents(
  port: number,
  cursorFile: string,
  cursor: CommentWatchCursor | undefined,
): Promise<CommentWatchCursor> {
  const data = await fetchCommentThreads(port);
  const events = getUserCommentEvents(data);
  const toVerifyEvents: ToVerifyEvent[] = (data.threads ?? [])
    .filter((thread): thread is typeof thread & { toVerifyAt: string } =>
      Boolean(thread.toVerifyAt),
    )
    .map((thread) => ({
      event: 'toVerify',
      threadId: thread.id,
      filePath: thread.filePath,
      position: thread.position,
      toVerifyAt: thread.toVerifyAt,
      messages: thread.messages,
    }));
  const nextCursor: CommentWatchCursor = cursor ?? {
    version: 1,
    messages: {},
    toVerifyThreads: {},
  };

  if (!cursor) {
    for (const event of events) nextCursor.messages[getCursorMessageKey(event)] = event.updatedAt;
    for (const event of toVerifyEvents)
      nextCursor.toVerifyThreads[event.threadId] = event.toVerifyAt;
    await writeWatchCursor(cursorFile, nextCursor);
    return nextCursor;
  }

  for (const event of events) {
    const key = getCursorMessageKey(event);
    if (nextCursor.messages[key] === event.updatedAt) continue;
    console.log(JSON.stringify(event));
    nextCursor.messages[key] = event.updatedAt;
    await writeWatchCursor(cursorFile, nextCursor);
  }

  for (const event of toVerifyEvents) {
    if (nextCursor.toVerifyThreads[event.threadId] === event.toVerifyAt) continue;
    console.log(JSON.stringify(event));
    nextCursor.toVerifyThreads[event.threadId] = event.toVerifyAt;
    await writeWatchCursor(cursorFile, nextCursor);
  }

  return nextCursor;
}

export async function watchCommentOutput(
  port: number,
  format: CommentOutputFormat,
  options: WatchCommentOutputOptions = {},
): Promise<void> {
  const maxConnections = options.maxConnections ?? Number.POSITIVE_INFINITY;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  let previousOutput: string | undefined;
  let cursor = options.cursorFile ? await readWatchCursor(options.cursorFile) : undefined;
  let connectionCount = 0;

  while (connectionCount < maxConnections) {
    connectionCount += 1;

    try {
      if (options.cursorFile) {
        cursor = await emitUnseenCommentEvents(port, options.cursorFile, cursor);
      } else if (previousOutput === undefined) {
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
              if (options.cursorFile) {
                cursor = await emitUnseenCommentEvents(port, options.cursorFile, cursor);
              } else {
                const nextOutput = await fetchCommentOutput(port, format);
                if (nextOutput !== previousOutput) {
                  previousOutput = nextOutput;
                  if (nextOutput) console.log(nextOutput);
                }
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

async function parseCommentBodyInput(body?: string): Promise<string> {
  if (typeof body === 'string') {
    if (!body.trim()) throw new Error('Comment body must not be empty');
    return body;
  }
  if (detectStdinSource() === 'tty') {
    throw new Error('Provide comment body as an argument or via stdin');
  }
  const input = await readStdin();
  if (!input.trim()) {
    throw new Error('Comment body must not be empty');
  }

  return input;
}

async function updateThreadMessage(
  port: number,
  method: 'POST' | 'PATCH',
  path: string,
  body: string,
): Promise<void> {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? 'Failed to update comment');
  }

  console.log(JSON.stringify(result));
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
    .command('reply')
    .description('Reply to an existing comment thread')
    .argument('<threadId>', 'thread ID to reply to')
    .argument('[body]', 'reply body; reads stdin when omitted')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadId: string, body: string | undefined, opts: { port: number }) => {
      try {
        const input = await parseCommentBodyInput(body);
        await updateThreadMessage(
          opts.port,
          'POST',
          `/api/comments/${encodeURIComponent(threadId)}/messages`,
          input,
        );
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('edit')
    .description('Edit an existing comment message')
    .argument('<threadId>', 'thread ID containing the message')
    .argument('<messageId>', 'message ID to edit')
    .argument('[body]', 'replacement body; reads stdin when omitted')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(
      async (
        threadId: string,
        messageId: string,
        body: string | undefined,
        opts: { port: number },
      ) => {
        try {
          const input = await parseCommentBodyInput(body);
          await updateThreadMessage(
            opts.port,
            'PATCH',
            `/api/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
            input,
          );
        } catch (error) {
          handleCommandError(error, opts.port);
        }
      },
    );

  comment
    .command('watch')
    .description('Stream comment updates from a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('json'),
    )
    .option(
      '--cursor-file <path>',
      'persist delivery state and stream User messages and To verify transitions once as JSON',
    )
    .action(async (opts: { port: number; format: string; cursorFile?: string }) => {
      try {
        await watchCommentOutput(opts.port, opts.format as CommentOutputFormat, {
          cursorFile: opts.cursorFile,
        });
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
  addStatusCommand(
    comment,
    'verify',
    'to_verify',
    'Mark comment threads as ready for verification',
  );
  addStatusCommand(comment, 'ready', 'ready', 'Mark comment threads as verified and ready');
  addStatusCommand(comment, 'reopen', 'open', 'Move comment threads back to open');

  return comment;
}
