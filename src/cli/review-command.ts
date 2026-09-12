import { Command } from 'commander';

import { authenticatedFetch } from './auth-client.js';

export function createReviewCommand(): Command {
  const review = new Command('review').description('Inspect a running difit review');

  review
    .command('context')
    .description('Print the authenticated review context as JSON')
    .requiredOption('--port <port>', 'port of the running difit server', Number.parseInt)
    .action(async (options: { port: number }) => {
      try {
        const response = await authenticatedFetch(
          `http://localhost:${options.port}/api/review-context`,
        );
        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(errorBody.error ?? `Request failed with status ${response.status}`);
        }
        console.log(JSON.stringify(await response.json()));
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : 'Failed to retrieve review context'}`,
        );
        process.exitCode = 1;
      }
    });

  return review;
}
