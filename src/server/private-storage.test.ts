import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  writePrivateFile,
} from './private-storage.js';

describe('private storage', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-private-storage-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('restricts directories and atomically written files to the current user', async () => {
    const directory = join(root, 'state');
    const path = join(directory, 'comments.json');

    await ensurePrivateDirectory(directory);
    await writePrivateFile(path, '{}\n');

    expect((await fs.stat(directory)).mode & 0o777).toBe(PRIVATE_DIRECTORY_MODE);
    expect((await fs.stat(path)).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  });
});
