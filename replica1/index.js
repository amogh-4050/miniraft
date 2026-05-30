const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────────────

const NODE_ID = process.env.NODE_ID;
const PORT = parseInt(process.env.PORT);
const PEERS = process.env.PEERS.split(',');
const GATEWAY_URL = 'http://gateway:8081';
const QUORUM = Math.floor((PEERS.length + 1) / 2) + 1;

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  nodeId: NODE_ID,
  role: 'follower',
  currentTerm: 0,
  votedFor: null,
  log: [],          // { index, term, type?, ...eventFields }
  commitIndex: -1,
  leaderId: null,
};

// In-memory room state — rebuilt by replaying log entries on leader change
const rooms = new Map();

function applyRoomEvent(entry) {
  if (!entry || entry.type !== 'room_event') return;
  const ev = entry.event;
  if (ev === 'room_create') {
    rooms.set(entry.roomCode, {
      roomCode: entry.roomCode,
      hostId: entry.hostId,
      hostName: entry.hostName,
      players: JSON.parse(JSON.stringify(entry.players)),
      phase: entry.phase,
      round: entry.round,
      scores: { ...entry.scores },
      createdAt: entry.createdAt,
    });
  } else if (ev === 'room_join') {
    const room = rooms.get(entry.roomCode);
    if (room) room.players.push({ ...entry.player });
  } else if (ev === 'room_leave') {
    const room = rooms.get(entry.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === entry.playerId);
    if (player) player.connected = false;
    if (room.hostId === entry.playerId) {
      const next = room.players.find(p => p.connected && p.id !== entry.playerId);
      if (next) { room.hostId = next.id; room.hostName = next.name; }
    }
    if (room.players.filter(p => p.connected).length < 2) room.phase = 'waiting';
  }
}

// Export before require('./raft') — circular dep resolved via partial exports
module.exports = { state, PEERS, GATEWAY_URL, rooms, applyRoomEvent };

const raft = require('./raft');

// ─── RAFT commit helper ───────────────────────────────────────────────────────

async function commitEntry(data) {
  const entry = { index: state.log.length, term: state.currentTerm, ...data };
  state.log.push(entry);
  const prevLogIndex = entry.index - 1;
  const prevLogTerm = prevLogIndex >= 0 ? state.log[prevLogIndex].term : 0;
  let acks = 1;

  await Promise.allSettled(PEERS.map(async (peer) => {
    try {
      const r = await axios.post(`${peer}/append-entries`, {
        term: state.currentTerm, leaderId: NODE_ID,
        entry, prevLogIndex, prevLogTerm, leaderCommit: state.commitIndex,
      }, { timeout: 300 });
      if (r.data.success) acks++;
      else if (r.data.logLength !== undefined) raft.syncFollower(peer, r.data.logLength);
    } catch (err) {
      console.log(`[${NODE_ID}] append-entries to ${peer} failed: ${err.message}`);
    }
  }));

  if (acks < QUORUM) {
    state.log.pop();
    return { success: false };
  }
  state.commitIndex = entry.index;
  applyRoomEvent(entry);
  return { success: true, index: entry.index };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({
    nodeId: state.nodeId,
    role: state.role,
    term: state.currentTerm,
    commitIndex: state.commitIndex,
    logLength: state.log.length,
    leaderId: state.leaderId,
  });
});

app.get('/log', (req, res) => {
  const committed = state.log.slice(0, state.commitIndex + 1);
  res.json({ entries: committed });
});

// ─── Game-state commit (RAFT path A) ─────────────────────────────────────────

app.post('/commit-state', async (req, res) => {
  if (state.role !== 'leader') return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });

  const { stroke } = req.body;
  const result = await commitEntry({ stroke });
  if (!result.success) {
    console.log(`[${NODE_ID}] stroke NOT committed — log rolled back`);
    return res.status(500).json({ error: 'replication failed' });
  }
  console.log(`[${NODE_ID}] stroke committed at index ${result.index}`);
  axios.post(`${GATEWAY_URL}/broadcast`, { stroke }, { timeout: 2000 })
    .catch(err => console.log(`[${NODE_ID}] gateway broadcast failed: ${err.message}`));
  return res.json({ success: true, index: result.index });
});

app.post('/commit-state-batch', async (req, res) => {
  if (state.role !== 'leader') return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });

  const { strokes } = req.body;
  if (!Array.isArray(strokes) || strokes.length === 0) return res.json({ success: true, committed: 0 });

  const committed = [];
  for (const stroke of strokes) {
    const result = await commitEntry({ stroke });
    if (!result.success) continue;
    committed.push(stroke);
  }

  if (committed.length > 0) {
    console.log(`[${NODE_ID}] batch committed ${committed.length}/${strokes.length}`);
    axios.post(`${GATEWAY_URL}/broadcast-batch`, { strokes: committed }, { timeout: 2000 })
      .catch(err => console.log(`[${NODE_ID}] broadcast-batch failed: ${err.message}`));
  }
  return res.json({ success: true, committed: committed.length });
});

// ─── Room endpoints (RAFT path A) ────────────────────────────────────────────

app.post('/room-create', async (req, res) => {
  if (state.role !== 'leader') return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });

  const { hostId, playerName } = req.body;
  if (!hostId || !playerName) return res.status(400).json({ error: 'hostId and playerName required' });

  const roomCode = Array.from({ length: 6 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]
  ).join('');

  const event = {
    type: 'room_event', event: 'room_create',
    roomCode, hostId, hostName: playerName,
    players: [{ id: hostId, name: playerName, connected: true }],
    phase: 'lobby', round: 0, scores: {}, createdAt: Date.now(),
  };

  const result = await commitEntry(event);
  if (!result.success) return res.status(500).json({ error: 'replication failed' });

  const room = rooms.get(roomCode);
  console.log(`[${NODE_ID}] room ${roomCode} created by ${playerName}`);
  axios.post(`${GATEWAY_URL}/room-broadcast`, { roomCode, room }, { timeout: 2000 })
    .catch(() => {});
  return res.json({ roomCode, playerId: hostId, room });
});

app.post('/room-join', async (req, res) => {
  if (state.role !== 'leader') return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });

  const { roomCode, playerName, playerId } = req.body;
  if (!roomCode || !playerName || !playerId) return res.status(400).json({ error: 'roomCode, playerName, playerId required' });

  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (room.phase !== 'lobby' && room.phase !== 'waiting') return res.status(400).json({ error: 'room not joinable' });

  const event = {
    type: 'room_event', event: 'room_join',
    roomCode, player: { id: playerId, name: playerName, connected: true },
  };

  const result = await commitEntry(event);
  if (!result.success) return res.status(500).json({ error: 'replication failed' });

  const updated = rooms.get(roomCode);
  console.log(`[${NODE_ID}] ${playerName} joined room ${roomCode}`);
  axios.post(`${GATEWAY_URL}/room-broadcast`, { roomCode, room: updated }, { timeout: 2000 })
    .catch(() => {});
  return res.json({ roomCode, playerId, room: updated, currentPlayers: updated.players });
});

app.post('/room-leave', async (req, res) => {
  if (state.role !== 'leader') return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });

  const { roomCode, playerId } = req.body;
  if (!roomCode || !playerId) return res.status(400).json({ error: 'roomCode and playerId required' });

  const room = rooms.get(roomCode);
  if (!room) return res.json({ success: true });

  const event = { type: 'room_event', event: 'room_leave', roomCode, playerId };
  const result = await commitEntry(event);
  if (!result.success) return res.status(500).json({ error: 'replication failed' });

  const updated = rooms.get(roomCode);
  console.log(`[${NODE_ID}] player ${playerId} left room ${roomCode}`);
  axios.post(`${GATEWAY_URL}/room-broadcast`, { roomCode, room: updated }, { timeout: 2000 })
    .catch(() => {});
  return res.json({ success: true, room: updated });
});

app.get('/room/:roomCode', (req, res) => {
  const room = rooms.get(req.params.roomCode);
  if (!room) return res.status(404).json({ error: 'room not found' });
  return res.json(room);
});

// ─── RAFT RPC ─────────────────────────────────────────────────────────────────

app.post('/request-vote',   (req, res) => raft.handleRequestVote(req, res));
app.post('/append-entries', (req, res) => raft.handleAppendEntries(req, res));
app.post('/heartbeat',      (req, res) => raft.handleHeartbeat(req, res));
app.post('/sync-log',       (req, res) => raft.handleSyncLog(req, res));

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[${NODE_ID}] ${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGUSR2', () => shutdown('SIGUSR2'));

// ─── Boot ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[${NODE_ID}] running on ${PORT} as ${state.role}`);
});
