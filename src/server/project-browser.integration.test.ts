import { promises as fs } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

import { simpleGit } from 'simple-git';
import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffMode } from '../types/watch.js';

import { AuthService } from './auth.js';
import { startServer } from './server.js';

globalThis.fetch = fetch as never;

describe('active review project browser', () => {
  let root: string;
  let repositoryPath: string;
  let server: Server | undefined;
  const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-project-browser-'));
    repositoryPath = join(root, 'checkout');
    await fs.mkdir(repositoryPath);
    process.env.DIFIT_CONFIG_DIR = join(root, 'config');
    const git = simpleGit(repositoryPath);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.invalid');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    await fs.writeFile(join(repositoryPath, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(join(repositoryPath, 'other.ts'), 'export const needle = 1;\n');
    await fs.writeFile(join(repositoryPath, 'ignored.txt'), 'needle hidden\n');
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (originalConfigDir === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists, searches, and previews files from the current checkout', async () => {
    const review = await startServer({
      selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
      repoPath: repositoryPath,
      preferredPort: 9360,
      openBrowser: false,
      keepAlive: true,
      includeUntracked: true,
      diffMode: DiffMode.DOT,
      authService: new AuthService({ disabled: true }),
    });
    server = review.server;
    const origin = `http://localhost:${review.port}`;

    const files = (await (await fetch(`${origin}/api/project/files`)).json()) as {
      files: string[];
    };
    expect(files.files).toContain('other.ts');
    expect(files.files).not.toContain('ignored.txt');

    const search = (await (await fetch(`${origin}/api/project/search?q=needle`)).json()) as {
      matches: Array<{ path: string; line: number }>;
    };
    expect(search.matches).toContainEqual(expect.objectContaining({ path: 'other.ts', line: 1 }));
    expect(search.matches.map((match) => match.path)).not.toContain('ignored.txt');

    await fs.mkdir(join(repositoryPath, 'tests'));
    await fs.writeFile(join(repositoryPath, 'tests', 'example.ts'), 'needle in test\n');
    await fs.writeFile(join(repositoryPath, '.difitignore'), 'tests/\n');
    const filteredFiles = (await (await fetch(`${origin}/api/project/files`)).json()) as {
      files: string[];
    };
    expect(filteredFiles.files).not.toContain('tests/example.ts');
    const filteredSearch = (await (
      await fetch(`${origin}/api/project/search?q=needle`)
    ).json()) as {
      matches: Array<{ path: string }>;
    };
    expect(filteredSearch.matches.map((match) => match.path)).not.toContain('tests/example.ts');

    const preview = await fetch(`${origin}/api/blob/other.ts?ref=working`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('export const needle = 1;');
  });
});
