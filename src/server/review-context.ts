import { createHash } from 'crypto';

import { simpleGit, type SimpleGit } from 'simple-git';

import type { BaseMode, DiffSelection } from '../types/diff.js';
import { normalizeBaseMode } from '../utils/diffSelection.js';

export interface ReviewContext {
  id: string;
  sessionKey: string;
  repositoryId: string;
  repositoryPath: string;
  branch?: string;
  baseRef: string;
  targetRef: string;
  baseMode: BaseMode;
  reviewUrl?: string;
  followsBranch: boolean;
  initialHead: string;
  legacySessionKeys: string[];
}

export interface ReviewBranchState {
  stale: boolean;
  currentBranch?: string;
  currentHead?: string;
}

interface CreateReviewContextOptions {
  repositoryPath: string;
  repositoryId: string;
  selection: DiffSelection;
  reviewUrl?: string;
  git?: SimpleGit;
  hapiSessionId?: string;
}

function shortHash(value: string): string {
  return value.slice(0, 7);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function resolveRevision(git: SimpleGit, revision: string): Promise<string> {
  return (await git.revparse([revision])).trim();
}

export async function createReviewContext({
  repositoryPath,
  repositoryId,
  selection,
  reviewUrl,
  git = simpleGit(repositoryPath),
  hapiSessionId = process.env.VITEST ? undefined : process.env.HAPI_SESSION_ID?.trim(),
}: CreateReviewContextOptions): Promise<ReviewContext> {
  const initialHead = await resolveRevision(git, 'HEAD');
  const branchValue = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  const branch = branchValue && branchValue !== 'HEAD' ? branchValue : undefined;
  const targetIsWorkingTree = ['.', 'working', 'staged'].includes(selection.targetCommitish);
  const resolvedTarget = targetIsWorkingTree
    ? initialHead
    : await resolveRevision(git, selection.targetCommitish);
  const followsBranch = Boolean(branch && targetIsWorkingTree);
  const snapshotBranch = branch && resolvedTarget === initialHead ? branch : undefined;
  const baseMode = normalizeBaseMode(selection.baseMode);
  const stableSource = reviewUrl
    ? `review-url:${reviewUrl}`
    : followsBranch
      ? `branch:${branch}:base:${selection.baseCommitish}:mode:${baseMode}`
      : `revision:${selection.baseCommitish}:${resolvedTarget}:mode:${baseMode}`;
  const sessionScope = followsBranch && hapiSessionId ? `:hapi-session:${hapiSessionId}` : '';
  const id = hash(`${repositoryId}:${stableSource}${sessionScope}`).slice(0, 24);

  const resolvedBase =
    baseMode === 'merge-base'
      ? (
          await git.raw([
            'merge-base',
            targetIsWorkingTree ? initialHead : resolvedTarget,
            selection.baseCommitish,
          ])
        ).trim()
      : await resolveRevision(git, selection.baseCommitish);
  const legacyTargets = new Set([shortHash(resolvedTarget), selection.targetCommitish]);
  if (targetIsWorkingTree) legacyTargets.add(selection.targetCommitish);
  const legacySessionKeys = [...legacyTargets].map(
    (target) => `${shortHash(resolvedBase)}:${target}:${baseMode}`,
  );

  return {
    id,
    sessionKey:
      followsBranch || reviewUrl
        ? `review:${id}`
        : (legacySessionKeys[0] ??
          `revision:${shortHash(resolvedBase)}:${shortHash(resolvedTarget)}`),
    repositoryId,
    repositoryPath,
    branch: followsBranch ? branch : snapshotBranch,
    baseRef: selection.baseCommitish,
    targetRef: selection.targetCommitish,
    baseMode,
    reviewUrl,
    followsBranch,
    initialHead,
    legacySessionKeys,
  };
}

export async function getReviewBranchState(
  context: ReviewContext,
  git?: SimpleGit,
): Promise<ReviewBranchState> {
  if (!context.followsBranch || !context.branch) {
    return { stale: false };
  }

  try {
    const repository = git ?? simpleGit(context.repositoryPath);
    const branchValue = (await repository.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const currentBranch = branchValue && branchValue !== 'HEAD' ? branchValue : undefined;
    const currentHead = await resolveRevision(repository, 'HEAD');
    return {
      stale: currentBranch !== context.branch,
      currentBranch,
      currentHead,
    };
  } catch {
    return { stale: true };
  }
}
