import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  BACKGROUND_CHILD_ENV,
  parseBackgroundHandshakeMessage,
  releaseBackgroundChild,
  type BackgroundServerInfo,
} from '../cli/background.js';

export interface StartReviewOptions {
  repositoryPath: string;
  target: string;
  base?: string;
  includeUntracked?: boolean;
  mergeBase?: boolean;
  reviewer?: boolean;
}

export async function startReview(
  options: StartReviewOptions,
  spawnProcess: typeof spawn = spawn,
): Promise<BackgroundServerInfo> {
  const repositoryPath = await fs.realpath(options.repositoryPath);
  const cliEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
  const args = [cliEntrypoint, options.target];
  if (options.base) args.push(options.base);
  if (options.includeUntracked) args.push('--include-untracked');
  if (options.mergeBase) args.push('--merge-base');
  if (options.reviewer) args.push('--reviewer');
  args.push('--background');

  const child = spawnProcess(process.execPath, args, {
    cwd: repositoryPath,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      [BACKGROUND_CHILD_ENV]: '1',
    },
  });

  child.stderr?.setEncoding('utf8');
  return waitForHandshake(child);
}

function waitForHandshake(child: ChildProcess): Promise<BackgroundServerInfo> {
  return new Promise((resolveHandshake, reject) => {
    let settled = false;
    let stderr = '';

    const cleanup = (): void => {
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stderr?.removeListener('data', onStderr);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      callback();
    };
    const onStderr = (chunk: string): void => {
      stderr += chunk;
    };
    const onMessage = (message: unknown): void => {
      const handshake = parseBackgroundHandshakeMessage(message);
      if (!handshake) return;
      finish(() => {
        releaseBackgroundChild(child);
        resolveHandshake(handshake);
      });
    };
    const onError = (error: Error): void => {
      finish(() => {
        releaseBackgroundChild(child);
        reject(error);
      });
    };
    const onClose = (code: number | null): void => {
      finish(() => {
        releaseBackgroundChild(child);
        reject(
          new Error(
            stderr.trim() || `Background difit server exited early (code ${code ?? 'unknown'})`,
          ),
        );
      });
    };
    const timeout = setTimeout(() => {
      finish(() => {
        child.kill();
        releaseBackgroundChild(child);
        reject(new Error('Timed out while starting background difit server'));
      });
    }, 30_000);

    child.stderr?.on('data', onStderr);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('close', onClose);
  });
}
