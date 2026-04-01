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
app.post('/stroke', (req, res) => {
  if (state.role !== 'leader') {
    return res.status(403).json({ error: 'not leader', leaderId: state.leaderId });
  }
  // TODO Week 2: Member 2 plugs replication logic here
  res.json({ success: true });
});

// RAFT RPC — called by candidates during election
app.post('/request-vote', (req, res) => {
  // TODO Week 2: Member 2 implements this
  res.json({ term: state.currentTerm, voteGranted: false });
});

// RAFT RPC — called by leader to replicate entries + heartbeat
app.post('/append-entries', (req, res) => {
  // TODO Week 2: Member 2 implements this
  res.json({ term: state.currentTerm, success: false });
});

// RAFT RPC — called by leader to send heartbeats
app.post('/heartbeat', (req, res) => {
  // TODO Week 2: Member 2 implements this
  res.json({ term: state.currentTerm, success: false });
});

// RAFT RPC — called by leader to sync log to rejoining node
app.post('/sync-log', (req, res) => {
  // TODO Week 2: Member 2 implements this
  res.json({ entries: [], leaderCommit: state.commitIndex });
});

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

module.exports = { state, PEERS, GATEWAY_URL };