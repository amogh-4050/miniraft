const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────────────

const NODE_ID = process.env.NODE_ID;
const PORT = parseInt(process.env.PORT);
const PEERS = process.env.PEERS.split(',');
const GATEWAY_URL = 'http://gateway:8081';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  nodeId: NODE_ID,
  role: 'follower',       // follower | candidate | leader
  currentTerm: 0,
  votedFor: null,
  log: [],                // { index, term, stroke }
  commitIndex: -1,
  leaderId: null,
};

// Must be exported before require('./raft') — raft.js does require('./index')
// to grab state/PEERS/GATEWAY_URL. Node resolves the circular dep via the
// partial exports object already assigned here.
module.exports = { state, PEERS, GATEWAY_URL };

const raft = require('./raft');

// ─── Routes ──────────────────────────────────────────────────────────────────

// Called by gateway to check who is leader
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

// Called by gateway to get full committed log (for new browser clients)
app.get('/log', (req, res) => {
  const committed = state.log.slice(0, state.commitIndex + 1);
  res.json({ entries: committed });
});

// Called by gateway to forward a stroke from a browser client
app.post('/stroke', async (req, res) => {
  if (state.role !== 'leader') {
    return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });
  }

  const { stroke } = req.body;
  const entry = {
    index: state.log.length,
    term: state.currentTerm,
    stroke,
  };

  // Step 1: append to own log
  state.log.push(entry);
  console.log(`[${NODE_ID}] stroke received, replicating to peers...`);

  // Step 2: send AppendEntries to all peers
  const prevLogIndex = entry.index - 1;
  const prevLogTerm = prevLogIndex >= 0 ? state.log[prevLogIndex].term : 0;

  let acks = 1; // leader counts itself

  await Promise.allSettled(PEERS.map(async (peer) => {
    try {
      const r = await axios.post(`${peer}/append-entries`, {
        term: state.currentTerm,
        leaderId: NODE_ID,
        entry,
        prevLogIndex,
        prevLogTerm,
        leaderCommit: state.commitIndex,
      }, { timeout: 300 });
      if (r.data.success) acks += 1;
    } catch (err) {
      console.log(`[${NODE_ID}] append-entries to ${peer} failed: ${err.message}`);
    }
  }));

  // Step 3: majority quorum (≥2 of 3) → commit; otherwise roll back to keep logs in sync
  if (acks < 2) {
    state.log.pop();
    console.log(`[${NODE_ID}] stroke NOT committed (only ${acks} acks) — log rolled back`);
    return res.status(500).json({ error: 'replication failed' });
  }

  state.commitIndex = entry.index;
  console.log(`[${NODE_ID}] stroke committed at index ${entry.index}`);

  // Step 4: tell gateway to broadcast to all browsers
  axios.post(`${GATEWAY_URL}/broadcast`, { stroke }, { timeout: 2000 })
  .catch(err => console.log(`[${NODE_ID}] gateway broadcast failed: ${err.message}`));

  return res.json({ success: true, index: entry.index });
});

// RAFT RPC — called by candidates during election
app.post('/request-vote', (req, res) => raft.handleRequestVote(req, res));

// RAFT RPC — called by leader to replicate entries
app.post('/append-entries', (req, res) => raft.handleAppendEntries(req, res));

// RAFT RPC — called by leader to send heartbeats
app.post('/heartbeat', (req, res) => raft.handleHeartbeat(req, res));

// RAFT RPC — called by leader to sync log to a rejoining node
app.post('/sync-log', (req, res) => raft.handleSyncLog(req, res));

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
