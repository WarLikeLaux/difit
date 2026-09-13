import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, RequestHandler } from 'express';

import { ensurePrivateDirectory, PRIVATE_FILE_MODE, writePrivateFile } from './private-storage.js';

export const AUTH_COOKIE_NAME = '__Host-difit_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

interface AccessConfig {
  version: 1;
  accessKey: string;
  generation: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredSession {
  version: 1;
  generation: string;
  createdAt: number;
  expiresAt: number;
}

export type AuthPrincipal =
  | { kind: 'browser'; sessionDigest: string }
  | { kind: 'cli'; tokenDigest: string }
  | { kind: 'test' };

export interface AuthServiceOptions {
  configDirectory?: string;
  now?: () => number;
  sessionTtlMs?: number;
  disabled?: boolean;
}

function defaultConfigDirectory(): string {
  const configured = process.env.DIFIT_CONFIG_DIR?.trim();
  return configured || join(homedir(), '.difit');
}

function createSecret(): string {
  return randomBytes(32).toString('base64url');
}

function digestSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isAccessConfig(value: unknown): value is AccessConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AccessConfig>;
  return (
    candidate.version === 1 &&
    typeof candidate.accessKey === 'string' &&
    candidate.accessKey.length >= 32 &&
    typeof candidate.generation === 'string' &&
    candidate.generation.length >= 16 &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredSession>;
  return (
    candidate.version === 1 &&
    typeof candidate.generation === 'string' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
}

async function createPrivateFileIfMissing(path: string, content: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  try {
    await fs.writeFile(path, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    await fs.chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export class AuthService {
  readonly #authDirectory: string;
  readonly #sessionsDirectory: string;
  readonly #accessConfigPath: string;
  readonly #cliTokenPath: string;
  readonly #publicOriginPath: string;
  readonly #now: () => number;
  readonly #sessionTtlMs: number;
  readonly #disabled: boolean;
  #initialization?: Promise<void>;

  constructor(options: AuthServiceOptions = {}) {
    const configDirectory = options.configDirectory ?? defaultConfigDirectory();
    this.#authDirectory = join(configDirectory, 'auth');
    this.#sessionsDirectory = join(this.#authDirectory, 'sessions');
    this.#accessConfigPath = join(this.#authDirectory, 'access.json');
    this.#cliTokenPath = join(this.#authDirectory, 'cli-token');
    this.#publicOriginPath = join(this.#authDirectory, 'public-origin');
    this.#now = options.now ?? Date.now;
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.#disabled = options.disabled ?? false;
  }

  async initialize(): Promise<void> {
    if (this.#disabled) return;
    this.#initialization ??= this.#initializeFiles();
    await this.#initialization;
  }

  async #initializeFiles(): Promise<void> {
    await ensurePrivateDirectory(this.#authDirectory);
    await ensurePrivateDirectory(this.#sessionsDirectory);
    const now = new Date(this.#now()).toISOString();
    const accessConfig: AccessConfig = {
      version: 1,
      accessKey: createSecret(),
      generation: createSecret(),
      createdAt: now,
      updatedAt: now,
    };
    await createPrivateFileIfMissing(
      this.#accessConfigPath,
      `${JSON.stringify(accessConfig, null, 2)}\n`,
    );
    await createPrivateFileIfMissing(this.#cliTokenPath, `${createSecret()}\n`);
    await this.#readAccessConfig();
    await this.#readCliToken();
  }

  async #readAccessConfig(): Promise<AccessConfig> {
    const parsed: unknown = JSON.parse(await fs.readFile(this.#accessConfigPath, 'utf8'));
    if (!isAccessConfig(parsed)) throw new Error('Invalid Difit access configuration');
    return parsed;
  }

  async #readCliToken(): Promise<string> {
    const token = (await fs.readFile(this.#cliTokenPath, 'utf8')).trim();
    if (token.length < 32) throw new Error('Invalid Difit CLI credential');
    return token;
  }

  async getAccessKey(): Promise<string> {
    await this.initialize();
    if (this.#disabled) return 'difit-test-access-key-disabled';
    return (await this.#readAccessConfig()).accessKey;
  }

  async getCliAuthorizationHeader(): Promise<string> {
    await this.initialize();
    if (this.#disabled) return 'Bearer difit-test-cli-token-disabled';
    return `Bearer ${await this.#readCliToken()}`;
  }

  async configurePublicOrigin(origin: string): Promise<void> {
    await this.initialize();
    if (this.#disabled) return;
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') {
      throw new Error('Difit browser access requires an HTTPS public origin');
    }
    await writePrivateFile(this.#publicOriginPath, `${parsed.origin}\n`);
  }

  async getPublicOrigin(): Promise<string | undefined> {
    await this.initialize();
    if (this.#disabled) return undefined;
    try {
      const parsed = new URL((await fs.readFile(this.#publicOriginPath, 'utf8')).trim());
      return parsed.protocol === 'https:' ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  }

  async createBrowserSession(accessKey: string): Promise<string | undefined> {
    await this.initialize();
    if (this.#disabled) return createSecret();
    const access = await this.#readAccessConfig();
    if (!secretsEqual(accessKey, access.accessKey)) return undefined;

    const token = createSecret();
    const digest = digestSecret(token);
    const now = this.#now();
    const session: StoredSession = {
      version: 1,
      generation: access.generation,
      createdAt: now,
      expiresAt: now + this.#sessionTtlMs,
    };
    await createPrivateFileIfMissing(
      join(this.#sessionsDirectory, `${digest}.json`),
      `${JSON.stringify(session, null, 2)}\n`,
    );
    return token;
  }

  createSessionCookie(token: string): string {
    return serializeCookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      maxAge: Math.floor(this.#sessionTtlMs / 1_000),
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  }

  createExpiredSessionCookie(): string {
    return serializeCookie(AUTH_COOKIE_NAME, '', {
      expires: new Date(0),
      httpOnly: true,
      maxAge: 0,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  }

  async authenticateRequest(req: Request): Promise<AuthPrincipal | undefined> {
    if (this.#disabled) return { kind: 'test' };
    await this.initialize();

    const authorization = req.get('authorization');
    if (authorization?.startsWith('Bearer ')) {
      const submitted = authorization.slice('Bearer '.length);
      if (secretsEqual(submitted, await this.#readCliToken())) {
        return { kind: 'cli', tokenDigest: digestSecret(submitted) };
      }
    }

    let sessionToken: string | undefined;
    try {
      sessionToken = parseCookie(req.get('cookie') ?? '')[AUTH_COOKIE_NAME];
    } catch {
      return undefined;
    }
    if (!sessionToken) return undefined;
    const sessionDigest = digestSecret(sessionToken);
    return (await this.#isBrowserSessionValid(sessionDigest))
      ? { kind: 'browser', sessionDigest }
      : undefined;
  }

  async #isBrowserSessionValid(sessionDigest: string): Promise<boolean> {
    try {
      const path = join(this.#sessionsDirectory, `${sessionDigest}.json`);
      const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
      if (!isStoredSession(parsed)) return false;
      const access = await this.#readAccessConfig();
      if (parsed.expiresAt <= this.#now() || parsed.generation !== access.generation) {
        await fs.unlink(path).catch(() => undefined);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async isPrincipalValid(principal: AuthPrincipal): Promise<boolean> {
    if (principal.kind === 'test' || this.#disabled) return true;
    if (principal.kind === 'cli') {
      return secretsEqual(principal.tokenDigest, digestSecret(await this.#readCliToken()));
    }
    return this.#isBrowserSessionValid(principal.sessionDigest);
  }

  async revokeBrowserSession(principal: AuthPrincipal): Promise<void> {
    if (principal.kind !== 'browser' || this.#disabled) return;
    await fs
      .unlink(join(this.#sessionsDirectory, `${principal.sessionDigest}.json`))
      .catch(() => undefined);
  }

  async rotateAccessKey(): Promise<string> {
    await this.initialize();
    const previous = await this.#readAccessConfig();
    const now = new Date(this.#now()).toISOString();
    const next: AccessConfig = {
      ...previous,
      accessKey: createSecret(),
      generation: createSecret(),
      updatedAt: now,
    };
    await writePrivateFile(this.#accessConfigPath, `${JSON.stringify(next, null, 2)}\n`);
    return next.accessKey;
  }

  async revokeAllBrowserSessions(): Promise<void> {
    await this.initialize();
    const previous = await this.#readAccessConfig();
    const next: AccessConfig = {
      ...previous,
      generation: createSecret(),
      updatedAt: new Date(this.#now()).toISOString(),
    };
    await writePrivateFile(this.#accessConfigPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  async rotateCliToken(): Promise<void> {
    await this.initialize();
    if (this.#disabled) return;
    await writePrivateFile(this.#cliTokenPath, `${createSecret()}\n`);
  }
}

let defaultAuthService: AuthService | undefined;

export function getDefaultAuthService(): AuthService {
  defaultAuthService ??= new AuthService();
  return defaultAuthService;
}

export function requireAuthentication(
  auth: AuthService,
  options: { loginPath?: string } = {},
): RequestHandler {
  return async (req, res, next) => {
    const principal = await auth.authenticateRequest(req);
    if (principal) {
      res.locals.authPrincipal = principal;
      next();
      return;
    }

    const acceptsHtml = (req.get('accept') ?? '')
      .split(',')
      .some((value) => value.trim().toLowerCase().startsWith('text/html'));
    if (options.loginPath && req.method === 'GET' && acceptsHtml) {
      res.redirect(303, options.loginPath);
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };
}

export function requireBrowserMutationOrigin(): RequestHandler {
  return (req, res, next) => {
    const principal = getAuthenticatedPrincipal(res.locals as Record<string, unknown>);
    const safeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (principal.kind === 'browser' && !safeMethod && !req.get('origin')) {
      res.status(403).json({ error: 'Browser mutations require an Origin header' });
      return;
    }
    next();
  };
}

export function getAuthenticatedPrincipal(locals: Record<string, unknown>): AuthPrincipal {
  const principal = locals.authPrincipal;
  if (!principal || typeof principal !== 'object' || !('kind' in principal)) {
    throw new Error('Authenticated principal is unavailable');
  }
  return principal as AuthPrincipal;
}

export function monitorAuthenticatedConnection(
  auth: AuthService,
  principal: AuthPrincipal,
  close: () => void,
  intervalMs = 1_000,
): () => void {
  let checking = false;
  let stopped = false;
  let timer: NodeJS.Timeout;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  timer = setInterval(() => {
    if (checking || stopped) return;
    checking = true;
    void auth
      .isPrincipalValid(principal)
      .then((valid) => {
        if (!valid) {
          stop();
          close();
        }
      })
      .finally(() => {
        checking = false;
      });
  }, intervalMs);
  timer.unref();
  return stop;
}
