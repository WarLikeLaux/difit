import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { AuthService } from '../dist/server/auth.js';
import { startHubServer } from '../dist/server/hub-server.js';
import { startServer } from '../dist/server/server.js';
import { createDiffSelection } from '../dist/utils/diffSelection.js';

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const root = await fs.mkdtemp(join(tmpdir(), 'difit-browser-security-'));
const configDirectory = join(root, 'config');
const repositoryPath = join(root, 'repo');
const keyPath = join(root, 'key.pem');
const certificatePath = join(root, 'certificate.pem');
process.env.DIFIT_CONFIG_DIR = configDirectory;

let viewerServer;
let hubServer;
let proxyServer;
let attackerServer;
let sameSiteAttackerServer;
let browser;

try {
  await fs.mkdir(repositoryPath);
  execFileSync('git', ['init', '--quiet'], { cwd: repositoryPath });
  execFileSync('git', ['config', 'user.email', 'security-test@example.invalid'], {
    cwd: repositoryPath,
  });
  execFileSync('git', ['config', 'user.name', 'Security Test'], { cwd: repositoryPath });
  await fs.writeFile(join(repositoryPath, 'example.txt'), 'before\n');
  execFileSync('git', ['add', '.'], { cwd: repositoryPath });
  execFileSync('git', ['commit', '--quiet', '-m', 'before'], { cwd: repositoryPath });
  await fs.writeFile(join(repositoryPath, 'example.txt'), 'after\n');
  execFileSync('git', ['add', '.'], { cwd: repositoryPath });
  execFileSync('git', ['commit', '--quiet', '-m', 'after'], { cwd: repositoryPath });

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=difit.test',
      '-addext',
      'subjectAltName=DNS:difit.test,DNS:attacker.test,DNS:sibling.difit.test',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdio: 'ignore' },
  );
  const tls = {
    key: await fs.readFile(keyPath),
    cert: await fs.readFile(certificatePath),
  };
  const publicKey = execFileSync('openssl', ['x509', '-in', certificatePath, '-pubkey', '-noout']);
  const publicKeyDer = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], {
    input: publicKey,
  });
  const certificateSpki = createHash('sha256').update(publicKeyDer).digest('base64');

  const auth = new AuthService({ configDirectory });
  const viewer = await startServer({
    authService: auth,
    host: '127.0.0.1',
    preferredPort: await availablePort(),
    repoPath: repositoryPath,
    selection: createDiffSelection('HEAD^', 'HEAD'),
    keepAlive: true,
  });
  viewerServer = viewer.server;

  const proxyPort = await availablePort();
  const hub = await startHubServer(await availablePort(), '127.0.0.1', {
    authService: auth,
    publicOrigin: `https://difit.test:${proxyPort}`,
  });
  hubServer = hub.server;
  proxyServer = createHttpsServer(tls, (request, response) => {
    const upstream = createHttpRequest(
      {
        hostname: '127.0.0.1',
        port: hub.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  await listen(proxyServer, proxyPort);

  const attackerHtml = '<!doctype html><title>attacker fixture</title><main>attacker</main>';
  const attackerPort = await availablePort();
  attackerServer = createHttpServer((_request, response) => response.end(attackerHtml));
  await listen(attackerServer, attackerPort);
  const sameSiteAttackerPort = await availablePort();
  sameSiteAttackerServer = createHttpsServer(tls, (_request, response) =>
    response.end(attackerHtml),
  );
  await listen(sameSiteAttackerServer, sameSiteAttackerPort);

  browser = await chromium.launch({
    headless: true,
    args: [
      '--host-resolver-rules=MAP difit.test 127.0.0.1,MAP attacker.test 127.0.0.1,MAP sibling.difit.test 127.0.0.1',
      `--ignore-certificate-errors-spki-list=${certificateSpki}`,
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(5_000);
  const origin = `https://difit.test:${proxyPort}`;
  const session = await auth.createBrowserSession(await auth.getAccessKey());
  if (!session) throw new Error('Could not create the synthetic browser session');
  await context.addCookies([
    {
      name: '__Host-difit_session',
      value: session,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    },
  ]);
  await page.goto(`${origin}/`);

  const secondTab = await context.newPage();
  await secondTab.goto(`${origin}/`);
  if (secondTab.url().includes('/auth/login')) throw new Error('A new tab required another login');

  const reviewsResponse = await fetch(`http://127.0.0.1:${hub.port}/api/reviews`, {
    headers: { Authorization: await auth.getCliAuthorizationHeader() },
  });
  const [review] = await reviewsResponse.json();
  if (!review?.id) throw new Error('Synthetic review registration was not visible');

  async function attemptCrossOriginClose(attackerUrl) {
    await page.goto(attackerUrl);
    await page.evaluate(
      ({ action }) => {
        const frame = document.createElement('iframe');
        frame.name = 'result';
        frame.hidden = true;
        document.body.append(frame);
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = action;
        form.target = frame.name;
        document.body.append(form);
        form.submit();
      },
      { action: `${origin}/api/reviews/${encodeURIComponent(review.id)}/close` },
    );
    await page.waitForTimeout(300);
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/reviews`, {
      headers: { Authorization: await auth.getCliAuthorizationHeader() },
    });
    const current = (await response.json()).find((candidate) => candidate.id === review.id);
    if (!current?.running) throw new Error(`Cross-origin form closed a review from ${attackerUrl}`);
  }

  await page.goto(`http://attacker.test:${attackerPort}/`);
  const crossOriginRead = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, { credentials: 'include' });
      return { readable: true, status: response.status };
    } catch {
      return { readable: false };
    }
  }, `${origin}/api/reviews`);
  if (crossOriginRead.readable) throw new Error('Cross-origin JavaScript read the protected API');
  await attemptCrossOriginClose(`http://attacker.test:${attackerPort}/`);
  await attemptCrossOriginClose(`https://sibling.difit.test:${sameSiteAttackerPort}/`);

  await page.goto(`http://attacker.test:${attackerPort}/`);
  await page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.append(frame);
  }, origin);
  await page.waitForTimeout(300);
  const embeddedFrame = page.frames().find((frame) => frame !== page.mainFrame());
  const embeddedText = embeddedFrame
    ? await embeddedFrame
        .locator('body')
        .innerText({ timeout: 500 })
        .catch(() => '')
    : '';
  if (/difit reviews|Enter the local access key/i.test(embeddedText)) {
    throw new Error('Difit was embedded by a foreign origin');
  }

  const directRead = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, { credentials: 'include' });
      return { readable: true, status: response.status };
    } catch {
      return { readable: false };
    }
  }, `http://127.0.0.1:${viewer.port}/api/diff`);
  if (directRead.readable) throw new Error('Foreign JavaScript read a direct viewer port');

  console.log(
    'Browser security check passed: cross-origin read/form/iframe and direct-port access blocked',
  );
} finally {
  await browser?.close();
  await close(sameSiteAttackerServer);
  await close(attackerServer);
  await close(proxyServer);
  await close(hubServer);
  await close(viewerServer);
  await fs.rm(root, { recursive: true, force: true });
}
