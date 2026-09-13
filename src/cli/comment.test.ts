import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./auth-client.js', () => ({
  authenticatedFetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    init === undefined ? fetch(input) : fetch(input, init),
}));

import { createCommentCommand, watchCommentOutput } from './comment.js';

describe('createCommentCommand', () => {
  const command = createCommentCommand();

  it('creates a command named "comment"', () => {
    expect(command.name()).toBe('comment');
  });

  it('has comment read, write, and workflow subcommands', () => {
    const subcommandNames = command.commands.map((c) => c.name());
    expect(subcommandNames).toContain('add');
    expect(subcommandNames).toContain('reply');
    expect(subcommandNames).toContain('edit');
    expect(subcommandNames).toContain('get');
    expect(subcommandNames).toContain('events');
    expect(subcommandNames).toContain('ack');
    expect(subcommandNames).toContain('watch');
    expect(subcommandNames).toContain('resolve');
    expect(subcommandNames).toContain('verify');
    expect(subcommandNames).toContain('ready');
  });

  describe('add subcommand', () => {
    const addCommand = command.commands.find((c) => c.name() === 'add')!;

    it('requires --port option', () => {
      const portOption = addCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('accepts optional json argument', () => {
      const args = addCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('json');
      expect(args[0].required).toBe(false);
    });
  });

  describe('get subcommand', () => {
    const getCommand = command.commands.find((c) => c.name() === 'get')!;

    it('requires --port option', () => {
      const portOption = getCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('has --format option with choices', () => {
      const formatOption = getCommand.options.find((o) => o.long === '--format');
      expect(formatOption).toBeDefined();
      expect(formatOption?.defaultValue).toBe('text');
      expect(formatOption?.argChoices).toEqual(['text', 'json']);
    });
  });

  describe('resolve subcommand', () => {
    const resolveCommand = command.commands.find((c) => c.name() === 'resolve')!;

    it('has "remove" alias', () => {
      expect(resolveCommand.aliases()).toContain('remove');
    });

    it('requires --port option', () => {
      const portOption = resolveCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('accepts variadic threadIds argument', () => {
      const args = resolveCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('threadIds');
      expect(args[0].required).toBe(true);
      expect(args[0].variadic).toBe(true);
    });
  });

  describe('watch subcommand', () => {
    const watchCommand = command.commands.find((c) => c.name() === 'watch')!;

    it('requires --port and defaults to json output', () => {
      expect(watchCommand.options.find((o) => o.long === '--port')?.mandatory).toBe(true);
      expect(watchCommand.options.find((o) => o.long === '--format')?.defaultValue).toBe('json');
      expect(watchCommand.options.find((o) => o.long === '--cursor-file')).toBeDefined();
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

describe('comment subcommand integration', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    globalThis.fetch = mockFetch;

    originalProcessExit = process.exit;
    process.exit = vi.fn() as any;

    consoleOutput = [];
    consoleErrors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.join(' '));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalProcessExit;
    vi.restoreAllMocks();
  });

  describe('add', () => {
    it('sends comment imports to the server', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, importId: 'abc123', count: 1 }));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comment-imports',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(consoleOutput[0]).toContain('"success":true');
    });

    it('validates JSON before sending', async () => {
      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'add', '--port', '4966', 'not-valid-json']);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(consoleErrors[0]).toContain('Error:');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles server error response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Bad request' }, 400));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Bad request');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles connection error', async () => {
      const fetchError = new TypeError('fetch failed');
      mockFetch.mockRejectedValue(fetchError);

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '9999',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(consoleErrors[0]).toContain('9999');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('get', () => {
    it('fetches comments in text format by default', async () => {
      mockFetch.mockResolvedValue(textResponse('Comments output text'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-output');
      expect(consoleOutput[0]).toBe('Comments output text');
    });

    it('fetches comments in json format', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          threads: [{ id: 'open' }, { id: 'resolved', resolvedAt: '2026-09-11T00:00:00.000Z' }],
        }),
      );

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966', '--format', 'json']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-json');
      expect(JSON.parse(consoleOutput[0] ?? '{}')).toMatchObject({ threads: [{ id: 'open' }] });
    });

    it('handles connection error', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '9999']);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles empty text output silently', async () => {
      mockFetch.mockResolvedValue(textResponse('  '));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966']);

      expect(consoleOutput).toHaveLength(0);
    });
  });

  describe('agent events', () => {
    it('retrieves pending events', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ reviewId: 'review-1', ackedThrough: 0, throughSeq: 2, events: [] }),
      );

      await createCommentCommand().parseAsync(['node', 'difit', 'events', '--port', '4966']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/agent-events');
      expect(JSON.parse(consoleOutput[0] ?? '{}')).toMatchObject({
        reviewId: 'review-1',
        throughSeq: 2,
      });
    });

    it('acknowledges a handled event sequence', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ success: true, ackedThrough: 2, pendingCount: 0 }),
      );

      await createCommentCommand().parseAsync(['node', 'difit', 'ack', '2', '--port', '4966']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/agent-events/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ throughSeq: 2 }),
      });
      expect(JSON.parse(consoleOutput[0] ?? '{}')).toMatchObject({
        success: true,
        ackedThrough: 2,
      });
    });
  });

  describe('reply and edit', () => {
    it('replies with the exact body and prints the created message ID', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          success: true,
          threadId: 'thread/1',
          message: { id: 'message-2', body: 'Use `$crm` and ```php\ncode\n```' },
          version: 3,
        }),
      );

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'reply',
        '--port',
        '4966',
        'thread/1',
        'Use `$crm` and ```php\ncode\n```',
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comments/thread%2F1/messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'Use `$crm` and ```php\ncode\n```' }),
        },
      );
      expect(JSON.parse(consoleOutput[0] ?? '{}').message.id).toBe('message-2');
    });

    it('edits a message with the exact replacement body', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          success: true,
          threadId: 'thread-1',
          message: { id: 'message/2', body: "return $crm->save(true, ['active']);" },
          version: 4,
        }),
      );

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'edit',
        '--port',
        '4966',
        'thread-1',
        'message/2',
        "return $crm->save(true, ['active']);",
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comments/thread-1/messages/message%2F2',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: "return $crm->save(true, ['active']);" }),
        },
      );
      expect(JSON.parse(consoleOutput[0] ?? '{}').message.body).toBe(
        "return $crm->save(true, ['active']);",
      );
    });
  });

  describe('watch', () => {
    it('prints snapshots and reconnects after stream and network failures', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"connected"}\n\ndata: {"type":"commentsChanged","version":2}\n\n',
            ),
          );
          controller.close();
        },
      });
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ version: 1, threads: [] }))
        .mockResolvedValueOnce(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            version: 2,
            threads: [{ id: 'agent-thread' }],
          }),
        )
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          new Response(new ReadableStream({ start: (controller) => controller.close() }), {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );

      await watchCommentOutput(4966, 'json', { maxConnections: 3, reconnectDelayMs: 0 });

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:4966/api/comments-json');
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:4966/api/watch', {
        headers: { Accept: 'text/event-stream' },
      });
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:4966/api/comments-json');
      expect(mockFetch).toHaveBeenNthCalledWith(4, 'http://localhost:4966/api/watch', {
        headers: { Accept: 'text/event-stream' },
      });
      expect(mockFetch).toHaveBeenNthCalledWith(5, 'http://localhost:4966/api/watch', {
        headers: { Accept: 'text/event-stream' },
      });
      expect(consoleOutput.map((output) => JSON.parse(output))).toEqual([
        { version: 1, threads: [] },
        { version: 2, threads: [{ id: 'agent-thread' }] },
      ]);
    });

    it('streams each new User message and To verify transition once and persists its cursor', async () => {
      const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'difit-watch-'));
      const cursorFile = join(temporaryDirectory, 'mr-57.cursor');
      const existingMessage = {
        id: 'message-1',
        body: 'Existing question',
        author: 'User',
        createdAt: '2026-09-11T10:00:00.000Z',
        updatedAt: '2026-09-11T10:00:00.000Z',
      };
      const newMessage = {
        id: 'message-2',
        body: 'New question',
        author: 'User',
        createdAt: '2026-09-11T11:00:00.000Z',
        updatedAt: '2026-09-11T11:00:00.000Z',
      };
      const thread = {
        id: 'thread-1',
        filePath: 'src/app.ts',
        position: { side: 'new', line: 12 },
      };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"commentsChanged","version":2}\n\ndata: {"type":"commentsChanged","version":3}\n\n',
            ),
          );
          controller.close();
        },
      });

      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({ version: 1, threads: [{ ...thread, messages: [existingMessage] }] }),
        )
        .mockResolvedValueOnce(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            version: 2,
            threads: [
              {
                ...thread,
                toVerifyAt: '2026-09-11T11:05:00.000Z',
                messages: [existingMessage, newMessage],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            version: 3,
            threads: [
              {
                ...thread,
                toVerifyAt: '2026-09-11T11:05:00.000Z',
                messages: [existingMessage, newMessage],
              },
            ],
          }),
        );

      await watchCommentOutput(4966, 'json', {
        cursorFile,
        maxConnections: 1,
        reconnectDelayMs: 0,
      });

      expect(consoleOutput.map((output) => JSON.parse(output))).toEqual([
        {
          threadId: 'thread-1',
          filePath: 'src/app.ts',
          position: { side: 'new', line: 12 },
          id: newMessage.id,
          body: newMessage.body,
          createdAt: newMessage.createdAt,
          updatedAt: newMessage.updatedAt,
        },
        {
          event: 'toVerify',
          threadId: 'thread-1',
          filePath: 'src/app.ts',
          position: { side: 'new', line: 12 },
          toVerifyAt: '2026-09-11T11:05:00.000Z',
          messages: [existingMessage, newMessage],
        },
      ]);
      const cursor = JSON.parse(await fs.readFile(cursorFile, 'utf8')) as {
        messages: Record<string, string>;
        toVerifyThreads: Record<string, string>;
      };
      expect(cursor.messages).toEqual({
        '["thread-1","message-1"]': existingMessage.updatedAt,
        '["thread-1","message-2"]': newMessage.updatedAt,
      });
      expect(cursor.toVerifyThreads).toEqual({
        'thread-1': '2026-09-11T11:05:00.000Z',
      });

      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    it('delivers messages created while a cursor-backed watcher was stopped', async () => {
      const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'difit-watch-resume-'));
      const cursorFile = join(temporaryDirectory, 'review.cursor');
      await fs.writeFile(
        cursorFile,
        JSON.stringify({
          version: 1,
          messages: { '["thread-1","message-1"]': '2026-09-11T10:00:00.000Z' },
          toVerifyThreads: {},
        }),
      );
      const messages = [
        {
          id: 'message-1',
          body: 'Before pause',
          author: 'User',
          createdAt: '2026-09-11T10:00:00.000Z',
          updatedAt: '2026-09-11T10:00:00.000Z',
        },
        {
          id: 'message-2',
          body: 'During pause',
          author: 'User',
          createdAt: '2026-09-11T12:00:00.000Z',
          updatedAt: '2026-09-11T12:00:00.000Z',
        },
      ];
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({
            version: 2,
            threads: [
              {
                id: 'thread-1',
                filePath: 'src/app.ts',
                position: { side: 'new', line: 12 },
                messages,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(new ReadableStream({ start: (controller) => controller.close() }), {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );

      await watchCommentOutput(4966, 'json', {
        cursorFile,
        maxConnections: 1,
        reconnectDelayMs: 0,
      });

      expect(consoleOutput).toHaveLength(1);
      expect(JSON.parse(consoleOutput[0] ?? '{}')).toMatchObject({
        id: 'message-2',
        body: 'During pause',
      });

      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });
  });

  describe('resolve', () => {
    it('sends DELETE requests for each thread ID', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, threadId: 'abc123', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments/abc123', {
        method: 'DELETE',
      });
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments/def456', {
        method: 'DELETE',
      });
      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: true,
          resolved: ['abc123', 'def456'],
          notFound: [],
          errors: [],
        }),
      );
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('works via the remove alias', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, threadId: 'abc123', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'remove', '--port', '4966', 'abc123']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments/abc123', {
        method: 'DELETE',
      });
      expect(consoleOutput[0]).toContain('"success":true');
    });

    it('URL-encodes thread IDs', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'a/b c']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments/a%2Fb%20c', {
        method: 'DELETE',
      });
    });

    it('reports unknown thread IDs and exits with an error', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, threadId: 'abc123', version: 2 }))
        .mockResolvedValueOnce(jsonResponse({ error: 'Thread not found: missing' }, 404));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'missing']);

      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: ['abc123'],
          notFound: ['missing'],
          errors: [],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('collects server errors without dropping remaining thread IDs', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: 'Internal error' }, 500))
        .mockResolvedValueOnce(jsonResponse({ success: true, threadId: 'def456', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: ['def456'],
          notFound: [],
          errors: [{ threadId: 'abc123', error: 'Internal error' }],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles connection error', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '9999', 'abc123']);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(consoleErrors[0]).toContain('9999');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('ready', () => {
    it('marks verified threads as ready without resolving them', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, status: 'ready' }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'ready', '--port', '4966', 'thread-1']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments/thread-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
      });
      expect(JSON.parse(consoleOutput[0] ?? '{}')).toMatchObject({
        success: true,
        status: 'ready',
        updated: ['thread-1'],
      });
    });

    it('marks fixed threads as waiting for verification', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, status: 'to_verify' }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'verify', '--port', '4966', 'thread-1']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments/thread-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'to_verify' }),
      });
    });
  });
});
