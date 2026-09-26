import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listProjectFiles, searchProjectCode } from './project-files.js';

describe('current checkout project files', () => {
  let root: string;
  let repositoryPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-project-files-'));
    repositoryPath = join(root, 'checkout');
    await fs.mkdir(repositoryPath);
    const git = simpleGit(repositoryPath);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.invalid');
    await fs.writeFile(join(repositoryPath, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(join(repositoryPath, 'tracked.txt'), 'committed content\n');
    await git.add(['.gitignore', 'tracked.txt']);
    await git.commit('base');

    await fs.writeFile(join(repositoryPath, 'tracked.txt'), 'first line\nneedle on disk\n');
    await fs.writeFile(join(repositoryPath, 'untracked.txt'), 'needle in untracked file\n');
    await fs.writeFile(join(repositoryPath, 'ignored.txt'), 'needle in ignored file\n');
    await fs.writeFile(join(root, 'outside.txt'), 'needle outside repository\n');
    await fs.symlink(join(root, 'outside.txt'), join(repositoryPath, 'external-link.txt'));
    await git.add('external-link.txt');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists files on disk, including untracked files but excluding ignored files and external symlinks', async () => {
    expect(await listProjectFiles(repositoryPath)).toEqual([
      '.gitignore',
      'tracked.txt',
      'untracked.txt',
    ]);
  });

  it('searches current file contents without searching ignored files', async () => {
    expect(await searchProjectCode(repositoryPath, 'needle')).toEqual({
      matches: [
        { path: 'tracked.txt', line: 2, text: 'needle on disk' },
        { path: 'untracked.txt', line: 1, text: 'needle in untracked file' },
      ],
      truncated: false,
    });
  });

  it('applies .difitignore to tracked and untracked files in both project searches', async () => {
    await fs.mkdir(join(repositoryPath, 'tests'));
    await fs.writeFile(join(repositoryPath, 'tests', 'tracked.ts'), 'needle in tracked test\n');
    await simpleGit(repositoryPath).add('tests/tracked.ts');
    await fs.writeFile(join(repositoryPath, 'tests', 'untracked.ts'), 'needle in untracked test\n');
    await fs.writeFile(join(repositoryPath, '.difitignore'), 'tests/\n');

    const files = await listProjectFiles(repositoryPath);
    expect(files).toContain('tracked.txt');
    expect(files).toContain('.difitignore');
    expect(files).not.toContain('tests/tracked.ts');
    expect(files).not.toContain('tests/untracked.ts');

    const matches = (await searchProjectCode(repositoryPath, 'needle')).matches;
    expect(matches.map((match) => match.path)).toEqual(['tracked.txt', 'untracked.txt']);
  });

  it('treats the query as literal text and rejects multiline queries', async () => {
    await fs.writeFile(join(repositoryPath, 'untracked.txt'), 'array[0]\n');
    expect((await searchProjectCode(repositoryPath, 'array[0]')).matches).toEqual([
      { path: 'untracked.txt', line: 1, text: 'array[0]' },
    ]);
    await expect(searchProjectCode(repositoryPath, 'one\ntwo')).rejects.toThrow('one line');
  });
});
