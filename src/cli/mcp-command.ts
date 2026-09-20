import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Command } from 'commander';

import { createDifitMcpServer } from '../mcp/server.js';

export function createMcpCommand(): Command {
  return new Command('mcp')
    .description('Run the difit MCP server over stdio')
    .option('--role <role>', 'MCP server role ("full" or "reviewer")', 'full')
    .option('--author <author>', 'default author label for review comments')
    .action((options: { role?: 'full' | 'reviewer'; author?: string }) => {
      const role =
        (options.role ?? process.env.DIFIT_ROLE ?? 'full') === 'reviewer' ? 'reviewer' : 'full';
      const defaultAuthor = options.author ?? process.env.DIFIT_AUTHOR;
      serveStdio(() => createDifitMcpServer({ role, defaultAuthor }), {
        onerror: (error) => console.error(`difit MCP error: ${error.message}`),
      });
    });
}
