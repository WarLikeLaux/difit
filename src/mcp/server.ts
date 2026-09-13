import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import pkg from '../../package.json' with { type: 'json' };
import { readReviewRegistrations } from '../server/review-registry.js';

import { DifitReviewApi } from './review-api.js';
import { startReview, type StartReviewOptions } from './start-review.js';

interface DifitMcpDependencies {
  api?: DifitReviewApi;
  listReviews?: typeof readReviewRegistrations;
  startReview?: (options: StartReviewOptions) => Promise<unknown>;
}

const portSchema = z.number().int().min(1).max(65_535).describe('Port of the running difit viewer');
const threadIdSchema = z.string().min(1).describe('Difit thread ID');
const bodySchema = z.string().trim().min(1).describe('Markdown comment body');
const lineSchema = z.union([
  z.number().int().positive(),
  z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
]);

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toolSuccess(value: unknown): CallToolResult {
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : 'Unknown difit error',
      },
    ],
    isError: true,
  };
}

async function runTool(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return toolSuccess(await operation());
  } catch (error) {
    return toolError(error);
  }
}

export function createDifitMcpServer(dependencies: DifitMcpDependencies = {}): McpServer {
  const api = dependencies.api ?? new DifitReviewApi();
  const listReviews = dependencies.listReviews ?? readReviewRegistrations;
  const launchReview = dependencies.startReview ?? startReview;
  const server = new McpServer({ name: 'difit', version: pkg.version });

  server.registerTool(
    'start_review',
    {
      title: 'Start difit review',
      description:
        'Start a detached difit viewer for a Git repository and return its actual port and URL.',
      inputSchema: z.object({
        repositoryPath: z.string().min(1).describe('Absolute path to the Git repository'),
        target: z.string().min(1).default('.').describe('Commit, branch, or live target'),
        base: z.string().min(1).optional().describe('Optional comparison base'),
        includeUntracked: z.boolean().default(true),
        mergeBase: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => runTool(() => launchReview(input)),
  );

  server.registerTool(
    'list_reviews',
    {
      title: 'List difit reviews',
      description: 'List registered local difit reviews and whether their viewer process is alive.',
      inputSchema: z.object({
        repositoryPath: z.string().min(1).optional().describe('Filter by repository path'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ repositoryPath }) =>
      runTool(async () => {
        const reviews = (await listReviews())
          .filter((review) => !repositoryPath || review.repositoryPath === repositoryPath)
          .map((review) => ({ ...review, running: processIsRunning(review.pid) }));
        return { reviews };
      }),
  );

  server.registerTool(
    'get_review_context',
    {
      title: 'Get review context',
      description: 'Read identity and Git context from a running difit viewer.',
      inputSchema: z.object({ port: portSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ port }) => runTool(() => api.getContext(port)),
  );

  server.registerTool(
    'get_comments',
    {
      title: 'Get review comments',
      description: 'Read comment threads from a running difit viewer.',
      inputSchema: z.object({
        port: portSchema,
        includeResolved: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ port, includeResolved }) => runTool(() => api.getComments(port, includeResolved)),
  );

  server.registerTool(
    'get_events',
    {
      title: 'Get pending agent events',
      description:
        'Read the durable batch of user feedback that woke the agent. Process all events before acknowledging throughSeq.',
      inputSchema: z.object({ port: portSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ port }) => runTool(() => api.getEvents(port)),
  );

  server.registerTool(
    'ack_events',
    {
      title: 'Acknowledge agent events',
      description:
        'Acknowledge a fully handled event batch through its exact throughSeq. Never call before all events are handled.',
      inputSchema: z.object({
        port: portSchema,
        throughSeq: z.number().int().nonnegative(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ port, throughSeq }) => runTool(() => api.acknowledgeEvents(port, throughSeq)),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add review comment',
      description: 'Create an Agent-authored inline review thread.',
      inputSchema: z.object({
        port: portSchema,
        filePath: z.string().min(1),
        side: z.enum(['old', 'new']),
        line: lineSchema,
        body: bodySchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ port, filePath, side, line, body }) =>
      runTool(() => api.addComment(port, { filePath, position: { side, line }, body })),
  );

  server.registerTool(
    'reply',
    {
      title: 'Reply to review thread',
      description: 'Add an Agent-authored reply to an existing difit thread.',
      inputSchema: z.object({ port: portSchema, threadId: threadIdSchema, body: bodySchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ port, threadId, body }) => runTool(() => api.reply(port, threadId, body)),
  );

  server.registerTool(
    'edit_message',
    {
      title: 'Edit review message',
      description: 'Replace the body of an existing difit message.',
      inputSchema: z.object({
        port: portSchema,
        threadId: threadIdSchema,
        messageId: z.string().min(1),
        body: bodySchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ port, threadId, messageId, body }) =>
      runTool(() => api.editMessage(port, threadId, messageId, body)),
  );

  server.registerTool(
    'set_thread_status',
    {
      title: 'Set review thread status',
      description:
        'Move a difit thread between open, accepted, to_verify, and ready. Final resolution belongs to the user.',
      inputSchema: z.object({
        port: portSchema,
        threadId: threadIdSchema,
        status: z.enum(['open', 'accepted', 'to_verify', 'ready']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ port, threadId, status }) => runTool(() => api.setThreadStatus(port, threadId, status)),
  );

  return server;
}
