const axios = require('axios');
const { state, PEERS, GATEWAY_URL } = require('./index');

const HEARTBEAT_INTERVAL = 150;
const ELECTION_TIMEOUT_MIN = 500;
const ELECTION_TIMEOUT_MAX = 800;
const QUORUM = Math.floor((PEERS.length + 1) / 2) + 1;  // majority of cluster

let electionTimer = null;
let heartbeatTimer = null;
const syncingPeers = new Set();  // prevent concurrent sync floods to same peer

function randomElectionTimeout() {
  return Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX - ELECTION_TIMEOUT_MIN + 1)) + ELECTION_TIMEOUT_MIN;
}

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(() => startElection(), randomElectionTimeout());
}

function stopElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = null;
}

function stopHeartbeatTimer() {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function becomeFollower(term, leaderId = null) {
  console.log(`[${state.nodeId}] → FOLLOWER (term ${term})`);
  state.role = 'follower';
  state.currentTerm = term;
  state.votedFor = null;
  state.leaderId = leaderId;
  stopHeartbeatTimer();
  syncingPeers.clear();
  resetElectionTimer();
}

async function startElection() {
  if (state.role === 'leader') return;
  state.role = 'candidate';
  state.currentTerm += 1;
  state.votedFor = state.nodeId;
  state.leaderId = null;

  const term = state.currentTerm;
  const lastLogIndex = state.log.length - 1;
  const lastLogTerm = lastLogIndex >= 0 ? state.log[lastLogIndex].term : 0;

  console.log(`[${state.nodeId}] → CANDIDATE (term ${term}), requesting votes...`);

  let votes = 1;

  const voteRequests = PEERS.map(async (peer) => {
    try {
      const response = await axios.post(`${peer}/request-vote`, {
        term, candidateId: state.nodeId, lastLogIndex, lastLogTerm,
      }, { timeout: 300 });

      const { term: peerTerm, voteGranted } = response.data;
      if (peerTerm > state.currentTerm) { becomeFollower(peerTerm); return; }
      if (voteGranted) { votes += 1; console.log(`[${state.nodeId}] vote from ${peer} (total: ${votes})`); }
    } catch (err) {
      console.log(`[${state.nodeId}] vote request to ${peer} failed: ${err.message}`);
    }
  });

  await Promise.allSettled(voteRequests);

  if (state.role === 'candidate' && votes >= QUORUM) {
    becomeLeader();
  } else if (state.role === 'candidate') {
      state.role = 'follower';
      state.votedFor = null;

      setTimeout(() => {
        resetElectionTimer();
      }, Math.random() * 150);
  }
}

function becomeLeader() {
  console.log(`[${state.nodeId}] → LEADER (term ${state.currentTerm})`);
  state.role = 'leader';
  state.leaderId = state.nodeId;
  stopElectionTimer();
  notifyGateway();
  scheduleHeartbeat();
}

async function scheduleHeartbeat() {
  if (state.role !== 'leader') return;
  await sendHeartbeats();
  if (state.role !== 'leader') return;
  heartbeatTimer = setTimeout(scheduleHeartbeat, HEARTBEAT_INTERVAL);
}

async function notifyGateway() {
  const leaderUrl = `http://${state.nodeId}:${process.env.PORT}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (state.role !== 'leader') return;
    try {
      await axios.post(`${GATEWAY_URL}/leader`, {
        leaderId: state.nodeId,
        leaderUrl,
      }, { timeout: 500 });
      console.log(`[${state.nodeId}] notified gateway`);
      return;
    } catch (err) {
      console.log(`[${state.nodeId}] gateway notify failed (attempt ${attempt + 1}): ${err.message}`);
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  console.error(`[${state.nodeId}] could not notify gateway after 5 attempts`);
}

async function sendHeartbeats() {
  if (state.role !== 'leader') return;
  await Promise.allSettled(
  PEERS.map(async (peer) => {
    try {
      const res = await axios.post(`${peer}/heartbeat`, {
        term: state.currentTerm,
        leaderId: state.nodeId,
        leaderCommit: state.commitIndex,
      }, { timeout: 200 });
      if (res.data.term > state.currentTerm) becomeFollower(res.data.term);
      if (res.data.logLength !== undefined && res.data.logLength <= state.commitIndex) {
        syncFollower(peer, res.data.logLength);
      }
    } catch (err) {
      console.log(`[${state.nodeId}] heartbeat to ${peer} failed`);
    }
  })
);
}

function handleRequestVote(req, res) {
  const { term, candidateId, lastLogIndex, lastLogTerm } = req.body;
  if (term < state.currentTerm) return res.json({ term: state.currentTerm, voteGranted: false });
  if (term > state.currentTerm) {
    state.currentTerm = term;
    state.role = 'follower';
    state.votedFor = null;
    stopHeartbeatTimer();
}
  if (state.votedFor !== null && state.votedFor !== candidateId) return res.json({ term: state.currentTerm, voteGranted: false });
  const myLastIndex = state.log.length - 1;
  const myLastTerm = myLastIndex >= 0 ? state.log[myLastIndex].term : 0;
  const logOk = (lastLogTerm > myLastTerm) || (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);
  if (!logOk) return res.json({ term: state.currentTerm, voteGranted: false });
  state.votedFor = candidateId;
  resetElectionTimer();
  console.log(`[${state.nodeId}] voted for ${candidateId} term ${term}`);
  return res.json({ term: state.currentTerm, voteGranted: true });
}

function handleAppendEntries(req, res) {
  const { term, leaderId, entry, prevLogIndex, prevLogTerm, leaderCommit } = req.body;
  if (term < state.currentTerm) return res.json({ term: state.currentTerm, success: false });
  if (term > state.currentTerm) { state.currentTerm = term; state.votedFor = null; }
  state.role = 'follower'; state.leaderId = leaderId;
  stopHeartbeatTimer(); 
  resetElectionTimer();
  if (prevLogIndex >= 0) {
    if (state.log.length <= prevLogIndex || state.log[prevLogIndex].term !== prevLogTerm)
      return res.json({ term: state.currentTerm, success: false, logLength: state.log.length });
  }
  if (entry) { state.log = state.log.slice(0, prevLogIndex + 1); state.log.push(entry); }
  if (leaderCommit > state.commitIndex) state.commitIndex = Math.min(leaderCommit, state.log.length - 1);
  return res.json({ term: state.currentTerm, success: true });
}

function handleHeartbeat(req, res) {
  const { term, leaderId, leaderCommit } = req.body;
  if (term < state.currentTerm) return res.json({ term: state.currentTerm, success: false });
  if (term > state.currentTerm) { state.currentTerm = term; state.votedFor = null; }
  state.role = 'follower'; state.leaderId = leaderId;
  stopHeartbeatTimer();
  resetElectionTimer();
  if (leaderCommit > state.commitIndex) state.commitIndex = Math.min(leaderCommit, state.log.length - 1);
  const behind = state.log.length - 1 < leaderCommit;
  return res.json({ term: state.currentTerm, success: true, ...(behind && { logLength: state.log.length }) });
}

// Called by leader to push missing committed entries to a behind follower
function handleSyncLog(req, res) {
  const { term, leaderId, entries, leaderCommit } = req.body;
  if (term < state.currentTerm) return res.json({ term: state.currentTerm, success: false });
  if (term > state.currentTerm) { state.currentTerm = term; state.votedFor = null; }
  state.role = 'follower'; state.leaderId = leaderId;
  resetElectionTimer();

  if (entries && entries.length > 0) {
    for (const entry of entries) {
      // only append entries we don't have yet (idempotent)
      if (entry.index >= state.log.length) {
        state.log.push(entry);
      }
    }
  }
  if (leaderCommit > state.commitIndex) {
    state.commitIndex = Math.min(leaderCommit, state.log.length - 1);
  }
  console.log(`[${state.nodeId}] sync-log applied — log: ${state.log.length}, commit: ${state.commitIndex}`);
  return res.json({ term: state.currentTerm, success: true });
}

// Leader calls this when a follower's append-entries fails with a logLength mismatch
async function syncFollower(peer, fromIndex) {
  if (state.role !== 'leader') return;
  if (syncingPeers.has(peer)) return;  // already syncing this peer, skip
  const entries = state.log.slice(fromIndex, state.commitIndex + 1);
  if (entries.length === 0) return;
  syncingPeers.add(peer);
  try {
    await axios.post(`${peer}/sync-log`, {
      term: state.currentTerm,
      leaderId: state.nodeId,
      entries,
      leaderCommit: state.commitIndex,
    }, { timeout: 500 });
    console.log(`[${state.nodeId}] synced ${entries.length} entries to ${peer} from index ${fromIndex}`);
  } catch (err) {
    console.log(`[${state.nodeId}] sync-log to ${peer} failed: ${err.message}`);
  } finally {
    syncingPeers.delete(peer);
  }
}

  setTimeout(() => {
  resetElectionTimer();
}, Math.random() * 200);
console.log(`[${state.nodeId}] RAFT module loaded`);

module.exports = { handleRequestVote, handleAppendEntries, handleHeartbeat, handleSyncLog, syncFollower };
