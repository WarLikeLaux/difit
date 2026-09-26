import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewRegistration } from './review-registry.js';

import {
  buildReviewRestartArgs,
  getReviewRestartPlan,
  spawnReviewServer,
} from './review-restart.js';

function makeRegistration(overrides: Partial<ReviewRegistration> = {}): ReviewRegistration {
  return {
    version: 1,
    id: 'a'.repeat(24),
    repositoryId: 'b'.repeat(64),
    repositoryPath: join(tmpdir(), 'difit-restart-missing-repo'),
    sessionKey: `review:${'a'.repeat(24)}`,
    branch: 'feature/one',
    baseRef: 'HEAD',
    targetRef: '.',
    baseMode: 'direct',
    followsBranch: true,
    initialHead: 'c'.repeat(40),
    port: 4123,
    pid: 1234,
    startedAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildReviewRestartArgs', () => {
  it('reconstructs a plain working tree review', () => {
    expect(buildReviewRestartArgs(makeRegistration())).toEqual(['.', '--include-untracked']);
  });

  it('reconstructs staged and working selections with their implied bases', () => {
    expect(
      buildReviewRestartArgs(makeRegistration({ targetRef: 'working', baseRef: 'staged' })),
    ).toEqual(['working', '--include-untracked']);
    expect(
      buildReviewRestartArgs(makeRegistration({ targetRef: 'staged', baseRef: 'HEAD' })),
    ).toEqual(['staged', '--include-untracked']);
  });

  it('keeps an explicit base for working tree comparisons', () => {
    expect(buildReviewRestartArgs(makeRegistration({ targetRef: '.', baseRef: 'main' }))).toEqual([
      '.',
      'main',
      '--include-untracked',
    ]);
  });

  it('reconstructs revision reviews and merge-base mode', () => {
    const head = 'd'.repeat(40);
    expect(
      buildReviewRestartArgs(
        makeRegistration({ targetRef: head, baseRef: `${head}^`, followsBranch: false }),
      ),
    ).toEqual([head, `${head}^`, '--include-untracked']);
    expect(
      buildReviewRestartArgs(
        makeRegistration({
          targetRef: head,
          baseRef: 'main',
          baseMode: 'merge-base',
          followsBranch: false,
        }),
      ),
    ).toEqual([head, 'main', '--merge-base', '--include-untracked']);
  });
});

describe('getReviewRestartPlan', () => {
  let root: string;
  let repositoryPath: string;
  const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'difit-restart-'));
    repositoryPath = join(root, 'checkout');
    await fs.mkdir(repositoryPath);
    process.env.DIFIT_CONFIG_DIR = root;
    const git = simpleGit(repositoryPath);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.invalid');
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    await git.checkoutLocalBranch('feature/one');
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.DIFIT_CONFIG_DIR;
    else process.env.DIFIT_CONFIG_DIR = originalConfigDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('plans a restart while the checkout stays on the registered branch', async () => {
    const plan = await getReviewRestartPlan(
      makeRegistration({ repositoryPath, hapiSessionId: 'session-1' }),
    );
    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.reason}`);
    expect(plan.command.args).toEqual(['.', '--include-untracked']);
    expect(plan.command.cwd).toBe(repositoryPath);
    expect(plan.command.env.HAPI_SESSION_ID).toBe('session-1');
  });

  it('leaves the HAPI session unset when the review has none', async () => {
    const plan = await getReviewRestartPlan(makeRegistration({ repositoryPath }));
    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.reason}`);
    expect(plan.command.env.HAPI_SESSION_ID).toBeUndefined();
  });

  it('refuses to restart after the checkout switched branches', async () => {
    const git = simpleGit(repositoryPath);
    await git.checkoutLocalBranch('feature/two');
    const plan = await getReviewRestartPlan(makeRegistration({ repositoryPath }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toContain('feature/two');
  });

  it('refuses to restart when the repository directory is gone', async () => {
    const plan = await getReviewRestartPlan(makeRegistration());
    expect(plan).toMatchObject({ ok: false, reason: 'Repository directory is missing' });
  });

  it('plans a restart for revision reviews whose commits still resolve', async () => {
    const git = simpleGit(repositoryPath);
    await fs.writeFile(join(repositoryPath, 'example.txt'), 'base\nfeature\n');
    await git.add('.');
    await git.commit('feature');
    const head = (await git.revparse(['HEAD'])).trim();
    const plan = await getReviewRestartPlan(
      makeRegistration({
        repositoryPath,
        followsBranch: false,
        branch: undefined,
        targetRef: head,
        baseRef: `${head}^`,
      }),
    );
    expect(plan).toMatchObject({
      ok: true,
      command: { args: [head, `${head}^`, '--include-untracked'] },
    });
  });

  it('refuses revision reviews whose commits are gone', async () => {
    const plan = await getReviewRestartPlan(
      makeRegistration({
        repositoryPath,
        followsBranch: false,
        branch: undefined,
        targetRef: 'e'.repeat(40),
        baseRef: `${'e'.repeat(40)}^`,
      }),
    );
    expect(plan).toMatchObject({ ok: false });
  });

  it('refuses piped stdin reviews', async () => {
    const plan = await getReviewRestartPlan(
      makeRegistration({ repositoryPath, targetRef: 'stdin' }),
    );
    expect(plan).toMatchObject({ ok: false });
  });
});

describe('spawnReviewServer', () => {
  it('spawns the difit cli detached in the review working directory', () => {
    const child = { unref: vi.fn() };
    const spawnMock = vi.fn(() => child);
    const returned = spawnReviewServer(
      { args: ['.', '--include-untracked'], cwd: '/repo', env: { HAPI_SESSION_ID: 's1' } },
      '/opt/difit/dist/cli/index.js',
      spawnMock as never,
    );
    expect(returned).toBe(child);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/opt/difit/dist/cli/index.js', '.', '--include-untracked', '--background'],
      {
        cwd: '/repo',
        env: { HAPI_SESSION_ID: 's1' },
        detached: true,
        stdio: 'ignore',
      },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
