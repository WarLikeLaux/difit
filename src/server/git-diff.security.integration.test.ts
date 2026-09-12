import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';

import { createDiffSelection } from '../utils/diffSelection.js';

import { GitDiffParser } from './git-diff.js';

describe('passive Git diff security', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('does not execute a configured textconv driver', async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-textconv-'));
    const markerPath = join(root, 'textconv-ran');
    const driverPath = join(root, 'safe-textconv');
    const repositoryPath = join(root, 'repo');
    await fs.mkdir(repositoryPath);
    await fs.writeFile(driverPath, `#!/bin/sh\ntouch '${markerPath}'\ncat "$1"\n`);
    await fs.chmod(driverPath, 0o700);

    const git = simpleGit(repositoryPath);
    await git.init();
    await git.addConfig('user.email', 'security-test@example.invalid');
    await git.addConfig('user.name', 'Security Test');
    execFileSync('git', ['config', 'diff.marker.textconv', driverPath], { cwd: repositoryPath });
    await fs.writeFile(join(repositoryPath, '.gitattributes'), '*.txt diff=marker\n');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'before\n');
    await git.add('.');
    await git.commit('before');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'after\n');
    await git.add('.');
    await git.commit('after');

    const result = await new GitDiffParser(repositoryPath).parseDiff(
      createDiffSelection('HEAD^', 'HEAD'),
    );

    expect(result.files).toHaveLength(1);
    await expect(fs.access(markerPath)).rejects.toThrow();
  });
});
