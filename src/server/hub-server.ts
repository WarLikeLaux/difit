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
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0d1117;color:#e6edf3;--canvas:#0d1117;--surface:#161b22;--surface-soft:#11161d;--line:#30363d;--quiet:#8b949e;--text:#e6edf3;--blue:#58a6ff;--green:#3fb950;--amber:#d29922;--red:#f85149}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas)}button,a{font:inherit}header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:15px max(20px,calc((100vw - 1120px)/2));border-bottom:1px solid var(--line);background:rgba(22,27,34,.96);backdrop-filter:blur(10px)}h1{font-size:17px;letter-spacing:-.02em;margin:0}.top-actions{display:flex;align-items:center;gap:14px}.logout{border:0;background:transparent;color:var(--quiet);padding:7px 0;cursor:pointer}.logout:hover,.logout:focus-visible{color:var(--text)}.muted{color:var(--quiet)}.layout{max-width:1120px;margin:0 auto;padding:36px 20px 64px}.section{margin-bottom:42px}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:14px}.section-title{display:flex;align-items:baseline;gap:9px}.section-title h2{font-size:17px;letter-spacing:-.015em;font-weight:650;margin:0}.section-title span{color:var(--quiet);font-size:12px}.section-note{color:var(--quiet);font-size:12px}.empty-state{border-left:2px solid var(--line);color:var(--quiet);padding:8px 14px}.active-list{display:grid;gap:10px}.active-review{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:15px 28px;border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:17px 18px}.review-identity{min-width:0}.identity-line{display:flex;align-items:center;gap:9px;min-width:0}.identity-line strong{font-size:16px;letter-spacing:-.012em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slash{color:#57606a}.branch{color:#c9d1d9;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.presence{display:inline-flex;align-items:center;gap:6px;color:#73c991;font-size:12px;white-space:nowrap}.presence:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(63,185,80,.13)}.presence.waiting{color:#e3b341}.presence.waiting:before{background:var(--amber);box-shadow:0 0 0 3px rgba(210,153,34,.14)}.review-subline{display:flex;align-items:center;gap:12px;margin-top:7px;color:var(--quiet);font-size:12px}.latest-message{grid-column:1/-1;margin:0;padding-top:13px;border-top:1px solid var(--line);color:#c9d1d9;font-size:13px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.latest-message .author{color:var(--quiet)}.actions{display:flex;align-items:center;gap:7px;justify-self:end}.actions a,.actions button{border:1px solid var(--line);background:transparent;border-radius:6px;color:#c9d1d9;text-decoration:none;padding:7px 10px;font-size:12px;cursor:pointer}.actions .primary{border-color:#1f6feb;background:#1f6feb;color:#fff}.actions a:hover,.actions a:focus-visible,.actions button:hover,.actions button:focus-visible{border-color:#6e7681;outline:none}.actions .primary:hover,.actions .primary:focus-visible{background:#2f81f7;border-color:#2f81f7}.actions .delete-review{border-color:transparent;color:var(--quiet);padding-inline:5px}.actions .delete-review:hover,.actions .delete-review:focus-visible{color:#ff7b72;border-color:transparent}.actions button:disabled{cursor:wait;opacity:.55}.unavailable{color:var(--quiet);font-size:12px}.library{border-top:1px solid var(--line);padding-top:27px}.repository-list{display:grid;gap:18px}.repository{border:1px solid var(--line);background:var(--surface-soft);border-radius:9px;overflow:hidden}.repository-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;background:var(--surface)}.repository-name{display:flex;align-items:center;gap:9px;min-width:0}.repository-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:5px;background:#21262d;color:var(--blue);font-family:ui-monospace,monospace;font-size:12px}.repository-name h3{font-size:14px;font-weight:650;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.repository-count{color:var(--quiet);font-size:12px}.review-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(150px,.7fr) auto auto;align-items:center;gap:18px;padding:13px 16px;border-top:1px solid var(--line)}.review-row:first-of-type{border-top:0}.review-kind{min-width:0}.review-kind strong{display:block;color:#d7dee7;font-size:13px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.review-kind span,.review-activity{display:block;color:var(--quiet);font-size:12px;margin-top:3px}.review-summary{display:flex;flex-wrap:wrap;gap:10px;color:var(--quiet);font-size:12px}.review-summary strong{color:#c9d1d9;font-weight:600}.review-summary .open strong{color:#e3b341}.review-summary .ready strong{color:#73c991}.row-actions{display:flex;align-items:center;gap:7px}.row-actions a,.row-actions button{border:0;background:transparent;color:var(--quiet);text-decoration:none;padding:5px 3px;font-size:12px;cursor:pointer}.row-actions a:first-child{color:var(--blue)}.row-actions a:hover,.row-actions a:focus-visible,.row-actions button:hover,.row-actions button:focus-visible{color:var(--text);outline:none}.row-actions .delete-review:hover,.row-actions .delete-review:focus-visible{color:#ff7b72}.empty{padding:34px 0;color:var(--quiet)}@media(max-width:760px){header{padding:13px 16px}.layout{padding:26px 14px 48px}.section{margin-bottom:34px}.section-note{display:none}.active-review{grid-template-columns:1fr;padding:15px}.actions{justify-self:start;flex-wrap:wrap}.latest-message{grid-column:1}.review-row{grid-template-columns:minmax(0,1fr) auto;gap:9px 14px}.review-summary{grid-column:1}.review-activity{display:none}.row-actions{grid-column:2;grid-row:1/3;flex-direction:column;align-items:flex-end}.repository-head{padding:11px 13px}.review-row{padding:12px 13px}}
  </style>
</head>
<body>
  <header><h1>↪ difit reviews</h1><div class="top-actions"><span id="summary" class="muted">Loading…</span><form method="post" action="/auth/logout"><button class="logout" type="submit">Log out</button></form></div></header>
  <main class="layout"><div id="reviews"></div></main>
  <script>
    const root=document.getElementById('reviews');const summary=document.getElementById('summary');let reviews=[];
    const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const kindLabel=(review)=>review.kind==='working-tree'?'Working tree':review.kind==='merge-request'?'Merge request':'Commit';
    const relativeTime=(value)=>{const seconds=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/1000));if(seconds<60)return'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';if(seconds<604800)return Math.floor(seconds/86400)+'d ago';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value))};
    const stats=(review)=>[['open','Open'],['accepted','Accepted'],['to_verify','To verify'],['ready','Ready']].filter(([key])=>review.counts[key]>0).map(([key,label])=>'<span class="'+key+'"><strong>'+review.counts[key]+'</strong> '+label+'</span>').join('')||'<span>No comments</span>';
    const actions=(review,className)=>'<div class="'+className+'">'+(review.viewerUrl?'<a class="primary" href="'+esc(review.viewerUrl)+'">Open review</a>':'<span class="unavailable">Snapshot unavailable</span>')+(review.reviewUrl?'<a href="'+esc(review.reviewUrl)+'" target="_blank" rel="noreferrer">Open MR</a>':'')+'<button type="button" class="delete-review" data-delete-review="'+esc(review.id)+'">Delete</button></div>';
    function activeReview(review,state){const latest=review.threads[0];return '<article class="active-review"><div class="review-identity"><div class="identity-line"><strong>'+esc(review.repositoryName)+'</strong><span class="slash">/</span><span class="branch">'+esc(review.label)+'</span><span class="presence '+(state==='waiting'?'waiting':'')+'">'+(state==='waiting'?review.pendingMessages+' waiting':'Connected')+'</span></div><div class="review-subline"><span>'+kindLabel(review)+'</span><time datetime="'+esc(review.updatedAt)+'" title="'+esc(new Date(review.updatedAt).toLocaleString())+'">'+(latest?'Last reply ':'Added ')+relativeTime(review.updatedAt)+'</time><span class="review-summary">'+stats(review)+'</span></div></div>'+actions(review,'actions')+(latest?'<p class="latest-message"><span class="author">'+esc(latest.lastAuthor||'Unknown')+':</span> '+esc(latest.lastMessage)+'</p>':'')+'</article>'}
    function attentionSection(title,items,state,note){return '<section class="section"><div class="section-head"><div class="section-title"><h2>'+title+'</h2><span>'+items.length+'</span></div><span class="section-note">'+note+'</span></div>'+(items.length?'<div class="active-list">'+items.map((review)=>activeReview(review,state)).join('')+'</div>':'<div class="empty-state">No agents connected</div>')+'</section>'}
    function reviewRow(review){return '<div class="review-row"><div class="review-kind"><strong>'+esc(review.label)+'</strong><span>'+kindLabel(review)+'</span></div><time class="review-activity" datetime="'+esc(review.updatedAt)+'" title="'+esc(new Date(review.updatedAt).toLocaleString())+'">'+(review.threads.length?'Last reply ':'Added ')+relativeTime(review.updatedAt)+'</time><div class="review-summary">'+stats(review)+'</div>'+actions(review,'row-actions')+'</div>'}
    function repositoryLibrary(items){if(!items.length)return'';const groups=new Map();for(const review of items){const existing=groups.get(review.repositoryPath);if(existing)existing.push(review);else groups.set(review.repositoryPath,[review])}const repositories=[...groups.values()].sort((left,right)=>left[0].repositoryName.localeCompare(right[0].repositoryName));return '<section class="section library"><div class="section-head"><div class="section-title"><h2>Other reviews</h2><span>'+items.length+'</span></div><span class="section-note">Grouped by repository, newest reply first</span></div><div class="repository-list">'+repositories.map((group)=>'<section class="repository"><div class="repository-head"><div class="repository-name"><span class="repository-mark">git</span><h3>'+esc(group[0].repositoryName)+'</h3></div><span class="repository-count">'+group.length+(group.length===1?' review':' reviews')+'</span></div>'+group.map(reviewRow).join('')+'</section>').join('')+'</div></section>'}
    function render(){const sorted=[...reviews].sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt));const connected=sorted.filter((review)=>review.agentConnected);const waitingReviews=sorted.filter((review)=>!review.agentConnected&&review.pendingMessages>0);const attentionIds=new Set([...connected,...waitingReviews].map((review)=>review.id));const other=sorted.filter((review)=>!attentionIds.has(review.id));const waiting=waitingReviews.reduce((count,review)=>count+review.pendingMessages,0);summary.textContent=connected.length+' connected'+(waiting?' / '+waiting+' waiting':'');if(!sorted.length){root.innerHTML='<div class="empty">No reviews yet. Attach a Git checkout with difit.</div>';return}root.innerHTML=attentionSection('Connected now',connected,'connected','Live agent sessions')+(waitingReviews.length?attentionSection('Waiting for agent',waitingReviews,'waiting','Feedback will be delivered on reconnect'):'')+repositoryLibrary(other)}
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
