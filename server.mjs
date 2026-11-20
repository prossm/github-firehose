// GitHub Firehose server. Node 20.12+ and nothing else: no npm install.
//
//   node server.mjs        then open http://localhost:8787
//
// It polls GitHub's public events API, keeps only events from the last hour, and
// serves firehose.html plus /api/events for the page to read. The GitHub token is
// read from .env (GITHUB_TOKEN=...) and never leaves this process: it is not sent to
// the browser, not put in a URL, and not logged.
//
// Why all three pages: on build day, page 1 of /events was almost entirely stale
// (1 of 100 events under an hour old) while pages 2 and 3 were ~85% under 10 minutes
// old. GitHub serves at most 3 pages of 100.

import http from "node:http";
import { readFile } from "node:fs/promises";

// ---- Settings ---------------------------------------------------------------------
try { process.loadEnvFile(new URL(".env", import.meta.url)); } catch { /* no .env: run without a token */ }
const TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1"; // local only; set HOST=0.0.0.0 to serve the LAN
const MOCK = process.env.MOCK || "";          // test-only: ratelimit | offline | busy

const API = "https://api.github.com/events?per_page=100&page=";
const PAGES = [1, 2, 3];
// Rate-limit math: 3 requests per poll. Without a token GitHub allows 60/hr, so
// every 225s = 48/hr leaves headroom. With a token (5,000/hr), every 60s = 180/hr.
const POLL_MS = TOKEN ? 60_000 : 225_000;
const MAX_AGE_MS = 60 * 60 * 1000;      // only events from the last hour
const BACKOFF_START_MS = 30_000;        // 5xx / offline: 30s, 60s, 120s ... capped
const BACKOFF_MAX_MS = 300_000;
const RATE_LIMIT_MIN_MS = 30_000;
const RATE_LIMIT_DEFAULT_MS = 300_000;  // when GitHub omits the reset header
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SEEN_IDS = 5_000;
const KEEP_EVENTS = 1_000;              // ring of recent events the page reads from
const FIRST_SEND = 300;                 // a fresh page load gets at most this many

const HTML_FILE = new URL("firehose.html", import.meta.url);

// ---- State ------------------------------------------------------------------------
const etags = new Map();                // page -> ETag
const seen = new Set();
const seenOrder = [];
const events = [];                      // { seq, event } oldest first
let seq = 0;
const net = { state: "connecting", nextPollAt: Date.now(), resumeAt: 0, backoff: 0, lagMs: null, timer: 0 };

// ---- Polling GitHub -------------------------------------------------------------------
async function fetchPage(page) {
  if (MOCK === "offline") throw new TypeError("mock: offline");
  if (MOCK === "busy") return { status: 503, headers: new Headers() };
  if (MOCK === "ratelimit") {
    return { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) }) };
  }
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "github-firehose-lobby-screen" };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  if (etags.has(page)) headers["If-None-Match"] = etags.get(page);
  return fetch(API + page, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function schedulePoll(ms) {
  clearTimeout(net.timer);
  net.nextPollAt = Date.now() + ms;
  net.timer = setTimeout(poll, ms);
}

function nextBackoff() {
  net.backoff = net.backoff ? Math.min(net.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
  return net.backoff;
}

function enterRateLimit(res) {
  // x-ratelimit-reset is UTC epoch seconds. Wait until then plus 2s, never less than 30s.
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  let wait = retryAfter > 0 ? retryAfter * 1000
    : reset > 0 ? reset * 1000 + 2_000 - Date.now()
    : RATE_LIMIT_DEFAULT_MS;
  wait = Math.max(wait, RATE_LIMIT_MIN_MS);
  net.state = "ratelimit";
  net.resumeAt = Date.now() + wait;
  schedulePoll(wait);
  log(`rate limited; resuming at ${new Date(net.resumeAt).toLocaleTimeString()}`);
}

// Keep only what the page uses, so /api/events stays small.
function slim(e) {
  const p = e.payload || {};
  const commits = Array.isArray(p.commits) ? p.commits : [];
  return {
    id: e.id, type: e.type, created_at: e.created_at,
    actor: { login: e.actor?.login, display_login: e.actor?.display_login },
    repo: { name: e.repo?.name },
    payload: {
      action: p.action, ref: p.ref, ref_type: p.ref_type, description: p.description, number: p.number,
      head: p.head, before: p.before,
      commits: commits.length ? [{ message: commits[commits.length - 1]?.message }] : undefined,
      pull_request: p.pull_request && { number: p.pull_request.number, title: p.pull_request.title, merged: p.pull_request.merged, html_url: p.pull_request.html_url },
      issue: p.issue && { number: p.issue.number, title: p.issue.title, html_url: p.issue.html_url },
      comment: p.comment && { html_url: p.comment.html_url },
      review: p.review && { html_url: p.review.html_url },
      release: p.release && { tag_name: p.release.tag_name, name: p.release.name, html_url: p.release.html_url },
      discussion: p.discussion && { title: p.discussion.title, html_url: p.discussion.html_url },
      forkee: p.forkee && { full_name: p.forkee.full_name },
    },
  };
}

// Never let one bad poll stop the loop: whatever happens, another poll is scheduled.
async function poll() {
  try {
    await pollOnce();
  } catch (err) {
    net.state = "busy";
    schedulePoll(nextBackoff());
    log(`poll failed (${err?.message || err}); retrying in ${net.backoff / 1000}s`);
  }
}

async function pollOnce() {
  const results = await Promise.allSettled(PAGES.map(fetchPage));
  const fresh = [];
  let newest = 0, stale = 0, ok = 0, limited = null, failed = false, offline = false;

  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") { offline = true; continue; }
    const res = r.value;
    if (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 403 || res.status === 429) limited = res;
    if (res.status === 304) { ok++; continue; }
    if (res.status !== 200) { failed = true; continue; }
    ok++;
    if (res.headers.get("etag")) etags.set(PAGES[i], res.headers.get("etag"));
    let body;
    try { body = await res.json(); } catch { failed = true; continue; }
    for (const e of Array.isArray(body) ? body : []) {
      const t = Date.parse(e?.created_at);
      if (t > newest) newest = t;
      if (!e?.id || seen.has(e.id)) continue;
      seen.add(e.id);
      seenOrder.push(e.id);
      if (seenOrder.length > MAX_SEEN_IDS) seen.delete(seenOrder.shift());
      if (!(Date.now() - t <= MAX_AGE_MS)) { stale++; continue; }
      fresh.push(slim(e));
    }
  }

  if (newest) net.lagMs = Math.max(0, Date.now() - newest);
  fresh.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const event of fresh) events.push({ seq: ++seq, event });
  if (events.length > KEEP_EVENTS) events.splice(0, events.length - KEEP_EVENTS);

  if (limited) return enterRateLimit(limited);
  if (ok === 0) {
    net.state = offline ? "offline" : "busy";
    const wait = nextBackoff();
    schedulePoll(wait);
    return log(`${net.state}; retrying in ${wait / 1000}s`);
  }
  net.backoff = 0;
  net.state = "live";
  const asked = Math.max(0, ...results.map(r => Number(r.value?.headers?.get("x-poll-interval")) || 0)) * 1000;
  schedulePoll(Math.max(POLL_MS, asked));
  log(`${fresh.length} new from the last hour, ${stale} older skipped${failed ? " (a page failed)" : ""}; next poll in ${Math.round((net.nextPollAt - Date.now()) / 1000)}s`);
}

function log(msg) {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}

// ---- HTTP -----------------------------------------------------------------------------
function sendJson(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET") { res.writeHead(405).end(); return; }

  if (url.pathname === "/api/events") {
    // The page asks for everything after the last seq it saw. A since value from
    // before a server restart is ahead of seq, so it starts over (the page dedupes by id).
    let since = Number(url.searchParams.get("since")) || 0;
    if (since > seq) since = 0;
    let out = events.filter(e => e.seq > since);
    if (since === 0) out = out.slice(-FIRST_SEND);
    const now = Date.now();
    sendJson(res, {
      cursor: seq,
      events: out.map(e => e.event),
      state: net.state,
      nextPollInMs: Math.max(0, net.nextPollAt - now),
      resumeInMs: net.state === "ratelimit" ? Math.max(0, net.resumeAt - now) : null,
      lagMs: net.lagMs,
      authenticated: Boolean(TOKEN),
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/firehose.html") {
    try {
      const html = await readFile(HTML_FILE); // read per request, so edits show on reload
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(500).end("firehose.html not found next to server.mjs");
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, HOST, () => {
  log(`GitHub Firehose on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  log(TOKEN
    ? "Using GITHUB_TOKEN from .env: polling 3 pages every 60s"
    : "No GITHUB_TOKEN in .env: polling 3 pages every 225s (add a token for ~4x more events)");
  poll();
});
