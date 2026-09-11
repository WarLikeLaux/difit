import { request as createHttpRequest, type Server } from 'http';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import express from 'express';

import type { DiffCommentThread } from '../types/diff.js';

import { readCommentSessions } from './comment-storage.js';
import { getReviewBranchState, type ReviewContext } from './review-context.js';
import { readReviewRegistrations, type ReviewRegistration } from './review-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HubReviewThread {
  id: string;
  filePath: string;
  line: number;
  status: 'open' | 'accepted' | 'to_verify' | 'ready' | 'resolved';
  updatedAt: string;
  lastAuthor?: string;
  lastMessage: string;
}

export interface HubReview {
  id: string;
  repositoryName: string;
  repositoryPath: string;
  branch?: string;
  baseRef: string;
  reviewUrl?: string;
  port: number;
  running: boolean;
  stale: boolean;
  currentBranch?: string;
  updatedAt: string;
  counts: Record<HubReviewThread['status'], number>;
  threads: HubReviewThread[];
  viewerUrl?: string;
}

interface HubServerOptions {
  terminateProcess?: (pid: number) => void;
}

function getThreadStatus(thread: DiffCommentThread): HubReviewThread['status'] {
  if (thread.resolvedAt) return 'resolved';
  if (thread.readyAt) return 'ready';
  if (thread.toVerifyAt) return 'to_verify';
  if (thread.acceptedAt) return 'accepted';
  return 'open';
}

function summarizeThread(thread: DiffCommentThread): HubReviewThread {
  const lastMessage = thread.messages.at(-1);
  const line =
    typeof thread.position.line === 'number' ? thread.position.line : thread.position.line.start;
  return {
    id: thread.id,
    filePath: thread.filePath,
    line,
    status: getThreadStatus(thread),
    updatedAt: thread.updatedAt,
    lastAuthor: lastMessage?.author,
    lastMessage: lastMessage?.body ?? '',
  };
}

function toReviewContext(registration: ReviewRegistration): ReviewContext {
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

async function isReviewServerRunning(registration: ReviewRegistration): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${registration.port}/api/review-context`, {
      signal: AbortSignal.timeout(350),
    });
    if (response.ok) {
      const data = (await response.json()) as { id?: unknown };
      return data.id === registration.id;
    }
    if (response.status !== 404 || !registration.reviewUrl) return false;

    const legacyResponse = await fetch(`http://127.0.0.1:${registration.port}/api/diff`, {
      signal: AbortSignal.timeout(350),
    });
    if (!legacyResponse.ok) return false;
    const legacyData = (await legacyResponse.json()) as { reviewUrl?: unknown };
    return legacyData.reviewUrl === registration.reviewUrl;
  } catch {
    return false;
  }
}

export async function getHubReviews(): Promise<HubReview[]> {
  const registrations = await readReviewRegistrations();
  const reviews = await Promise.all(
    registrations.map(async (registration): Promise<HubReview> => {
      const sessions = await readCommentSessions(registration.repositoryId);
      const threads = (sessions[registration.sessionKey]?.threads ?? [])
        .map(summarizeThread)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const branchState = await getReviewBranchState(toReviewContext(registration));
      const running = await isReviewServerRunning(registration);
      const counts: HubReview['counts'] = {
        open: 0,
        accepted: 0,
        to_verify: 0,
        ready: 0,
        resolved: 0,
      };
      for (const thread of threads) counts[thread.status] += 1;
      const latestThreadUpdate = threads[0]?.updatedAt;

      return {
        id: registration.id,
        repositoryName: basename(registration.repositoryPath),
        repositoryPath: registration.repositoryPath,
        branch: registration.branch,
        baseRef: registration.baseRef,
        reviewUrl: registration.reviewUrl,
        port: registration.port,
        running,
        stale: branchState.stale,
        currentBranch: branchState.currentBranch,
        updatedAt:
          latestThreadUpdate && latestThreadUpdate > registration.updatedAt
            ? latestThreadUpdate
            : registration.updatedAt,
        counts,
        threads,
        viewerUrl: running ? `/reviews/${encodeURIComponent(registration.id)}/` : undefined,
      };
    }),
  );

  return reviews.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const HUB_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
  <title>DIFIT</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0d1117;color:#e6edf3}
    *{box-sizing:border-box}body{margin:0;background:#0d1117}header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid #30363d;background:#161b22}h1{font-size:18px;margin:0}.muted{color:#8b949e}.layout{max-width:1440px;margin:0 auto;padding:24px}.toolbar{display:flex;gap:8px;margin-bottom:18px}.toolbar button{border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:6px;padding:7px 12px;cursor:pointer}.toolbar button.active{border-color:#2f81f7;color:#fff}.review{border:1px solid #30363d;background:#161b22;border-radius:8px;margin-bottom:16px;overflow:hidden}.review-head{display:flex;gap:14px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #30363d}.review-title{min-width:0}.review-title strong,.review-title code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.review-title code{font-size:12px;color:#8b949e;margin-top:4px}.badges{display:flex;flex-wrap:wrap;gap:6px}.badge{border:1px solid #30363d;border-radius:999px;padding:3px 8px;font-size:12px}.running{color:#3fb950}.stopped{color:#8b949e}.stale{color:#f85149}.open{color:#f2cc60}.accepted{color:#58a6ff}.to_verify{color:#bc8cff}.ready{color:#3fb950}.threads{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:1px;background:#30363d}.thread{background:#0d1117;padding:12px 16px;min-width:0}.thread-top{display:flex;justify-content:space-between;gap:12px;font-size:12px}.thread-path{font-family:ui-monospace,monospace;color:#58a6ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.message{font-size:13px;line-height:1.45;margin-top:8px;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.actions{display:flex;gap:8px;flex-shrink:0}.actions a,.actions button{border:1px solid #30363d;background:transparent;border-radius:6px;color:#e6edf3;text-decoration:none;padding:7px 10px;font:inherit;font-size:12px;cursor:pointer}.actions .close-viewer{border-color:#6e3035;color:#ff7b72}.actions .close-viewer:hover{background:#3d1f24;border-color:#f85149}.actions button:disabled{cursor:wait;opacity:.55}.empty{padding:36px;text-align:center;color:#8b949e}@media(max-width:700px){.layout{padding:12px}.review-head{align-items:flex-start;flex-direction:column}.threads{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header><h1>↪ difit reviews</h1><span id="summary" class="muted">Loading…</span></header>
  <main class="layout"><div class="toolbar"><button data-filter="active" class="active">Active</button><button data-filter="all">All</button></div><div id="reviews"></div></main>
  <script>
    const root=document.getElementById('reviews');const summary=document.getElementById('summary');let reviews=[];let filter='active';
    const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const active=(review)=>review.running||review.threads.some((thread)=>thread.status!=='resolved');
    function render(){const shown=reviews.filter((review)=>filter==='all'||active(review));summary.textContent=reviews.filter(active).length+' active · '+reviews.length+' total';if(!shown.length){root.innerHTML='<div class="empty">No reviews yet. Start difit in a Git checkout.</div>';return}root.innerHTML=shown.map((review)=>{const state=review.stale?'stale':review.running?'running':'stopped';const threads=review.threads.filter((thread)=>filter==='all'||thread.status!=='resolved');return '<section class="review"><div class="review-head"><div class="review-title"><strong>'+esc(review.repositoryName)+' · '+esc(review.branch||'snapshot')+'</strong><code>'+esc(review.repositoryPath)+' · base '+esc(review.baseRef)+'</code></div><div class="actions">'+(review.viewerUrl?'<a href="'+esc(review.viewerUrl)+'">Open review</a>':'')+(review.reviewUrl?'<a href="'+esc(review.reviewUrl)+'" target="_blank" rel="noreferrer">Open MR</a>':'')+(review.running?'<button type="button" class="close-viewer" data-close-review="'+esc(review.id)+'">⏻ Close viewer</button>':'')+'</div><div class="badges"><span class="badge '+state+'">'+state+'</span><span class="badge open">Open '+review.counts.open+'</span><span class="badge accepted">Accepted '+review.counts.accepted+'</span><span class="badge to_verify">To verify '+review.counts.to_verify+'</span><span class="badge ready">Ready '+review.counts.ready+'</span></div></div>'+(threads.length?'<div class="threads">'+threads.map((thread)=>'<article class="thread"><div class="thread-top"><span class="thread-path">'+esc(thread.filePath)+':'+thread.line+'</span><span class="'+thread.status+'">'+esc(thread.status.replace('_',' '))+'</span></div><div class="message"><span class="muted">'+esc(thread.lastAuthor||'Unknown')+':</span> '+esc(thread.lastMessage)+'</div></article>').join('')+'</div>':'<div class="empty">No active threads</div>')+'</section>'}).join('')}
    async function refresh(){try{const response=await fetch('/api/reviews');reviews=await response.json();render()}catch{summary.textContent='Hub unavailable'}}
    document.querySelectorAll('[data-filter]').forEach((button)=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach((item)=>item.classList.toggle('active',item===button));render()}));
    root.addEventListener('click',async(event)=>{const button=event.target.closest('[data-close-review]');if(!button||!confirm('Close this viewer? Review history and comments will remain available.'))return;button.disabled=true;button.textContent='Closing…';try{const response=await fetch('/api/reviews/'+encodeURIComponent(button.dataset.closeReview)+'/close',{method:'POST'});if(!response.ok)throw new Error();await refresh()}catch{button.disabled=false;button.textContent='⏻ Close viewer';alert('Could not close the viewer. It may already be stopped.')}});
    const events=new EventSource('/api/events');events.onmessage=refresh;events.onerror=()=>{};refresh();
  </script>
</body>
</html>`;

export async function startHubServer(
  preferredPort = 4965,
  host = '127.0.0.1',
  options: HubServerOptions = {},
): Promise<{ port: number; url: string; server: Server }> {
  const app = express();
  app.enable('strict routing');
  const clients = new Set<import('express').Response>();

  app.get('/api/reviews', async (_req, res) => {
    res.json(await getHubReviews());
  });
  app.post('/api/reviews/:reviewId/close', async (req, res) => {
    const registration = (await readReviewRegistrations()).find(
      (candidate) => candidate.id === req.params.reviewId,
    );
    if (!registration) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    if (!(await isReviewServerRunning(registration))) {
      res.status(409).json({ error: 'Review viewer is not running' });
      return;
    }

    try {
      (options.terminateProcess ?? ((pid: number) => process.kill(pid, 'SIGTERM')))(
        registration.pid,
      );
      res.json({ success: true });
    } catch {
      res.status(409).json({ error: 'Review viewer could not be stopped' });
    }
  });
  app.get('/api/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.add(res);
    res.write('data: ready\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });
  app.get('/favicon.svg', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'client', 'favicon.svg'));
  });
  app.get('/reviews/:reviewId', (req, res) => {
    res.redirect(308, `/reviews/${encodeURIComponent(req.params.reviewId)}/`);
  });
  app.use('/reviews/:reviewId', async (req, res) => {
    const registration = (await readReviewRegistrations()).find(
      (candidate) => candidate.id === req.params.reviewId,
    );
    if (!registration) {
      res.status(404).send('Review not found');
      return;
    }

    const prefix = `/reviews/${encodeURIComponent(registration.id)}`;
    const upstreamPath = req.originalUrl.slice(prefix.length) || '/';
    const headers = { ...req.headers, host: `127.0.0.1:${registration.port}` };
    const upstream = createHttpRequest(
      {
        hostname: '127.0.0.1',
        port: registration.port,
        method: req.method,
        path: upstreamPath,
        headers,
      },
      (upstreamResponse) => {
        res.status(upstreamResponse.statusCode ?? 502);
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined) res.setHeader(name, value);
        }
        res.setHeader('X-Difit-Review-Label', registration.branch ?? 'Snapshot');
        upstreamResponse.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).send('Review server unavailable');
      else res.end();
    });
    req.pipe(upstream);
  });
  app.get('/', (_req, res) => res.type('html').send(HUB_HTML));

  const refreshTimer = setInterval(() => {
    for (const client of clients) client.write(`data: ${Date.now()}\n\n`);
  }, 2_000);

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(preferredPort, host, () => resolve(instance));
    instance.once('error', reject);
  });
  server.on('close', () => clearInterval(refreshTimer));
  return { port: preferredPort, url: `http://${host}:${preferredPort}`, server };
}
