const axios = require('axios');
const { state, PEERS, GATEWAY_URL } = require('./index');

const HEARTBEAT_INTERVAL = 150;
const ELECTION_TIMEOUT_MIN = 300;
const ELECTION_TIMEOUT_MAX = 500;

let electionTimer = null;
let heartbeatTimer = null;

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
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function becomeFollower(term, leaderId = null) {
  console.log(`[${state.nodeId}] → FOLLOWER (term ${term})`);
  state.role = 'follower';
  state.currentTerm = term;
  state.votedFor = null;
  state.leaderId = leaderId;
  stopHeartbeatTimer();
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

  if (state.role === 'candidate' && votes >= 2) {
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
  sendHeartbeats();
  heartbeatTimer = setInterval(() => sendHeartbeats(), HEARTBEAT_INTERVAL);
}

async function notifyGateway() {
  try {
    await axios.post(`${GATEWAY_URL}/leader`, {
      leaderId: state.nodeId,
      leaderUrl: `http://${state.nodeId}:${process.env.PORT}`,
    }, { timeout: 300 });
    console.log(`[${state.nodeId}] notified gateway`);
  } catch (err) {
    console.log(`[${state.nodeId}] gateway notify failed: ${err.message}`);
  }
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
    });
      if (res.data.term > state.currentTerm) becomeFollower(res.data.term);
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
    resetElectionTimer(); // 🔥 ADD THIS
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
  return res.json({ term: state.currentTerm, success: true });
}

function handleSyncLog(req, res) {
  const { term, leaderId, fromIndex } = req.body;
  if (term < state.currentTerm) return res.json({ term: state.currentTerm, success: false, entries: [] });
  if (term > state.currentTerm) { state.currentTerm = term; state.votedFor = null; }
  state.role = 'follower'; state.leaderId = leaderId;
  resetElectionTimer();
  const missingEntries = state.log.slice(fromIndex, state.commitIndex + 1);
  return res.json({ term: state.currentTerm, success: true, entries: missingEntries, leaderCommit: state.commitIndex });
}

  setTimeout(() => {
  resetElectionTimer();
}, Math.random() * 200);
console.log(`[${state.nodeId}] RAFT module loaded`);

module.exports = { handleRequestVote, handleAppendEntries, handleHeartbeat, handleSyncLog };
