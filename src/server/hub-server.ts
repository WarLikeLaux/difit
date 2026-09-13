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
  <link rel="icon" href="/favicon.svg?v=3" type="image/svg+xml" />
  <title>DIFIT</title>
  <style>
    :root{color-scheme:dark;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;background:#0e1116;color:#eef1f5;--canvas:#0e1116;--surface:#151a21;--surface-hover:#1a2029;--line:#2b323d;--quiet:#8e98a7;--text:#eef1f5;--blue:#70a5ff;--green:#52c77a;--amber:#e0ad4f;--red:#ff7b72}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas)}button,input,select,a{font:inherit}button,input,select{color:inherit}header{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 max(18px,calc((100vw - 1160px)/2));border-bottom:1px solid var(--line);background:#11151b}.brand{display:flex;align-items:center;gap:9px;color:var(--text);text-decoration:none;font-size:17px;font-weight:650;letter-spacing:-.02em}.brand img{width:22px;height:22px}.summary{color:var(--quiet);font-size:13px}.layout{max-width:1160px;margin:0 auto;padding:30px 18px 64px}.controls{border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:14px}.control-top{display:grid;grid-template-columns:minmax(240px,1fr) auto auto;gap:10px}.search{position:relative}.search:before{content:"";position:absolute;left:13px;top:11px;width:8px;height:8px;border:1.5px solid var(--quiet);border-radius:50%;pointer-events:none}.search:after{content:"";position:absolute;left:21px;top:21px;width:5px;height:1.5px;background:var(--quiet);border-radius:1px;transform:rotate(45deg);transform-origin:left center;pointer-events:none}.search input{width:100%;height:36px;border:1px solid var(--line);background:#0f1319;border-radius:7px;padding:0 12px 0 34px;outline:none}.search input::placeholder{color:#687383}.search input:focus{border-color:#537fbd;box-shadow:0 0 0 3px rgba(83,127,189,.16)}.status-filter{display:flex;border:1px solid var(--line);background:#0f1319;border-radius:7px;padding:2px}.status-filter button{height:30px;border:0;background:transparent;border-radius:5px;padding:0 10px;color:var(--quiet);font-size:12px;cursor:pointer}.status-filter button:hover{color:var(--text)}.status-filter button.active{background:#29313d;color:var(--text)}.sort{display:flex;align-items:center;gap:7px;color:var(--quiet);font-size:12px}.sort select{height:36px;border:1px solid var(--line);background:#0f1319;border-radius:7px;padding:0 28px 0 10px;outline:none}.sort select:focus{border-color:#537fbd}.repositories{margin-top:13px;padding-top:13px;border-top:1px solid var(--line);overflow:hidden}.repository-scroll{display:flex;flex-wrap:wrap;gap:7px;max-height:70px;overflow-y:auto;scrollbar-width:thin;padding-right:3px}.repo-filter{display:inline-flex;align-items:center;gap:7px;height:31px;flex:none;border:1px solid transparent;background:transparent;border-radius:16px;padding:0 11px;color:#aeb7c3;font-size:12px;cursor:pointer}.repo-filter:hover{background:#1d242d;color:var(--text)}.repo-filter.active{border-color:#405066;background:#222b37;color:var(--text)}.repo-filter .count{color:#758192}.repo-filter .live-dot{width:6px;height:6px;border-radius:50%;background:var(--green)}.results-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:28px 2px 11px}.results-head h1{font-size:17px;letter-spacing:-.015em;margin:0}.results-head span{color:var(--quiet);font-size:12px}.review-list{display:grid;gap:8px}.review-card{position:relative;display:grid;grid-template-columns:4px minmax(0,1fr) auto;column-gap:15px;border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:14px 14px 14px 0;overflow:hidden}.review-card:hover{background:var(--surface-hover);border-color:#3a4451}.state-rail{align-self:stretch;border-radius:0 3px 3px 0;background:#505967}.review-card.connected .state-rail{background:var(--green)}.review-card.waiting .state-rail{background:var(--amber)}.review-main{min-width:0}.review-title{display:flex;align-items:center;gap:7px;min-width:0}.review-title strong{font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slash{color:#596575}.branch{font-family:"Cascadia Code","SFMono-Regular",Consolas,monospace;color:#c9d1d9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.state-label{flex:none;color:var(--quiet);font-size:11px}.connected .state-label{color:#71d391}.waiting .state-label{color:#edbd64}.review-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px 12px;margin-top:6px;color:var(--quiet);font-size:12px}.review-stats{display:flex;gap:10px}.review-stats strong{color:#c8d0db;font-weight:600}.review-stats .open strong{color:#edbd64}.review-stats .ready strong{color:#71d391}.latest{margin-top:8px;color:#aeb8c5;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.latest .author{color:var(--quiet)}.actions{display:flex;align-items:center;gap:2px;justify-self:end;padding:3px;border:1px solid #303946;background:#10151b;border-radius:9px;box-shadow:0 1px 0 rgba(255,255,255,.035),0 2px 8px rgba(0,0,0,.12)}.actions a,.actions button{height:30px;border:0;background:transparent;border-radius:6px;color:#aeb8c5;text-decoration:none;padding:0 10px;font-size:12px;font-weight:550;cursor:pointer}.actions a:hover,.actions a:focus-visible,.actions button:hover,.actions button:focus-visible{background:#222a35;color:var(--text);outline:none}.actions a:focus-visible,.actions button:focus-visible{box-shadow:0 0 0 2px #10151b,0 0 0 4px var(--blue)}.actions .primary{gap:7px;min-width:64px;background:#356caf;color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.13),0 1px 2px rgba(0,0,0,.24)}.actions .primary:hover,.actions .primary:focus-visible{background:#427cc4}.actions .delete-review{position:relative;width:30px;margin-left:4px;padding:0;color:#788494}.actions .delete-review:before{content:"";position:absolute;left:-3px;top:6px;width:1px;height:18px;background:#303946}.actions .delete-review:hover,.actions .delete-review:focus-visible{background:#302022;color:var(--red)}.actions svg{display:block;width:14px;height:14px;flex:none}.unavailable{display:inline-flex;align-items:center;height:30px;padding:0 8px;color:var(--quiet);font-size:12px}.empty{border:1px dashed var(--line);border-radius:9px;padding:42px 20px;text-align:center;color:var(--quiet);font-size:13px}@media(max-width:820px){.control-top{grid-template-columns:1fr}.status-filter{overflow-x:auto}.sort{justify-content:space-between}.sort select{flex:1}.review-card{grid-template-columns:4px minmax(0,1fr)}.actions{grid-column:2;justify-self:start;margin-top:12px}.summary{font-size:12px}.repository-scroll{flex-wrap:nowrap;max-height:none;overflow-x:auto;overflow-y:hidden;padding-bottom:2px}}@media(max-width:500px){header{height:54px;padding:0 14px}.layout{padding:18px 12px 44px}.controls{padding:10px}.status-filter button{padding:0 8px}.results-head{margin-top:22px}.review-card{column-gap:11px}.review-title{flex-wrap:wrap}.state-label{width:100%}.review-meta{gap:5px 9px}.latest{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
    .status-filter button,.actions a,.actions button{display:inline-flex;align-items:center;justify-content:center;line-height:1}.actions{align-self:center}.actions a:not(.primary){min-width:39px}.sort select{min-width:150px}
  </style>
</head>
<body>
  <header><a class="brand" href="/"><img src="/favicon.svg?v=3" alt="" /><span>difit</span></a><span id="summary" class="summary">Loading…</span></header>
  <main class="layout">
    <section class="controls" aria-label="Review filters">
      <div class="control-top">
        <label class="search"><span hidden>Search reviews</span><input id="search" type="search" placeholder="Search reviews" autocomplete="off" /></label>
        <div id="statusFilters" class="status-filter" role="group" aria-label="Filter by status">
          <button type="button" class="active" data-status="all" aria-pressed="true">All</button><button type="button" data-status="connected" aria-pressed="false">Live</button><button type="button" data-status="waiting" aria-pressed="false">Waiting</button><button type="button" data-status="saved" aria-pressed="false">Saved</button>
        </div>
        <label class="sort"><span hidden>Sort reviews</span><select id="sort" aria-label="Sort reviews"><option value="priority">Priority</option><option value="recent">Recent activity</option><option value="repository">Repository</option></select></label>
      </div>
      <nav class="repositories" aria-label="Filter by repository"><div id="repositoryFilters" class="repository-scroll"></div></nav>
    </section>
    <div class="results-head"><h1 id="resultsTitle">Reviews</h1><span id="resultsCount"></span></div>
    <div id="reviews" class="review-list"></div>
  </main>
  <script>
    const root=document.getElementById('reviews');const summary=document.getElementById('summary');const repositoryFilters=document.getElementById('repositoryFilters');const statusFilters=document.getElementById('statusFilters');const search=document.getElementById('search');const sort=document.getElementById('sort');const resultsTitle=document.getElementById('resultsTitle');const resultsCount=document.getElementById('resultsCount');let reviews=[];let selectedRepository='all';let selectedStatus='all';let selectedSort='priority';let query='';
    const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const kindLabel=(review)=>review.kind==='working-tree'?'Working tree':review.kind==='merge-request'?'Merge request':'Commit';
    const relativeTime=(value)=>{const seconds=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/1000));if(seconds<60)return'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';if(seconds<604800)return Math.floor(seconds/86400)+'d ago';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value))};
    const reviewState=(review)=>review.agentConnected?'connected':review.pendingMessages>0?'waiting':'saved';
    const stateLabel=(review)=>review.agentConnected?'Live':review.pendingMessages>0?review.pendingMessages+' waiting':'Saved';
    const stats=(review)=>[['open','Open'],['accepted','Accepted'],['to_verify','To verify'],['ready','Ready']].filter(([key])=>review.counts[key]>0).map(([key,label])=>'<span class="'+key+'"><strong>'+review.counts[key]+'</strong> '+label+'</span>').join('')||'<span>No comments</span>';
    function reviewCard(review){const latest=review.threads[0];const state=reviewState(review);return '<article class="review-card '+state+'"><span class="state-rail" aria-hidden="true"></span><div class="review-main"><div class="review-title"><strong>'+esc(review.repositoryName)+'</strong><span class="slash">/</span><span class="branch">'+esc(review.label)+'</span><span class="state-label">'+esc(stateLabel(review))+'</span></div><div class="review-meta"><span>'+kindLabel(review)+'</span><time datetime="'+esc(review.updatedAt)+'" title="'+esc(new Date(review.updatedAt).toLocaleString())+'">'+(latest?'Last reply ':'Added ')+relativeTime(review.updatedAt)+'</time><span class="review-stats">'+stats(review)+'</span></div>'+(latest?'<div class="latest"><span class="author">'+esc(latest.lastAuthor||'Unknown')+':</span> '+esc(latest.lastMessage)+'</div>':'')+'</div><div class="actions">'+(review.viewerUrl?'<a class="primary" href="'+esc(review.viewerUrl)+'">Open<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>':'<span class="unavailable">Unavailable</span>')+(review.reviewUrl?'<a href="'+esc(review.reviewUrl)+'" target="_blank" rel="noreferrer">MR<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h6v6M12 4 5 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>':'')+'<button type="button" class="delete-review" data-delete-review="'+esc(review.id)+'" aria-label="Delete review" title="Delete review"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9m-6.5 0V3h4v1.5m-5.5 0 .5 8h6l.5-8M6.75 6.5v4m2.5-4v4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></article>'}
    function repositoryOptions(){const map=new Map();for(const review of reviews){const item=map.get(review.repositoryPath);if(item){item.count+=1;item.live||=review.agentConnected}else map.set(review.repositoryPath,{path:review.repositoryPath,name:review.repositoryName,count:1,live:review.agentConnected})}return [...map.values()].sort((left,right)=>left.name.localeCompare(right.name))}
    function renderRepositoryFilters(options){if(selectedRepository!=='all'&&!options.some((option)=>option.path===selectedRepository))selectedRepository='all';repositoryFilters.innerHTML='<button type="button" class="repo-filter '+(selectedRepository==='all'?'active':'')+'" data-repository="all" aria-pressed="'+(selectedRepository==='all')+'">All <span class="count">'+reviews.length+'</span></button>'+options.map((option,index)=>'<button type="button" class="repo-filter '+(selectedRepository===option.path?'active':'')+'" data-repository="'+index+'" aria-pressed="'+(selectedRepository===option.path)+'">'+esc(option.name)+' <span class="count">'+option.count+'</span>'+(option.live?'<span class="live-dot" aria-label="Agent connected"></span>':'')+'</button>').join('');repositoryFilters.querySelectorAll('[data-repository]').forEach((button)=>button.addEventListener('click',()=>{selectedRepository=button.dataset.repository==='all'?'all':options[Number(button.dataset.repository)].path;render()}))}
    function compareReviews(left,right){if(selectedSort==='repository')return left.repositoryName.localeCompare(right.repositoryName)||right.updatedAt.localeCompare(left.updatedAt);if(selectedSort==='recent')return right.updatedAt.localeCompare(left.updatedAt);const priority=(review)=>review.agentConnected?0:review.pendingMessages>0?1:2;return priority(left)-priority(right)||right.updatedAt.localeCompare(left.updatedAt)}
    function matches(review){if(selectedRepository!=='all'&&review.repositoryPath!==selectedRepository)return false;if(selectedStatus!=='all'&&reviewState(review)!==selectedStatus)return false;if(!query)return true;const threadValues=review.threads.flatMap((thread)=>[thread.filePath,thread.lastAuthor,thread.lastMessage]);return [review.repositoryName,review.label,kindLabel(review),...threadValues].some((value)=>String(value??'').toLocaleLowerCase().includes(query))}
    function render(){const options=repositoryOptions();renderRepositoryFilters(options);const shown=reviews.filter(matches).sort(compareReviews);const connected=reviews.filter((review)=>review.agentConnected).length;const waiting=reviews.reduce((count,review)=>count+review.pendingMessages,0);summary.textContent=reviews.length+' reviews / '+connected+' connected'+(waiting?' / '+waiting+' waiting':'');const selected=options.find((option)=>option.path===selectedRepository);resultsTitle.textContent=selected?.name??'Reviews';resultsCount.textContent=shown.length+' shown';root.innerHTML=shown.length?shown.map(reviewCard).join(''):'<div class="empty">No reviews match these filters.</div>'}
    async function refresh(){try{const response=await fetch('/api/reviews');reviews=await response.json();render()}catch{summary.textContent='Hub unavailable'}}
    search.addEventListener('input',()=>{query=search.value.trim().toLocaleLowerCase();render()});
    statusFilters.addEventListener('click',(event)=>{const button=event.target.closest('[data-status]');if(!button)return;selectedStatus=button.dataset.status;statusFilters.querySelectorAll('[data-status]').forEach((item)=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button))});render()});
    sort.addEventListener('change',()=>{selectedSort=sort.value;render()});
    root.addEventListener('click',async(event)=>{const button=event.target.closest('[data-delete-review]');if(!button||!confirm('Delete this review, its comments, and queued messages? This cannot be undone.'))return;const original=button.innerHTML;button.disabled=true;button.textContent='…';try{const response=await fetch('/api/reviews/'+encodeURIComponent(button.dataset.deleteReview),{method:'DELETE'});if(!response.ok)throw new Error();await refresh()}catch{button.disabled=false;button.innerHTML=original;alert('Could not delete the review.')}});
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
