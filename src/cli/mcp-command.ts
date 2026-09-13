import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Command } from 'commander';

import { createDifitMcpServer } from '../mcp/server.js';

export function createMcpCommand(): Command {
  return new Command('mcp').description('Run the difit MCP server over stdio').action(() => {
    serveStdio(() => createDifitMcpServer(), {
      onerror: (error) => console.error(`difit MCP error: ${error.message}`),
    });
  });
}
