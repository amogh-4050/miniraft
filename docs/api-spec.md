# MiniRAFT API Specification

This document defines all API endpoints used in the MiniRAFT distributed system.

The system consists of:

- Gateway (client-facing)
- Replica Nodes (RAFT cluster)
- Browser Clients (via WebSocket)

All HTTP APIs are exposed by replica nodes unless otherwise specified.

---

# 1. GET /status

Purpose:
Returns the current state of a replica node.

Called By:
- Gateway (leader discovery)

Request:

```http
GET /status

Response:

{
  "nodeId": "replica1",
  "role": "leader",
  "term": 1,
  "commitIndex": 5,
  "logLength": 6,
  "leaderId": "replica1"
}

Fields:

Field	Description
nodeId	Replica identifier
role	follower / candidate / leader
term	Current RAFT term
commitIndex	Last committed log index
logLength	Total entries in log
leaderId	Current leader ID
2. GET /log

Purpose:
Returns committed log entries.

Used to synchronize new browser clients.

Called By:

Gateway

Request:

GET /log

Response:

{
  "entries": [
    {
      "index": 0,
      "term": 1,
      "stroke": {
        "x": 120,
        "y": 250,
        "color": "black",
        "size": 4
      }
    }
  ]
}
3. POST /stroke

Purpose:
Adds a new drawing stroke to the RAFT log.

Only leader accepts this request.

Called By:

Gateway → Leader

Request:

{
  "stroke": {
    "x": 120,
    "y": 250,
    "color": "black",
    "size": 4
  }
}

Response (Success):

{
  "success": true,
  "index": 5
}

Response (Not Leader):

{
  "error": "not leader",
  "leaderId": "replica2"
}

Response (Replication Failed):

{
  "error": "replication failed"
}
4. POST /request-vote

Purpose:
Requests votes during leader election.

Called By:

Candidate replicas

Request:

{
  "term": 2,
  "candidateId": "replica2",
  "lastLogIndex": 4,
  "lastLogTerm": 1
}

Response:

{
  "term": 2,
  "voteGranted": true
}
5. POST /append-entries

Purpose:
Replicates log entries to followers.

Called By:

Leader → Followers

Request:

{
  "term": 2,
  "leaderId": "replica2",
  "entry": {
    "index": 5,
    "term": 2,
    "stroke": {
      "x": 150,
      "y": 200,
      "color": "black",
      "size": 4
    }
  },
  "prevLogIndex": 4,
  "prevLogTerm": 1,
  "leaderCommit": 4
}

Response:

{
  "term": 2,
  "success": true
}
6. POST /heartbeat

Purpose:
Maintains leader authority and prevents elections.

Called By:

Leader → Followers

Request:

{
  "term": 2,
  "leaderId": "replica2",
  "leaderCommit": 4
}

Response:

{
  "term": 2,
  "success": true
}
7. POST /sync-log

Purpose:
Synchronizes missing log entries to a rejoining node.

Called By:

Leader → Follower

Request:

{
  "term": 2,
  "leaderId": "replica2",
  "fromIndex": 3
}

Response:

{
  "term": 2,
  "success": true,
  "entries": [
    {
      "index": 3,
      "term": 2,
      "stroke": {
        "x": 100,
        "y": 150
      }
    }
  ],
  "leaderCommit": 5
}
API Summary Table
Endpoint	Method	Called By	Purpose
/status	GET	Gateway	Leader discovery
/log	GET	Gateway	Fetch committed log
/stroke	POST	Gateway → Leader	Add stroke
/request-vote	POST	Candidate	Election
/append-entries	POST	Leader	Log replication
/heartbeat	POST	Leader	Keep followers alive
/sync-log	POST	Leader	Recover follower