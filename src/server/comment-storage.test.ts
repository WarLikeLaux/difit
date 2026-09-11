import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCommentSessions, writeCommentSessions } from './comment-storage.js';

describe('comment storage', () => {
  let configDir: string;
  const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(join(tmpdir(), 'difit-comments-'));
    process.env.DIFIT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('restores comment sessions written by a previous server process', async () => {
    await writeCommentSessions(
      'repository-id',
      new Map([
        [
          'base...target',
          {
            version: 4,
            threads: [
              {
                id: 'thread-1',
                filePath: 'src/file.ts',
                position: { side: 'new', line: 12 },
                acceptedAt: '2026-09-11T12:00:00.000Z',
                messages: [],
                createdAt: '2026-09-11T11:00:00.000Z',
                updatedAt: '2026-09-11T12:00:00.000Z',
              },
            ],
          },
        ],
      ]),
    );

    const sessions = await readCommentSessions('repository-id');
    expect(sessions['base...target']).toMatchObject({
      version: 4,
      threads: [{ id: 'thread-1', acceptedAt: '2026-09-11T12:00:00.000Z' }],
    });
  });
});
