import type { RequestHandler } from 'express';
import { randomBytes } from 'node:crypto';

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

export function restrictRequestOrigins(additionalHosts: readonly string[] = []): RequestHandler {
  const allowedProxyHosts = new Set(
    additionalHosts.map((host) => host.trim().toLowerCase()).filter(Boolean),
  );

  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }

    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }

    const requestHost = req.get('host')?.trim().toLowerCase();
    if (originHost !== requestHost && !allowedProxyHosts.has(originHost)) {
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

const VIEWER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join('; ');

export function setSecurityHeaders(options: { nonceInlineScript?: boolean } = {}): RequestHandler {
  return (_req, res, next) => {
    const nonce = options.nonceInlineScript ? randomBytes(18).toString('base64') : undefined;
    const contentSecurityPolicy = nonce
      ? VIEWER_CONTENT_SECURITY_POLICY.replace(
          "script-src 'self'",
          `script-src 'self' 'nonce-${nonce}'`,
        )
      : VIEWER_CONTENT_SECURITY_POLICY;
    if (nonce) res.locals.cspNonce = nonce;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  };
}
