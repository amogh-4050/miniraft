const WebSocket = require('ws');
const axios = require('axios');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT) || 8080;
const REPLICA_URLS = process.env.REPLICAS.split(',');

const RPC_TIMEOUT_MS = 300;
const STATUS_TIMEOUT_MS = 1000;
const LEADER_POLL_INTERVAL_MS = 100;
const STROKE_RETRY_LIMIT = 3;

// ─── RPC Clients ─────────────────────────────────────────────────────────────

const rpc = axios.create({
  timeout: STATUS_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
  httpAgent: new http.Agent({ keepAlive: false }),
});

const strokeRpc = axios.create({
  timeout: RPC_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

const roomRpc = axios.create({
  timeout: 2000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── State ───────────────────────────────────────────────────────────────────

let leaderUrl = null;
let leaderPollTimer = null;
let strokeQueue = [];
let isProcessingQueue = false;

// Room membership tracking
const roomClients = new Map();   // roomCode → Set<ws>
const wsInfo = new Map();        // ws → { roomCode, playerId }

// ─── Leader Discovery ─────────────────────────────────────────────────────────

const replicaFailCount = new Map();
const DEAD_REPLICA_TIMEOUT_MS = 100;

async function pollOne(url) {
  const failed = replicaFailCount.get(url) > 0;
  const timeout = failed ? DEAD_REPLICA_TIMEOUT_MS : STATUS_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(`${url}/status`, { signal: ac.signal });
    const data = await res.json();
    replicaFailCount.set(url, 0);
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

  if (leaderUrl && !statuses.some(s => s.url === leaderUrl)) {
    console.log(`[gateway] Leader ${leaderUrl} unreachable — clearing`);
    leaderUrl = null;
  }

  let bestLeader = null;
  let bestTerm = -1;
  for (const s of statuses) {
    if (s.role === 'leader' && s.term > bestTerm) { bestTerm = s.term; bestLeader = s.url; }
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
  try { await discoverLeader(); } catch (err) { console.error('[gateway] discoverLeader threw:', err.message); }
  if (leaderUrl && strokeQueue.length > 0) drainQueue();
  leaderPollTimer = setTimeout(schedulePoll, LEADER_POLL_INTERVAL_MS);
}

function startLeaderPolling() { schedulePoll(); }

// ─── Stroke Forwarding ───────────────────────────────────────────────────────

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function forwardStroke(stroke, attempt = 0) {
  if (!leaderUrl) {
    strokeQueue.push(stroke);
    if (attempt === 0) console.warn('[gateway] No leader — stroke queued');
    return;
  }
  const targetUrl = leaderUrl;
  try {
    await strokeRpc.post(`${targetUrl}/commit-state`, { stroke });
  } catch (err) {
    if (attempt >= STROKE_RETRY_LIMIT) { strokeQueue.push(stroke); console.warn('[gateway] Stroke queued (leader unreachable)'); return; }
    await sleep(200 * (attempt + 1));
    await discoverLeader();
    await forwardStroke(stroke, attempt + 1);
  }
}

async function drainQueue() {
  if (isProcessingQueue || strokeQueue.length === 0) return;
  isProcessingQueue = true;
  console.log(`[gateway] Draining ${strokeQueue.length} queued strokes`);
  while (strokeQueue.length > 0) {
    if (!leaderUrl) {
      await sleep(300);
      if (!leaderUrl) { console.warn('[gateway] Drain aborted — no leader after 300ms'); break; }
    }
    const batch = strokeQueue.splice(0, 20);
    try {
      await strokeRpc.post(`${leaderUrl}/commit-state-batch`, { strokes: batch });
    } catch (err) {
      strokeQueue.unshift(...batch);
      console.warn('[gateway] Drain interrupted — will retry on next leader update');
      break;
    }
  }
  isProcessingQueue = false;
}

async function forwardBatch(strokes, attempt = 0) {
  if (!leaderUrl) {
    for (const s of strokes) strokeQueue.push(s);
    if (attempt === 0) console.warn('[gateway] No leader — batch queued');
    return;
  }
  const targetUrl = leaderUrl;
  try {
    await strokeRpc.post(`${targetUrl}/commit-state-batch`, { strokes });
  } catch (err) {
    if (attempt >= STROKE_RETRY_LIMIT) { for (const s of strokes) strokeQueue.push(s); return; }
    await sleep(100 * (attempt + 1));
    await forwardBatch(strokes, attempt + 1);
  }
}

// ─── Room Forwarding ─────────────────────────────────────────────────────────

async function forwardToLeader(path, body, attempt = 0) {
  if (!leaderUrl) {
    if (attempt === 0) await discoverLeader();
    if (!leaderUrl) throw new Error('no leader');
  }
  try {
    const r = await roomRpc.post(`${leaderUrl}${path}`, body);
    return r.data;
  } catch (err) {
    if (err.response && err.response.status === 403) {
      // Stale leaderUrl — rediscover and retry once
      await discoverLeader();
      if (attempt < 2 && leaderUrl) return forwardToLeader(path, body, attempt + 1);
    }
    throw err;
  }
}

// ─── Broadcast Helpers ────────────────────────────────────────────────────────

function broadcastToClients(stroke) {
  const msg = JSON.stringify({ type: 'stroke', payload: stroke });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastBatchToClients(strokes) {
  const msg = JSON.stringify({ type: 'stroke-batch', payload: strokes });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToRoom(roomCode, msg) {
  const room = roomClients.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function addClientToRoom(ws, roomCode) {
  if (!roomClients.has(roomCode)) roomClients.set(roomCode, new Set());
  roomClients.get(roomCode).add(ws);
}

function removeClientFromRoom(ws, roomCode) {
  const room = roomClients.get(roomCode);
  if (room) { room.delete(ws); if (room.size === 0) roomClients.delete(roomCode); }
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[gateway] Client connected. Total: ${clients.size}`);

  sendCurrentState(ws);

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // PATH A — game state via RAFT
    if (msg.type === 'stroke') forwardStroke(msg.payload);

    // PATH B — drawing strokes, best-effort direct broadcast
    if (msg.type === 'draw' && Array.isArray(msg.payload) && msg.payload.length > 0) {
      broadcastBatchToClients(msg.payload);
    }

    if (msg.type === 'room_start') {
      const { roomCode } = msg;
      if (roomCode) broadcastToRoom(roomCode, { type: 'game_start', roomCode });
    }

    // Room: create (no roomCode) or join (with roomCode)
    if (msg.type === 'room_join') {
      const { roomCode, playerName } = msg;
      if (!playerName || !playerName.trim()) {
        ws.send(JSON.stringify({ type: 'error', message: 'playerName required' }));
        return;
      }
      const playerId = crypto.randomUUID();
      try {
        let result;
        if (!roomCode) {
          result = await forwardToLeader('/room-create', { hostId: playerId, playerName: playerName.trim() });
        } else {
          result = await forwardToLeader('/room-join', { roomCode: roomCode.toUpperCase(), playerName: playerName.trim(), playerId });
        }
        const code = result.roomCode;
        // Track this ws in the room
        addClientToRoom(ws, code);
        wsInfo.set(ws, { roomCode: code, playerId: result.playerId || playerId });

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomCode: code,
          playerId: result.playerId || playerId,
          players: result.room.players,
          hostId: result.room.hostId,
        }));

        // Broadcast updated player list to everyone else in the room
        broadcastToRoom(code, {
          type: 'room_update',
          roomCode: code,
          players: result.room.players,
          hostId: result.room.hostId,
        });
      } catch (err) {
        console.error('[gateway] room_join failed:', err.message);
        const msg2 = err.response?.data?.error || err.message;
        ws.send(JSON.stringify({ type: 'error', message: msg2 }));
      }
    }
  });

  ws.on('close', async () => {
    clients.delete(ws);
    console.log(`[gateway] Client disconnected. Total: ${clients.size}`);

    const info = wsInfo.get(ws);
    if (info) {
      const { roomCode, playerId } = info;
      wsInfo.delete(ws);
      removeClientFromRoom(ws, roomCode);
      try {
        const result = await forwardToLeader('/room-leave', { roomCode, playerId });
        broadcastToRoom(roomCode, {
          type: 'room_update',
          roomCode,
          players: result.room?.players || [],
          hostId: result.room?.hostId,
        });
      } catch (err) {
        console.warn(`[gateway] room-leave failed for ${playerId}: ${err.message}`);
      }
    }
  });

  ws.on('error', (err) => {
    console.warn(`[gateway] WS error: ${err.message}`);
    clients.delete(ws);
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

const wsHeartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
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
  } catch { /* non-critical */ }
}

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
  } catch { /* non-critical */ }
}

// ─── Internal HTTP Server ────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
  });
}

const internalServer = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }

  try {
    const body = await readBody(req);

    if (req.url === '/leader') {
      const { leaderUrl: newLeaderUrl } = body;
      console.log(`[gateway] Leader updated → ${newLeaderUrl}`);
      leaderUrl = newLeaderUrl;
      drainQueue();
      syncAllClients();
      res.writeHead(200); res.end('ok');

    } else if (req.url === '/broadcast') {
      broadcastToClients(body.stroke);
      res.writeHead(200); res.end('ok');

    } else if (req.url === '/broadcast-batch') {
      broadcastBatchToClients(body.strokes);
      res.writeHead(200); res.end('ok');

    } else if (req.url === '/room-broadcast') {
      const { roomCode, room } = body;
      if (roomCode && room) {
        broadcastToRoom(roomCode, {
          type: 'room_update',
          roomCode,
          players: room.players,
          hostId: room.hostId,
        });
      }
      res.writeHead(200); res.end('ok');

    } else {
      res.writeHead(404); res.end();
    }
  } catch (err) {
    res.writeHead(400); res.end('bad request');
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
  for (const ws of clients) ws.close(1001, 'Gateway restarting');
  wss.close(() => {
    internalServer.close(() => { console.log('[gateway] Clean shutdown complete'); process.exit(0); });
  });
  setTimeout(() => process.exit(1), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGUSR2', () => shutdown('SIGUSR2'));

// ─── Boot ────────────────────────────────────────────────────────────────────

startLeaderPolling();
console.log(`[gateway] WebSocket server on :${PORT}`);
