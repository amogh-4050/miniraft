const WebSocket = require('ws');
const axios = require('axios');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT) || 8080;
const REPLICA_URLS = process.env.REPLICAS.split(',');

const RPC_TIMEOUT_MS = 300;
const STATUS_TIMEOUT_MS = 1000;  // generous — replicas may be busy right after election
const LEADER_POLL_INTERVAL_MS = 100;
const STROKE_RETRY_LIMIT = 3;

// ─── RPC Client ──────────────────────────────────────────────────────────────

// No keep-alive: after a replica restart the old TCP socket goes stale and
// subsequent polls over the same connection fail. Fresh sockets per poll avoids this.
const rpc = axios.create({
  timeout: STATUS_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
  httpAgent: new http.Agent({ keepAlive: false }),
});

const strokeRpc = axios.create({
  timeout: RPC_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});


// ─── State ───────────────────────────────────────────────────────────────────

let leaderUrl = null;
let leaderPollTimer = null;
let strokeQueue = [];
let isProcessingQueue = false;

// ─── Leader Discovery ─────────────────────────────────────────────────────────

// Track consecutive failures per replica so we can use a short timeout for
// known-dead nodes. Avoids the ~100ms post-abort cleanup window that would
// otherwise cause subsequent polls to other replicas to also fail.
const replicaFailCount = new Map();
const DEAD_REPLICA_TIMEOUT_MS = 100;  // fast-fail replicas that are already down

// Use native fetch (Node 18+) for status polls — isolated from the axios HTTP
// agent so a dead replica's timeout can't corrupt the keep-alive socket pool.
async function pollOne(url) {
  const failed = replicaFailCount.get(url) > 0;
  const timeout = failed ? DEAD_REPLICA_TIMEOUT_MS : STATUS_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(`${url}/status`, { signal: ac.signal });
    const data = await res.json();
    replicaFailCount.set(url, 0);  // reset on success
    return { url, ...data };
  } catch {
    replicaFailCount.set(url, (replicaFailCount.get(url) || 0) + 1);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLeader() {
  const results = await Promise.allSettled(REPLICA_URLS.map(url => pollOne(url)));
  const statuses = results.map(r => r.value).filter(Boolean);

  // Clear stale leaderUrl if that node is no longer responding.
  // This causes forwardStroke to queue immediately instead of burning 1.2s
  // retrying against a dead URL, and ensures bestLeader !== leaderUrl triggers
  // a drain when the new leader is found.
  if (leaderUrl && !statuses.some(s => s.url === leaderUrl)) {
    console.log(`[gateway] Leader ${leaderUrl} unreachable — clearing`);
    leaderUrl = null;
  }

  let bestLeader = null;
  let bestTerm = -1;

  for (const s of statuses) {
    if (s.role === 'leader' && s.term > bestTerm) {
      bestTerm = s.term;
      bestLeader = s.url;
    }
  }

  if (bestLeader && bestLeader !== leaderUrl) {
    console.log(`[gateway] Leader: ${leaderUrl ?? 'none'} → ${bestLeader} (term ${bestTerm})`);
    leaderUrl = bestLeader;
    drainQueue();
    syncAllClients();
  } else if (!bestLeader && !leaderUrl) {
    console.warn('[gateway] No leader detected — cluster unavailable');
  }
}

async function schedulePoll() {
  try {
    await discoverLeader();
  } catch (err) {
    console.error('[gateway] discoverLeader threw:', err.message);
  }
  // Drain any strokes that were queued after the last leaderUrl update
  // (e.g. strokes that finished retrying after the leader-change drain ran)
  if (leaderUrl && strokeQueue.length > 0) drainQueue();
  leaderPollTimer = setTimeout(schedulePoll, LEADER_POLL_INTERVAL_MS);
}

function startLeaderPolling() {
  schedulePoll();
}
// ─── Stroke Forwarding ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function forwardStroke(stroke, attempt = 0) {
  if (!leaderUrl) {
    strokeQueue.push(stroke);
    if (attempt === 0) console.warn('[gateway] No leader — stroke queued');
    return;
  }

  const targetUrl = leaderUrl;
  try {
    await strokeRpc.post(`${targetUrl}/stroke`, { stroke });
  } catch (err) {
    if (attempt >= STROKE_RETRY_LIMIT) {
      strokeQueue.push(stroke);
      console.warn('[gateway] Stroke queued (leader unreachable)');
      return;
    }
    await sleep(200 * (attempt + 1));
    await forwardStroke(stroke, attempt + 1);
  }
}

async function drainQueue() {
  if (isProcessingQueue || strokeQueue.length === 0) return;
  isProcessingQueue = true;

  console.log(`[gateway] Draining ${strokeQueue.length} queued strokes`);
  while (strokeQueue.length > 0) {
    if (!leaderUrl) break;
    // Drain in batches of 20 to stay efficient without hammering the leader
    const batch = strokeQueue.splice(0, 20);
    try {
      await strokeRpc.post(`${leaderUrl}/stroke-batch`, { strokes: batch });
    } catch (err) {
      strokeQueue.unshift(...batch);
      console.warn('[gateway] Drain interrupted — leader unreachable, will retry on next leader update');
      break;
    }
  }

  isProcessingQueue = false;
}

// Send a batch of strokes to the leader in one HTTP call instead of N.
// Eliminates the concurrent-write race that was causing AppendEntries failures.
async function forwardBatch(strokes, attempt = 0) {
  if (!leaderUrl) {
    for (const s of strokes) strokeQueue.push(s);
    if (attempt === 0) console.warn('[gateway] No leader — batch queued');
    return;
  }

  const targetUrl = leaderUrl;
  try {
    await strokeRpc.post(`${targetUrl}/stroke-batch`, { strokes });
  } catch (err) {
    if (attempt >= STROKE_RETRY_LIMIT) {
      for (const s of strokes) strokeQueue.push(s);
      console.warn('[gateway] Batch queued (leader unreachable)');
      return;
    }
    await sleep(100 * (attempt + 1));
    await forwardBatch(strokes, attempt + 1);
  }
}

function broadcastBatchToClients(strokes) {
  const msg = JSON.stringify({ type: 'stroke-batch', payload: strokes });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[gateway] Client connected. Total: ${clients.size}`);

  sendCurrentState(ws);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'stroke') forwardStroke(msg.payload);
    if (msg.type === 'batch' && msg.payload.length > 0) forwardBatch(msg.payload);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[gateway] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.warn(`[gateway] WS error: ${err.message}`);
    clients.delete(ws);
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Detect and clean up dead connections
const wsHeartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

wss.on('close', () => clearInterval(wsHeartbeat));

async function sendCurrentState(ws) {
  if (!leaderUrl) return;
  try {
    const res = await rpc.get(`${leaderUrl}/log`);
    const strokes = res.data.entries || [];
    if (ws.readyState === WebSocket.OPEN && strokes.length > 0) {
      ws.send(JSON.stringify({ type: 'init', strokes }));
    }
  } catch {
    // not critical — new client starts with empty canvas
  }
}

// Re-sync all already-connected clients when a new leader is found.
// Without this, existing tabs miss strokes drawn during a failover gap.
async function syncAllClients() {
  if (!leaderUrl || clients.size === 0) return;
  try {
    const res = await rpc.get(`${leaderUrl}/log`);
    const strokes = res.data.entries || [];
    if (strokes.length === 0) return;
    const msg = JSON.stringify({ type: 'sync', strokes });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
    console.log(`[gateway] Re-synced ${clients.size} client(s) after leader change`);
  } catch {
    // non-critical
  }
}

function broadcastToClients(stroke) {
  const msg = JSON.stringify({ type: 'stroke', payload: stroke });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
// ─── Internal HTTP Server (for replicas to push committed strokes) ────────────

const internalServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/leader') {
    let body = '';

    req.on('data', chunk => body += chunk);

    req.on('end', () => {
      try {
        const { leaderUrl: newLeaderUrl } = JSON.parse(body);

        console.log(`[gateway] Leader updated → ${newLeaderUrl}`);

        leaderUrl = newLeaderUrl;

        drainQueue();
        syncAllClients();

        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });

    return;
}


  if (req.method === 'POST' && req.url === '/broadcast') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { stroke } = JSON.parse(body);
        broadcastToClients(stroke);
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });
  } else if (req.method === 'POST' && req.url === '/broadcast-batch') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { strokes } = JSON.parse(body);
        broadcastBatchToClients(strokes);
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

internalServer.listen(8081, () => {
  console.log('[gateway] Internal broadcast endpoint on :8081');
});
// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[gateway] ${signal} received — shutting down`);

  clearTimeout(leaderPollTimer);
  clearInterval(wsHeartbeat);

  for (const ws of clients) {
    ws.close(1001, 'Gateway restarting');
  }

  wss.close(() => {
    internalServer.close(() => {
      console.log('[gateway] Clean shutdown complete');
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGUSR2', () => shutdown('SIGUSR2'));

// ─── Boot ────────────────────────────────────────────────────────────────────

startLeaderPolling();
console.log(`[gateway] WebSocket server on :${PORT}`);