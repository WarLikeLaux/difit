import type { RequestHandler } from 'express';

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
  const allowedHosts = new Set([
    ...LOCAL_HOSTS,
    ...additionalHosts.map((host) => host.trim().toLowerCase()).filter(Boolean),
  ]);

  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }

    let hostname: string;
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }

    if (!allowedHosts.has(hostname)) {
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
