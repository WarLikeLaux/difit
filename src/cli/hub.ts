import { Command } from 'commander';

import { startHubServer } from '../server/hub-server.js';

export function createHubCommand(): Command {
  return new Command('hub')
    .description('Run the local dashboard for registered difit reviews')
    .option('--port <port>', 'dashboard port', (value) => Number.parseInt(value, 10), 4965)
    .option('--host <host>', 'dashboard host', '127.0.0.1')
    .action(async (options: { port: number; host: string }) => {
      try {
        const result = await startHubServer(options.port, options.host);
        console.log(`difit hub started on ${result.url}`);
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : 'Failed to start difit hub'}`,
        );
        process.exitCode = 1;
      }
    });
}
