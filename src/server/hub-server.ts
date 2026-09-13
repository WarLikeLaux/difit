import { request as createHttpRequest, type Server } from 'http';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import express, { type Request, type Response } from 'express';

import type { DiffCommentThread } from '../types/diff.js';

import {
  type AuthService,
  getAuthenticatedPrincipal,
  getDefaultAuthService,
  monitorAuthenticatedConnection,
  requireAuthentication,
  requireBrowserMutationOrigin,
} from './auth.js';
import { installBrowserLoginRoutes, logoutHandler } from './auth-http.js';
import {
  deleteCommentSession,
  readCommentSessions,
  writeCommentSessions,
} from './comment-storage.js';
import {
  AgentEventInbox,
  deleteAgentEventInbox,
  getPendingAgentEventCount,
} from './agent-event-inbox.js';
import { getReviewBranchState, type ReviewContext } from './review-context.js';
import {
  deleteReviewRegistration,
  readReviewRegistrations,
  type ReviewRegistration,
} from './review-registry.js';
import { deleteReviewSnapshot, readReviewSnapshot } from './review-snapshot.js';
import {
  restrictCrossSiteBrowserRequests,
  restrictRequestHosts,
  restrictRequestOrigins,
  setSecurityHeaders,
} from './request-security.js';
import { mergeCommentThreads } from '../utils/commentImports.js';
import { parseUserSettingsPatch, readUserConfig, updateUserClientSettings } from './user-config.js';

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
  targetRef: string;
  reviewUrl?: string;
  port: number;
  followsBranch: boolean;
  running: boolean;
  stale: boolean;
  currentBranch?: string;
  updatedAt: string;
  counts: Record<HubReviewThread['status'], number>;
  threads: HubReviewThread[];
  viewerUrl?: string;
  available: boolean;
  agentConnected: boolean;
  pendingMessages: number;
  kind: 'working-tree' | 'merge-request' | 'commit';
  label: string;
}

export interface HubServerOptions {
  terminateProcess?: (pid: number) => void;
  publicOrigin?: string;
  authService?: AuthService;
}

function getReviewKind(registration: ReviewRegistration): Pick<HubReview, 'kind' | 'label'> {
  if (registration.reviewUrl) {
    return { kind: 'merge-request', label: registration.branch ?? 'Merge request' };
  }
  if (registration.followsBranch) {
    return { kind: 'working-tree', label: registration.branch ?? 'Working tree' };
  }
  return {
    kind: 'commit',
    label: `Commit ${registration.targetRef.replace(/\^$/, '').slice(0, 7)}`,
  };
}

function normalizeExternalReviewUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
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
    updatedAt: lastMessage?.updatedAt ?? thread.updatedAt,
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
    reviewUrl: normalizeExternalReviewUrl(registration.reviewUrl),
    followsBranch: registration.followsBranch,
    initialHead: registration.initialHead,
    legacySessionKeys: [],
  };
}

async function isReviewServerRunning(
  registration: ReviewRegistration,
  auth = getDefaultAuthService(),
): Promise<boolean> {
  const authorization = await auth.getCliAuthorizationHeader();

  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    try {
      const response = await fetch(`http://${host}:${registration.port}/api/review-context`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(350),
      });
      if (response.ok) {
        const data = (await response.json()) as { id?: unknown };
        if (data.id === registration.id) return true;
        continue;
      }
      if (response.status !== 404 || !registration.reviewUrl) continue;

      const legacyResponse = await fetch(`http://${host}:${registration.port}/api/diff`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(350),
      });
      if (!legacyResponse.ok) continue;
      const legacyData = (await legacyResponse.json()) as { reviewUrl?: unknown };
      if (legacyData.reviewUrl === registration.reviewUrl) return true;
    } catch {
      // The viewer may be listening on another loopback address family.
    }
  }

  return false;
}

export async function getHubReviews(auth = getDefaultAuthService()): Promise<HubReview[]> {
  const registrations = await readReviewRegistrations();
  const reviews = await Promise.all(
    registrations.map(async (registration): Promise<HubReview> => {
      const [sessions, pendingMessages, snapshot] = await Promise.all([
        readCommentSessions(registration.repositoryId),
        getPendingAgentEventCount(registration.id),
        readReviewSnapshot(registration.id),
      ]);
      const threads = (sessions[registration.sessionKey]?.threads ?? [])
        .map(summarizeThread)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const branchState = await getReviewBranchState(toReviewContext(registration));
      const running = await isReviewServerRunning(registration, auth);
      const { kind, label } = getReviewKind(registration);
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
        targetRef: registration.targetRef,
        reviewUrl: normalizeExternalReviewUrl(registration.reviewUrl),
        port: registration.port,
        followsBranch: registration.followsBranch,
        running,
        stale: branchState.stale,
        currentBranch: branchState.currentBranch,
        updatedAt: latestThreadUpdate ?? registration.startedAt,
        counts,
        threads,
        viewerUrl:
          running || snapshot ? `/reviews/${encodeURIComponent(registration.id)}/` : undefined,
        available: Boolean(running || snapshot),
        agentConnected: Boolean(running && registration.agentAttached && !branchState.stale),
        pendingMessages,
        kind,
        label,
      };
    }),
  );

  return reviews.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function readJsonBody(req: Request): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 1_000_000) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as unknown) : {};
}

function archivedSessionEpoch(reviewId: string): string {
  return `archived:${reviewId}`;
}

async function readArchivedCommentSession(registration: ReviewRegistration) {
  const sessions = await readCommentSessions(registration.repositoryId);
  return {
    sessions,
    session: sessions[registration.sessionKey] ?? { threads: [], version: 0 },
  };
}

async function storeArchivedComments(
  registration: ReviewRegistration,
  nextThreads: DiffCommentThread[],
): Promise<{ threads: DiffCommentThread[]; version: number }> {
  const { sessions, session } = await readArchivedCommentSession(registration);
  const nextSession = {
    threads: structuredClone(nextThreads),
    version: session.version + 1,
  };
  sessions[registration.sessionKey] = nextSession;
  await writeCommentSessions(registration.repositoryId, new Map(Object.entries(sessions)));

  const inbox = new AgentEventInbox({
    reviewId: registration.id,
    port: registration.port,
  });
  await inbox.initialize();
  await inbox.recordChanges(session.threads, nextSession.threads);
  await inbox.flush();
  inbox.dispose();
  return nextSession;
}

function openEventStream(req: Request, res: Response, initialData: unknown): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(initialData)}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  req.on('close', () => clearInterval(heartbeat));
}

const HUB_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
  <title>DIFIT</title>
  <style>
    :root{color-scheme:dark;font-family:"IBM Plex Sans",Inter,ui-sans-serif,system-ui,sans-serif;background:#0b0f14;color:#e6edf3;--canvas:#0b0f14;--surface:#11171f;--surface-raised:#151d27;--line:#27313d;--quiet:#7d8998;--text:#e6edf3;--blue:#58a6ff;--green:#4ac26b;--amber:#d9a441;--red:#ff7b72}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas)}button,a{font:inherit}header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:15px max(20px,calc((100vw - 1180px)/2));border-bottom:1px solid var(--line);background:rgba(17,23,31,.94);backdrop-filter:blur(12px)}h1{font-size:17px;letter-spacing:-.02em;margin:0}.top-actions{display:flex;align-items:center;gap:14px}.logout{border:0;background:transparent;color:var(--quiet);padding:7px 0;cursor:pointer}.logout:hover,.logout:focus-visible{color:var(--text)}.muted{color:var(--quiet)}.layout{max-width:1180px;margin:0 auto;padding:34px 20px 60px}.review-group{margin-bottom:38px}.all-reviews{border-top:1px solid var(--line);padding-top:26px}.group-head{display:flex;align-items:baseline;gap:9px;margin:0 0 14px}.group-title{font-size:17px;letter-spacing:-.015em;font-weight:650;margin:0}.group-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;padding:0 7px;border-radius:10px;background:#1b2531;color:#9aa7b6;font-size:12px}.connection-empty{color:var(--quiet);padding:5px 0 2px}.review-list{display:grid;gap:12px}.review{position:relative;border:1px solid var(--line);background:var(--surface);border-radius:10px;overflow:hidden}.review:hover{border-color:#384657}.review-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px 28px;align-items:start;padding:18px 20px}.review-title{min-width:0}.title-line{display:flex;align-items:center;gap:9px;min-width:0}.review-title strong{font-size:17px;letter-spacing:-.015em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.connection{display:inline-flex;align-items:center;gap:6px;color:var(--quiet);font-size:12px;white-space:nowrap}.connection:before{content:"";width:7px;height:7px;border-radius:50%;background:#596575}.connection.connected{color:#79d58f}.connection.connected:before{background:var(--green);box-shadow:0 0 0 3px rgba(74,194,107,.12)}.review-label{display:block;color:#b4bfcb;font-size:13px;margin-top:5px}.review-meta{display:flex;align-items:center;gap:10px;margin-top:12px;color:var(--quiet);font-size:12px}.review-meta .waiting{color:#e6bd68}.stats{display:flex;flex-wrap:wrap;gap:13px;margin-top:13px;color:var(--quiet);font-size:12px}.stat strong{color:#c8d1dc;font-weight:600}.stat.open strong{color:#e6bd68}.stat.ready strong{color:#79d58f}.actions{display:flex;align-items:center;gap:8px;justify-self:end}.actions a,.actions button{border:1px solid var(--line);background:transparent;border-radius:7px;color:#cdd6e0;text-decoration:none;padding:7px 10px;font-size:12px;cursor:pointer}.actions .primary{border-color:#316dca;background:#1f6feb;color:#fff}.actions a:hover,.actions a:focus-visible,.actions button:hover,.actions button:focus-visible{border-color:#5b6b7e;outline:none}.actions .primary:hover,.actions .primary:focus-visible{background:#2f81f7;border-color:#58a6ff}.actions .delete-review{border-color:transparent;color:var(--quiet);padding-inline:5px}.actions .delete-review:hover,.actions .delete-review:focus-visible{color:var(--red);border-color:transparent}.actions button:disabled{cursor:wait;opacity:.55}.unavailable{align-self:center;color:var(--quiet);font-size:12px}.threads{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1px;background:var(--line);border-top:1px solid var(--line)}.thread{background:var(--canvas);padding:13px 20px;min-width:0}.thread-top{display:flex;justify-content:space-between;gap:12px;font-size:12px}.thread-path{font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--blue);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.thread-status{color:var(--quiet)}.thread-status.open{color:#e6bd68}.thread-status.accepted{color:#74b7ff}.thread-status.to_verify{color:#c8a7ff}.thread-status.ready{color:#79d58f}.message{font-size:13px;line-height:1.5;margin-top:7px;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.empty{padding:34px 0;color:var(--quiet)}@media(max-width:700px){header{padding:13px 16px}.layout{padding:24px 14px 44px}.review-head{grid-template-columns:1fr;padding:16px}.actions{justify-self:start;flex-wrap:wrap}.threads{grid-template-columns:1fr}.top-actions{gap:10px}.review-group{margin-bottom:30px}}
  </style>
</head>
<body>
  <header><h1>↪ difit reviews</h1><div class="top-actions"><span id="summary" class="muted">Loading…</span><form method="post" action="/auth/logout"><button class="logout" type="submit">Log out</button></form></div></header>
  <main class="layout"><div id="reviews"></div></main>
  <script>
    const root=document.getElementById('reviews');const summary=document.getElementById('summary');let reviews=[];
    const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const kindLabel=(review)=>review.kind==='working-tree'?'Working tree on '+review.label:review.kind==='merge-request'?'Merge request '+review.label:review.label;
    const relativeTime=(value)=>{const seconds=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/1000));if(seconds<60)return'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';if(seconds<604800)return Math.floor(seconds/86400)+'d ago';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value))};
    const stats=(review)=>[['open','Open'],['accepted','Accepted'],['to_verify','To verify'],['ready','Ready']].filter(([key])=>review.counts[key]>0).map(([key,label])=>'<span class="stat '+key+'"><strong>'+review.counts[key]+'</strong> '+label+'</span>').join('')||'<span>No comments</span>';
    function reviewCard(review,includeResolved=false){const threads=review.threads.filter((thread)=>includeResolved||thread.status!=='resolved');const timeLabel=review.threads.length?'Last reply ':'Added ';return '<article class="review"><div class="review-head"><div class="review-title"><div class="title-line"><strong>'+esc(review.repositoryName)+'</strong><span class="connection '+(review.agentConnected?'connected':'')+'">'+(review.agentConnected?'Connected':'Offline')+'</span></div><span class="review-label">'+esc(kindLabel(review))+'</span><div class="review-meta"><time datetime="'+esc(review.updatedAt)+'" title="'+esc(new Date(review.updatedAt).toLocaleString())+'">'+timeLabel+relativeTime(review.updatedAt)+'</time>'+(review.pendingMessages?'<span class="waiting">'+review.pendingMessages+' waiting</span>':'')+'</div><div class="stats">'+stats(review)+'</div></div><div class="actions">'+(review.viewerUrl?'<a class="primary" href="'+esc(review.viewerUrl)+'">Open review</a>':'<span class="unavailable">Snapshot unavailable</span>')+(review.reviewUrl?'<a href="'+esc(review.reviewUrl)+'" target="_blank" rel="noreferrer">Open MR</a>':'')+'<button type="button" class="delete-review" data-delete-review="'+esc(review.id)+'">Delete</button></div></div>'+(threads.length?'<div class="threads">'+threads.map((thread)=>'<div class="thread"><div class="thread-top"><span class="thread-path">'+esc(thread.filePath)+':'+thread.line+'</span><span class="thread-status '+thread.status+'">'+esc(thread.status.replace('_',' '))+'</span></div><div class="message"><span class="muted">'+esc(thread.lastAuthor||'Unknown')+':</span> '+esc(thread.lastMessage)+'</div></div>').join('')+'</div>':'')+'</article>'}
    function group(title,items,className='review-group'){return '<section class="'+className+'"><div class="group-head"><h2 class="group-title">'+title+'</h2><span class="group-count">'+items.length+'</span></div><div class="review-list">'+items.map((review)=>reviewCard(review)).join('')+'</div></section>'}
    function render(){const sorted=[...reviews].sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt));const connected=sorted.filter((review)=>review.agentConnected);const waitingReviews=sorted.filter((review)=>!review.agentConnected&&review.pendingMessages>0);const waiting=waitingReviews.reduce((count,review)=>count+review.pendingMessages,0);summary.textContent=connected.length+' connected'+(waiting?' / '+waiting+' waiting':'');if(!sorted.length){root.innerHTML='<div class="empty">No reviews yet. Attach a Git checkout with difit.</div>';return}const connectedContent=connected.length?group('Connected now',connected):'<section class="review-group"><div class="group-head"><h2 class="group-title">Connected now</h2><span class="group-count">0</span></div><div class="connection-empty">No agents connected. Saved reviews are available below.</div></section>';const waitingContent=waitingReviews.length?group('Waiting for agent',waitingReviews):'';root.innerHTML=connectedContent+waitingContent+group('All reviews',sorted,'all-reviews')}
    async function refresh(){try{const response=await fetch('/api/reviews');reviews=await response.json();render()}catch{summary.textContent='Hub unavailable'}}
    root.addEventListener('click',async(event)=>{const button=event.target.closest('[data-delete-review]');if(!button||!confirm('Delete this review, its comments, and queued messages? This cannot be undone.'))return;button.disabled=true;button.textContent='Deleting…';try{const response=await fetch('/api/reviews/'+encodeURIComponent(button.dataset.deleteReview),{method:'DELETE'});if(!response.ok)throw new Error();await refresh()}catch{button.disabled=false;button.textContent='Delete review';alert('Could not delete the review.')}});
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
  const auth = options.authService ?? getDefaultAuthService();
  await auth.initialize();
  app.enable('strict routing');
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (publicOrigin && publicOrigin.protocol !== 'http:' && publicOrigin.protocol !== 'https:') {
    throw new Error(`Unsupported public origin protocol: ${publicOrigin.protocol}`);
  }
  if (publicOrigin) await auth.configurePublicOrigin(publicOrigin.origin);
  app.use(restrictRequestHosts([host, ...(publicOrigin ? [publicOrigin.hostname] : [])]));
  app.use(
    restrictRequestOrigins(publicOrigin ? [publicOrigin.origin] : [], publicOrigin === undefined),
  );
  app.use(restrictCrossSiteBrowserRequests());
  app.use(setSecurityHeaders({ nonceInlineScript: true }));
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  installBrowserLoginRoutes(app, auth, publicOrigin);
  app.use(
    requireAuthentication(auth, {
      ...(publicOrigin?.protocol === 'https:' ? { loginPath: '/auth/login' } : {}),
    }),
  );
  app.use(requireBrowserMutationOrigin());
  app.post('/auth/logout', logoutHandler(auth));
  const clients = new Set<import('express').Response>();
  const archivedWatchClients = new Map<string, Set<Response>>();
  const archivedWriteQueues = new Map<string, Promise<void>>();
  const withArchivedWriteLock = async <T>(reviewId: string, operation: () => Promise<T>) => {
    const previous = archivedWriteQueues.get(reviewId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    archivedWriteQueues.set(reviewId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (archivedWriteQueues.get(reviewId) === queued) archivedWriteQueues.delete(reviewId);
    }
  };
  const broadcastArchivedComments = (reviewId: string, version: number) => {
    const event = JSON.stringify({
      type: 'commentsChanged',
      version,
      timestamp: new Date().toISOString(),
    });
    for (const client of archivedWatchClients.get(reviewId) ?? []) {
      client.write(`data: ${event}\n\n`);
    }
  };

  app.get('/api/reviews', async (_req, res) => {
    res.json(await getHubReviews(auth));
  });
  app.post('/api/reviews/:reviewId/close', async (req, res) => {
    const registration = (await readReviewRegistrations()).find(
      (candidate) => candidate.id === req.params.reviewId,
    );
    if (!registration) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    if (!(await isReviewServerRunning(registration, auth))) {
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
  app.delete('/api/reviews/:reviewId', async (req, res) => {
    const registration = (await readReviewRegistrations()).find(
      (candidate) => candidate.id === req.params.reviewId,
    );
    if (!registration) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    if (await isReviewServerRunning(registration, auth)) {
      try {
        (options.terminateProcess ?? ((pid: number) => process.kill(pid, 'SIGTERM')))(
          registration.pid,
        );
      } catch {
        res.status(409).json({ error: 'Review viewer could not be stopped before deletion' });
        return;
      }
    }

    await Promise.all([
      deleteReviewRegistration(registration.id),
      deleteReviewSnapshot(registration.id),
      deleteAgentEventInbox(registration.id),
      deleteCommentSession(registration.repositoryId, registration.sessionKey),
    ]);
    res.json({ success: true, reviewId: registration.id });
  });
  app.get('/api/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.add(res);
    res.write('data: ready\n\n');
    const stopAuthMonitor = monitorAuthenticatedConnection(
      auth,
      getAuthenticatedPrincipal(res.locals as Record<string, unknown>),
      () => res.end(),
    );
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    res.on('close', () => {
      stopAuthMonitor();
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

    if (await isReviewServerRunning(registration, auth)) {
      const prefix = `/reviews/${encodeURIComponent(registration.id)}`;
      const upstreamPath = req.originalUrl.slice(prefix.length) || '/';
      const upstreamOrigin = `http://127.0.0.1:${registration.port}`;
      const headers = {
        ...req.headers,
        host: `127.0.0.1:${registration.port}`,
        ...(req.get('origin') ? { origin: upstreamOrigin } : {}),
      };
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
      return;
    }

    const requestPath = req.url.split('?')[0] ?? '/';
    const snapshot = await readReviewSnapshot(registration.id);
    if (!snapshot) {
      res.status(503).send('This review has no saved snapshot yet. Reattach an agent once.');
      return;
    }

    if (req.method === 'GET' && requestPath === '/api/diff') {
      res.json({ ...snapshot, openInEditorAvailable: false, reviewStale: false });
      return;
    }
    if (req.method === 'GET' && requestPath === '/api/comments-json') {
      const { session } = await readArchivedCommentSession(registration);
      res.json({
        sessionEpoch: archivedSessionEpoch(registration.id),
        version: session.version,
        threads: session.threads,
      });
      return;
    }
    if (req.method === 'POST' && requestPath === '/api/comments') {
      try {
        const body = (await readJsonBody(req)) as {
          threads?: unknown;
          baseVersion?: unknown;
          sessionEpoch?: unknown;
        };
        if (!Array.isArray(body.threads)) throw new Error('Invalid comments payload');
        const result = await withArchivedWriteLock(registration.id, async () => {
          const { session } = await readArchivedCommentSession(registration);
          if (body.sessionEpoch !== archivedSessionEpoch(registration.id)) {
            return { staleClient: true as const, session };
          }
          const incoming = body.threads as DiffCommentThread[];
          const threads =
            typeof body.baseVersion === 'number' && body.baseVersion !== session.version
              ? mergeCommentThreads(session.threads, incoming).threads
              : incoming;
          const stored = await storeArchivedComments(registration, threads);
          broadcastArchivedComments(registration.id, stored.version);
          return { staleClient: false as const, session: stored };
        });
        if (result.staleClient) {
          res.status(409).json({
            success: false,
            staleClient: true,
            sessionEpoch: archivedSessionEpoch(registration.id),
            version: result.session.version,
            threads: result.session.threads,
          });
          return;
        }
        res.json({
          success: true,
          sessionEpoch: archivedSessionEpoch(registration.id),
          version: result.session.version,
          threads: result.session.threads,
        });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Invalid comments payload',
        });
      }
      return;
    }
    if (req.method === 'GET' && requestPath === '/api/revisions') {
      res.json({
        specialOptions: [],
        branches: [],
        commits: [],
        resolvedBase: snapshot.baseCommitish,
        resolvedTarget: snapshot.targetCommitish,
      });
      return;
    }
    if (req.method === 'GET' && requestPath.startsWith('/api/generated-status/')) {
      res.json({ path: requestPath.slice('/api/generated-status/'.length), isGenerated: false });
      return;
    }
    if (req.method === 'GET' && requestPath === '/api/user-settings') {
      res.json(await readUserConfig());
      return;
    }
    if (req.method === 'PUT' && requestPath === '/api/user-settings') {
      try {
        const patch = parseUserSettingsPatch(await readJsonBody(req));
        if (!patch) {
          res.status(400).json({ error: 'Invalid user settings payload' });
          return;
        }
        res.json(await updateUserClientSettings(patch));
      } catch {
        res.status(400).json({ error: 'Invalid user settings payload' });
      }
      return;
    }
    if (req.method === 'GET' && requestPath === '/api/watch') {
      const reviewClients = archivedWatchClients.get(registration.id) ?? new Set<Response>();
      archivedWatchClients.set(registration.id, reviewClients);
      reviewClients.add(res);
      openEventStream(req, res, { type: 'connected', diffMode: 'specific' });
      req.on('close', () => reviewClients.delete(res));
      return;
    }
    if (req.method === 'GET' && requestPath === '/api/heartbeat') {
      openEventStream(req, res, { type: 'connected' });
      return;
    }
    if (req.method === 'POST' && requestPath === '/api/open-in-editor') {
      res.status(400).json({ error: 'Open in editor is unavailable for an archived snapshot' });
      return;
    }

    if (req.method === 'GET' && requestPath === '/') {
      res.sendFile(join(__dirname, '..', 'client', 'index.html'));
      return;
    }
    if (req.method === 'GET' && !requestPath.includes('..')) {
      res.sendFile(requestPath.replace(/^\//, ''), {
        root: join(__dirname, '..', 'client'),
      });
      return;
    }
    res.status(404).send('Not found');
  });
  app.get('/', (_req, res) => {
    const nonce = res.locals.cspNonce as string;
    res.type('html').send(HUB_HTML.replace('<script>', `<script nonce="${nonce}">`));
  });

  const refreshTimer = setInterval(() => {
    for (const client of clients) client.write(`data: ${Date.now()}\n\n`);
  }, 2_000);
  const attachmentRefreshTimer = setInterval(() => {
    if (archivedWatchClients.size === 0) return;
    void (async () => {
      const registrations = await readReviewRegistrations();
      for (const [reviewId, reviewClients] of archivedWatchClients) {
        const registration = registrations.find((candidate) => candidate.id === reviewId);
        if (!registration || !(await isReviewServerRunning(registration, auth))) continue;
        for (const client of reviewClients) client.end();
        archivedWatchClients.delete(reviewId);
      }
    })();
  }, 2_000);

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(preferredPort, host, () => resolve(instance));
    instance.once('error', reject);
  });
  server.on('close', () => {
    clearInterval(refreshTimer);
    clearInterval(attachmentRefreshTimer);
  });
  return { port: preferredPort, url: `http://${host}:${preferredPort}`, server };
}
