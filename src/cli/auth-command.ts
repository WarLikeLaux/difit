import { Command } from 'commander';

import { getDefaultAuthService } from '../server/auth.js';

export function createAuthCommand(): Command {
  const auth = new Command('auth').description('Manage local Difit access');

  auth
    .command('key')
    .description('Print the browser access key to this terminal')
    .action(async () => {
      console.log(await getDefaultAuthService().getAccessKey());
    });

  auth
    .command('rotate')
    .description('Replace the browser access key and revoke every browser session')
    .action(async () => {
      console.log(await getDefaultAuthService().rotateAccessKey());
    });

  auth
    .command('revoke')
    .description('Revoke every browser session without changing the access key')
    .action(async () => {
      await getDefaultAuthService().revokeAllBrowserSessions();
      console.log('All Difit browser sessions were revoked.');
    });

  auth
    .command('rotate-cli')
    .description('Replace the private CLI credential and disconnect existing CLI watchers')
    .action(async () => {
      await getDefaultAuthService().rotateCliToken();
      console.log('The Difit CLI credential was rotated.');
    });

  return auth;
}
