import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DifitReviewApi } from './review-api.js';
import { createDifitMcpServer } from './server.js';

const connections: Array<{ client: Client; server: ReturnType<typeof createDifitMcpServer> }> = [];

async function connect(dependencies: Parameters<typeof createDifitMcpServer>[0] = {}) {
  const server = createDifitMcpServer(dependencies);
  const client = new Client({ name: 'difit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connections.push({ client, server });
  return client;
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]),
  );
});

describe('difit MCP server', () => {
  it('exposes the complete review workflow', async () => {
    const client = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'start_review',
      'list_reviews',
      'get_review_context',
      'get_comments',
      'get_events',
      'ack_events',
      'add_comment',
      'reply',
      'edit_message',
      'set_thread_status',
    ]);

    const statusTool = tools.tools.find((tool) => tool.name === 'set_thread_status');
    expect(statusTool?.description).toContain('Never edit code for an Open thread');
    expect(statusTool?.inputSchema).toMatchObject({
      properties: { status: { enum: ['open', 'ready'] } },
    });
  });

  it('reads and acknowledges durable events through authenticated difit HTTP APIs', async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/agent-events/ack')) {
        expect(init).toMatchObject({ method: 'POST' });
        expect(JSON.parse(String(init?.body))).toEqual({ throughSeq: 3 });
        return Response.json({ success: true, ackedThrough: 3, pendingCount: 0 });
      }
      return Response.json({
        reviewId: 'review-1',
        ackedThrough: 0,
        throughSeq: 3,
        events: [{ seq: 3, type: 'userMessage' }],
      });
    });
    const client = await connect({ api: new DifitReviewApi(fetcher) });

    const events = await client.callTool({ name: 'get_events', arguments: { port: 4966 } });
    expect(events.structuredContent).toMatchObject({ reviewId: 'review-1', throughSeq: 3 });

    const acknowledged = await client.callTool({
      name: 'ack_events',
      arguments: { port: 4966, throughSeq: 3 },
    });
    expect(acknowledged.structuredContent).toMatchObject({
      success: true,
      ackedThrough: 3,
      pendingCount: 0,
    });
  });

  it('starts a detached review and lists registered viewers', async () => {
    const launchReview = vi.fn(async () => ({
      port: 4966,
      url: 'https://difit.example/reviews/review-1/',
      pid: 123,
    }));
    const client = await connect({
      startReview: launchReview,
      listReviews: async () => [
        {
          version: 1,
          id: 'review-1',
          repositoryId: 'repository-1',
          repositoryPath: '/repo',
          sessionKey: 'review:review-1',
          baseRef: 'HEAD',
          targetRef: '.',
          baseMode: 'direct',
          followsBranch: true,
          initialHead: 'abc123',
          port: 4966,
          pid: Number.MAX_SAFE_INTEGER,
          startedAt: '2026-09-13T10:00:00.000Z',
          updatedAt: '2026-09-13T10:00:00.000Z',
        },
      ],
    });

    const started = await client.callTool({
      name: 'start_review',
      arguments: { repositoryPath: '/repo', target: '.', includeUntracked: true },
    });
    expect(started.structuredContent).toMatchObject({ port: 4966, pid: 123 });
    expect(launchReview).toHaveBeenCalledWith({
      repositoryPath: '/repo',
      target: '.',
      includeUntracked: true,
      mergeBase: false,
    });

    const listed = await client.callTool({
      name: 'list_reviews',
      arguments: { repositoryPath: '/repo' },
    });
    expect(listed.structuredContent).toMatchObject({
      reviews: [expect.objectContaining({ id: 'review-1', running: false })],
    });
  });

  it('returns API failures as MCP tool errors', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: 'Thread not found' }, { status: 404 }),
    );
    const client = await connect({ api: new DifitReviewApi(fetcher) });

    const result = await client.callTool({
      name: 'reply',
      arguments: { port: 4966, threadId: 'missing', body: 'Hello' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Thread not found' }]);
  });
});
