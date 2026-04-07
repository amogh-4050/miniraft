const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
const NODE_ID = process.env.NODE_ID;
const PORT = parseInt(process.env.PORT);
const PEERS = process.env.PEERS.split(',');
const GATEWAY_URL = 'http://gateway:8081';
const state = {
  nodeId: NODE_ID,
  role: 'follower',
  currentTerm: 0,
  votedFor: null,
  log: [],
  commitIndex: -1,
  leaderId: null,
};
module.exports = { state, PEERS, GATEWAY_URL };
const raft = require('./raft');

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

  let acks = 1; // leader counts as 1

  const replicateToPeers = PEERS.map(async (peer) => {
    try {
      const res2 = await axios.post(`${peer}/append-entries`, {
        term: state.currentTerm,
        leaderId: NODE_ID,
        entry,
        prevLogIndex,
        prevLogTerm,
        leaderCommit: state.commitIndex,
      }, { timeout: 300 });

      if (res2.data.success) acks += 1;
    } catch (err) {
      console.log(`[${NODE_ID}] append-entries to ${peer} failed: ${err.message}`);
    }
  });

  await Promise.allSettled(replicateToPeers);

  // Step 3: if majority acked, commit
  if (acks >= 2) {
    state.commitIndex = entry.index;
    console.log(`[${NODE_ID}] stroke committed at index ${entry.index}`);

    // Step 4: tell gateway to broadcast to all browsers
    try {
      await axios.post(`${GATEWAY_URL}/broadcast`, { stroke }, { timeout: 300 });
    } catch (err) {
      console.log(`[${NODE_ID}] gateway broadcast failed: ${err.message}`);
    }

    return res.json({ success: true, index: entry.index });
  } else {
    console.log(`[${NODE_ID}] stroke NOT committed (only ${acks} acks)`);
    return res.status(500).json({ error: 'replication failed' });
  }
});

app.post('/request-vote', (req, res) => raft.handleRequestVote(req, res));
app.post('/append-entries', (req, res) => raft.handleAppendEntries(req, res));
app.post('/heartbeat', (req, res) => raft.handleHeartbeat(req, res));
app.post('/sync-log', (req, res) => raft.handleSyncLog(req, res));

function shutdown(signal) {
  console.log(`[${NODE_ID}] ${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGUSR2', () => shutdown('SIGUSR2'));
const server = app.listen(PORT, () => {
  console.log(`[${NODE_ID}] running on ${PORT} as ${state.role}`);
});
