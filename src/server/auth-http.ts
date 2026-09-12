import type { Express, RequestHandler } from 'express';

import { type AuthService, getAuthenticatedPrincipal } from './auth.js';

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in · difit</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:14px system-ui,sans-serif}.card{width:min(420px,calc(100vw - 32px));padding:28px;border:1px solid #30363d;border-radius:10px;background:#161b22}.logo{font-size:22px;font-weight:700;margin-bottom:8px}.muted{color:#8b949e;line-height:1.5}.error{color:#ff7b72;margin:14px 0}label{display:block;margin:20px 0 8px;font-weight:600}input{width:100%;padding:11px 12px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#e6edf3;font:14px ui-monospace,monospace}button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:6px;background:#238636;color:#fff;font-weight:700;cursor:pointer}code{color:#79c0ff}
  </style>
</head>
<body><main class="card"><div class="logo">↪ difit</div><p class="muted">Enter the local access key. Retrieve it explicitly with <code>difit auth key</code>.</p>{{ERROR}}<form method="post" action="/auth/login"><label for="accessKey">Access key</label><input id="accessKey" name="accessKey" type="password" autocomplete="current-password" required maxlength="512" autofocus /><button type="submit">Sign in for 30 days</button></form></main></body>
</html>`;

export function installBrowserLoginRoutes(
  app: Express,
  auth: AuthService,
  publicOrigin: URL | undefined,
): void {
  const browserLoginEnabled = publicOrigin?.protocol === 'https:';

  app.get('/auth/login', async (req, res) => {
    if (!browserLoginEnabled) {
      res.status(404).type('text/plain').send('Browser login requires an HTTPS public origin.');
      return;
    }
    if (await auth.authenticateRequest(req)) {
      res.redirect(303, '/');
      return;
    }
    res.type('html').send(LOGIN_HTML.replace('{{ERROR}}', ''));
  });

  app.post('/auth/login', async (req, res) => {
    if (!browserLoginEnabled || req.get('origin') !== publicOrigin.origin) {
      res.status(403).json({ error: 'Browser login requires the configured HTTPS origin' });
      return;
    }
    const accessKey = (req.body as { accessKey?: unknown } | undefined)?.accessKey;
    if (typeof accessKey !== 'string' || accessKey.length > 512) {
      res
        .status(400)
        .type('html')
        .send(LOGIN_HTML.replace('{{ERROR}}', '<p class="error">Invalid access key.</p>'));
      return;
    }
    const sessionToken = await auth.createBrowserSession(accessKey);
    if (!sessionToken) {
      res
        .status(401)
        .type('html')
        .send(LOGIN_HTML.replace('{{ERROR}}', '<p class="error">Invalid access key.</p>'));
      return;
    }
    res.setHeader('Set-Cookie', auth.createSessionCookie(sessionToken));
    res.redirect(303, '/');
  });
}

export function logoutHandler(auth: AuthService): RequestHandler {
  return async (_req, res) => {
    const principal = getAuthenticatedPrincipal(res.locals as Record<string, unknown>);
    await auth.revokeBrowserSession(principal);
    res.setHeader('Set-Cookie', auth.createExpiredSessionCookie());
    res.setHeader('Clear-Site-Data', '"cache", "cookies"');
    res.redirect(303, '/auth/login');
  };
}
