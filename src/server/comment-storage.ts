import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import type { DiffCommentThread } from '../types/diff.js';

export interface StoredCommentSession {
  threads: DiffCommentThread[];
  version: number;
}

export type StoredCommentSessions = Record<string, StoredCommentSession>;

const STORE_VERSION = 1 as const;

function getCommentStorageDirectory(): string {
  const configDir = process.env.DIFIT_CONFIG_DIR?.trim();
  return configDir || join(homedir(), '.difit');
}

function isCommentStorageDisabled(): boolean {
  return process.env.NODE_ENV === 'test' && !process.env.DIFIT_CONFIG_DIR?.trim();
}

function getCommentStorePath(repositoryId: string): string {
  return join(getCommentStorageDirectory(), 'comments', `${repositoryId}.json`);
}

export async function readCommentSessions(repositoryId: string): Promise<StoredCommentSessions> {
  if (isCommentStorageDisabled()) return {};

  try {
    const raw = await fs.readFile(getCommentStorePath(repositoryId), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const sessions = (parsed as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return {};

    return Object.fromEntries(
      Object.entries(sessions as Record<string, unknown>).filter(
        (entry): entry is [string, StoredCommentSession] => {
          const value = entry[1];
          return (
            Boolean(value) &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Array.isArray((value as StoredCommentSession).threads) &&
            Number.isInteger((value as StoredCommentSession).version)
          );
        },
      ),
    );
  } catch {
    return {};
  }
}

export async function writeCommentSessions(
  repositoryId: string,
  sessions: ReadonlyMap<string, StoredCommentSession>,
): Promise<void> {
  if (isCommentStorageDisabled()) return;

  const path = getCommentStorePath(repositoryId);
  const serialized = `${JSON.stringify(
    { version: STORE_VERSION, sessions: Object.fromEntries(sessions) },
    null,
    2,
  )}\n`;

  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, serialized, 'utf-8');
  await fs.rename(temporaryPath, path);
}
