const WebSocket = require('ws');
const axios = require('axios');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT) || 8080;
const REPLICA_URLS = process.env.REPLICAS.split(',');

const RPC_TIMEOUT_MS = 300;
const LEADER_POLL_INTERVAL_MS = 100;
const STROKE_RETRY_LIMIT = 3;

// ─── RPC Client ──────────────────────────────────────────────────────────────

const rpc = axios.create({
  timeout: RPC_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});
// ─── State ───────────────────────────────────────────────────────────────────

let leaderUrl = null;
let leaderPollTimer = null;
let strokeQueue = [];
let isProcessingQueue = false;

// ─── Leader Discovery ─────────────────────────────────────────────────────────

async function discoverLeader() {
  const polls = REPLICA_URLS.map(async (url) => {
    try {
      const res = await rpc.get(`${url}/status`);
      return { url, ...res.data };
    } catch {
      return null;
    }
  });

  const statuses = (await Promise.all(polls)).filter(Boolean);

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
  } else if (!bestLeader && leaderUrl !== null) {
    console.warn('[gateway] No leader — election in progress');
    leaderUrl = null;
  }
}

function startLeaderPolling() {
  discoverLeader();
  leaderPollTimer = setInterval(discoverLeader, LEADER_POLL_INTERVAL_MS);
}
// ─── Stroke Forwarding ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function forwardStroke(stroke, attempt = 0) {
  if (!leaderUrl) {
    if (attempt === 0) {
      strokeQueue.push(stroke);
      console.warn('[gateway] No leader — stroke queued');
    }
    return;
  }

  try {
    await rpc.post(`${leaderUrl}/stroke`, { stroke });
  } catch (err) {
    console.warn(`[gateway] Forward failed (attempt ${attempt + 1}): ${err.message}`);

    if (attempt >= STROKE_RETRY_LIMIT) {
      console.error('[gateway] Stroke dropped after max retries');
      return;
    }

    leaderUrl = null;
    await discoverLeader();
    await sleep(200);
    await forwardStroke(stroke, attempt + 1);
  }
}

async function drainQueue() {
  if (isProcessingQueue || strokeQueue.length === 0) return;
  isProcessingQueue = true;

  console.log(`[gateway] Draining ${strokeQueue.length} queued strokes`);
  while (strokeQueue.length > 0) {
    const stroke = strokeQueue.shift();
    await forwardStroke(stroke);
  }

  isProcessingQueue = false;
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

function broadcastToClients(stroke) {
  const msg = JSON.stringify({ type: 'stroke', payload: stroke });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
// ─── Internal HTTP Server (for replicas to push committed strokes) ────────────

const internalServer = http.createServer((req, res) => {
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

  clearInterval(leaderPollTimer);
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