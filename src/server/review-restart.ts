import { spawn, type ChildProcess } from 'child_process';
import { access } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { simpleGit, type SimpleGit } from 'simple-git';

import { normalizeGitLabMergeRequestUrl } from '../cli/gitlab.js';
import { createReviewContext, getReviewBranchState } from './review-context.js';
import { registrationToReviewContext, type ReviewRegistration } from './review-registry.js';

// Single-positional CLI invocations imply these bases (resolveDiffSelection in src/cli).
const WORKING_TREE_DEFAULT_BASES: Record<string, string> = {
  '.': 'HEAD',
  working: 'staged',
  staged: 'HEAD',
};

export interface ReviewRestartCommand {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type ReviewRestartPlan =
  | { ok: true; command: ReviewRestartCommand }
  | { ok: false; reason: string };

export function buildReviewRestartArgs(registration: ReviewRegistration): string[] {
  const args: string[] = [registration.targetRef];
  const impliedBase = WORKING_TREE_DEFAULT_BASES[registration.targetRef];
  if (impliedBase === undefined || impliedBase !== registration.baseRef) {
    args.push(registration.baseRef);
  }
  if (registration.baseMode === 'merge-base') args.push('--merge-base');
  if (registration.reviewUrl) args.push('--gitlab-mr', registration.reviewUrl);
  // Match scripts/deploy-local.sh, which restarts reviews with untracked files included.
  args.push('--include-untracked');
  return args;
}

export async function getReviewRestartPlan(
  registration: ReviewRegistration,
  gitFactory: (path: string) => SimpleGit = simpleGit,
): Promise<ReviewRestartPlan> {
  if (registration.baseRef === 'stdin' || registration.targetRef === 'stdin') {
    return { ok: false, reason: 'Piped stdin reviews cannot be restarted' };
  }
  try {
    await access(registration.repositoryPath);
  } catch {
    return { ok: false, reason: 'Repository directory is missing' };
  }
  const git = gitFactory(registration.repositoryPath);
  if (
    registration.reviewUrl &&
    normalizeGitLabMergeRequestUrl(registration.reviewUrl) !== registration.reviewUrl
  ) {
    return { ok: false, reason: 'Review URL cannot be restored by the CLI' };
  }
  if (registration.followsBranch) {
    if (!registration.branch) {
      return { ok: false, reason: 'Registration records no branch to follow' };
    }
    const state = await getReviewBranchState(registrationToReviewContext(registration), git);
    if (state.stale) {
      return {
        ok: false,
        reason: `Repository is now on ${state.currentBranch ?? 'a detached HEAD'}`,
      };
    }
  } else {
    for (const revision of [registration.baseRef, registration.targetRef]) {
      try {
        await git.revparse([revision]);
      } catch {
        return { ok: false, reason: `Revision ${revision} no longer resolves` };
      }
    }
    if (registration.branch && registration.targetRef === 'HEAD') {
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== registration.branch) {
        return { ok: false, reason: `Repository is now on ${currentBranch}` };
      }
    }
    try {
      const currentContext = await createReviewContext({
        repositoryPath: registration.repositoryPath,
        repositoryId: registration.repositoryId,
        selection: {
          baseCommitish: registration.baseRef,
          targetCommitish: registration.targetRef,
          baseMode: registration.baseMode === 'merge-base' ? 'merge-base' : 'direct',
        },
        reviewUrl: registration.reviewUrl,
        git,
      });
      if (currentContext.id !== registration.id) {
        return { ok: false, reason: 'Review identity changed since the last launch' };
      }
    } catch {
      return { ok: false, reason: 'Review identity cannot be restored' };
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (registration.hapiSessionId) env.HAPI_SESSION_ID = registration.hapiSessionId;
  else delete env.HAPI_SESSION_ID;
  return {
    ok: true,
    command: {
      args: buildReviewRestartArgs(registration),
      cwd: registration.repositoryPath,
      env,
    },
  };
}

export function resolveDifitCliEntry(): string {
  return process.argv[1] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
}

export function spawnReviewServer(
  command: ReviewRestartCommand,
  cliEntry: string,
  spawnProcess: typeof spawn = spawn,
): ChildProcess {
  const child = spawnProcess(process.execPath, [cliEntry, ...command.args, '--background'], {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
