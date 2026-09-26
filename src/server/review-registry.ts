import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import type { ReviewContext } from './review-context.js';

import { ensurePrivateDirectory, writePrivateFile } from './private-storage.js';

export interface ReviewRegistration {
  version: 1;
  id: string;
  repositoryId: string;
  repositoryPath: string;
  sessionKey: string;
  branch?: string;
  baseRef: string;
  targetRef: string;
  baseMode: string;
  reviewUrl?: string;
  followsBranch: boolean;
  initialHead: string;
  port: number;
  pid: number;
  startedAt: string;
  updatedAt: string;
  agentAttached?: boolean;
  hapiSessionId?: string;
}

function getConfigDirectory(): string {
  const configDir = process.env.DIFIT_CONFIG_DIR?.trim();
  return configDir || join(homedir(), '.difit');
}

function isReviewRegistryDisabled(): boolean {
  return Boolean(process.env.VITEST) && !process.env.DIFIT_CONFIG_DIR?.trim();
}

function getRegistrationPath(id: string): string {
  return join(getConfigDirectory(), 'reviews', `${id}.json`);
}

function isReviewRegistration(value: unknown): value is ReviewRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ReviewRegistration>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === 'string' &&
    typeof candidate.repositoryId === 'string' &&
    typeof candidate.repositoryPath === 'string' &&
    typeof candidate.sessionKey === 'string' &&
    typeof candidate.baseRef === 'string' &&
    typeof candidate.targetRef === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.pid === 'number'
  );
}

export async function registerReview(
  context: ReviewContext,
  port: number,
  pid = process.pid,
  hapiSessionId?: string,
): Promise<ReviewRegistration> {
  const now = new Date().toISOString();
  const path = getRegistrationPath(context.id);
  let startedAt = now;
  let branch = context.branch;
  let previousHapiSessionId: string | undefined;

  try {
    const existing = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
    if (isReviewRegistration(existing) && typeof existing.startedAt === 'string') {
      startedAt = existing.startedAt;
      branch ??= existing.branch;
      previousHapiSessionId = existing.hapiSessionId;
    }
  } catch {
    // First launch of this review.
  }

  const registration: ReviewRegistration = {
    version: 1,
    id: context.id,
    repositoryId: context.repositoryId,
    repositoryPath: context.repositoryPath,
    sessionKey: context.sessionKey,
    branch,
    baseRef: context.baseRef,
    targetRef: context.targetRef,
    baseMode: context.baseMode,
    reviewUrl: context.reviewUrl,
    followsBranch: context.followsBranch,
    initialHead: context.initialHead,
    port,
    pid,
    startedAt,
    updatedAt: now,
    agentAttached: Boolean(hapiSessionId?.trim()),
    hapiSessionId: hapiSessionId?.trim() || previousHapiSessionId,
  };

  if (isReviewRegistryDisabled()) return registration;

  await ensurePrivateDirectory(getConfigDirectory());
  await ensurePrivateDirectory(dirname(path));
  await writePrivateFile(path, `${JSON.stringify(registration, null, 2)}\n`);
  return registration;
}

export async function deleteReviewRegistration(id: string): Promise<void> {
  if (isReviewRegistryDisabled()) return;
  await fs.rm(getRegistrationPath(id), { force: true });
}

export async function readReviewRegistrations(): Promise<ReviewRegistration[]> {
  if (isReviewRegistryDisabled()) return [];
  const directory = join(getConfigDirectory(), 'reviews');
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }

  const registrations = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name): Promise<ReviewRegistration | undefined> => {
        try {
          const parsed = JSON.parse(await fs.readFile(join(directory, name), 'utf8')) as unknown;
          return isReviewRegistration(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return registrations.filter(
    (registration): registration is ReviewRegistration => registration !== undefined,
  );
}

export function registrationToReviewContext(registration: ReviewRegistration): ReviewContext {
  return {
    id: registration.id,
    sessionKey: registration.sessionKey,
    repositoryId: registration.repositoryId,
    repositoryPath: registration.repositoryPath,
    branch: registration.branch,
    baseRef: registration.baseRef,
    targetRef: registration.targetRef,
    baseMode: registration.baseMode === 'merge-base' ? 'merge-base' : 'direct',
    reviewUrl: registration.reviewUrl,
    followsBranch: registration.followsBranch,
    initialHead: registration.initialHead,
    legacySessionKeys: [],
  };
}

export async function reuseExistingWorkingTreeIdentity(
  context: ReviewContext,
  hapiSessionId = process.env.VITEST ? undefined : process.env.HAPI_SESSION_ID?.trim(),
): Promise<ReviewContext> {
  if (!context.followsBranch || !context.branch || (!context.reviewUrl && !hapiSessionId)) {
    return context;
  }

  const matchingRegistrations = (await readReviewRegistrations())
    .filter(
      (registration) =>
        registration.repositoryId === context.repositoryId &&
        registration.branch === context.branch &&
        registration.baseRef === context.baseRef &&
        registration.targetRef === context.targetRef &&
        registration.baseMode === context.baseMode &&
        registration.followsBranch &&
        registration.hapiSessionId === hapiSessionId &&
        (!registration.reviewUrl || registration.reviewUrl === context.reviewUrl),
    )
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    );
  const existing = matchingRegistrations[0];
  if (!existing) return context;

  return {
    ...context,
    id: existing.id,
    sessionKey: existing.sessionKey,
    legacySessionKeys: [...new Set([...context.legacySessionKeys, context.sessionKey])],
  };
}
