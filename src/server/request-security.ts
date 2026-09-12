import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function restrictRequestHosts(additionalHosts: readonly string[] = []): RequestHandler {
  const allowedHosts = new Set([
    ...LOCAL_HOSTS,
    ...additionalHosts.map((host) => host.trim().toLowerCase()).filter(Boolean),
  ]);

  return (req, res, next) => {
    if (!allowedHosts.has(req.hostname.toLowerCase())) {
      res.status(403).json({ error: 'Host is not allowed' });
      return;
    }
    next();
  };
}

function normalizeHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported trusted origin protocol: ${url.protocol}`);
  }
  return url.origin;
}

export function restrictRequestOrigins(
  additionalOrigins: readonly string[] = [],
  allowRequestOrigin = true,
): RequestHandler {
  const allowedProxyOrigins = new Set(additionalOrigins.map(normalizeHttpOrigin));

  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }

    let parsedOrigin: string;
    try {
      parsedOrigin = normalizeHttpOrigin(origin);
    } catch {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }

    const requestHost = req.get('host');
    const requestOrigin = requestHost
      ? normalizeHttpOrigin(`${req.protocol}://${requestHost}`)
      : undefined;
    if (
      (!allowRequestOrigin || parsedOrigin !== requestOrigin) &&
      !allowedProxyOrigins.has(parsedOrigin)
    ) {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }

    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  };
}

export function restrictCrossSiteBrowserRequests(): RequestHandler {
  return (req, res, next) => {
    const fetchSite = req.get('sec-fetch-site')?.toLowerCase();
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      res.status(403).json({ error: 'Cross-site browser requests are not allowed' });
      return;
    }
    next();
  };
}

export function setSecurityHeaders(options: { nonceInlineScript?: boolean } = {}): RequestHandler {
  const scriptSrc: Array<string | ((req: IncomingMessage, res: ServerResponse) => string)> = [
    "'self'",
  ];
  if (options.nonceInlineScript) {
    scriptSrc.push(
      (_req, res) =>
        `'nonce-${(res as ServerResponse & { locals?: { cspNonce?: string } }).locals?.cspNonce ?? ''}'`,
    );
  }

  const securityHeaders = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        objectSrc: ["'none'"],
        scriptSrc,
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    originAgentCluster: true,
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: false,
    xFrameOptions: { action: 'deny' },
  });

  return (req, res, next) => {
    const nonce = options.nonceInlineScript ? randomBytes(18).toString('base64') : undefined;
    if (nonce) res.locals.cspNonce = nonce;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    securityHeaders(req, res, next);
  };
}
