# MiniRAFT Architecture

## Overview

MiniRAFT is a distributed real-time collaborative drawing system built using a simplified RAFT consensus protocol. The system consists of a browser-based frontend, a WebSocket gateway, and three replica nodes that maintain a consistent shared drawing log.

The architecture ensures fault tolerance, leader election, and consistent state replication across multiple nodes.

---

## Cluster Architecture Diagram


Browser Clients
│ WebSocket
▼
Gateway :8080
│ HTTP RPC
├── Replica1 :3001
├── Replica2 :3002
└── Replica3 :3003
(all connected via raft-net Docker network)


---

## System Components

### 1. Frontend (Browser)

The frontend is a browser-based drawing canvas that allows users to create drawing strokes in real time.

Responsibilities:

- Capture user drawing input
- Send stroke events to the Gateway using WebSocket
- Render committed strokes received from the Gateway
- Synchronize drawings across multiple users

The frontend connects to the Gateway using:


ws://localhost:8080


---

### 2. Gateway Service

The Gateway acts as the central communication hub between browser clients and replica nodes.

Responsibilities:

- Accept WebSocket connections from browser clients
- Forward incoming drawing strokes to the current leader replica
- Track the current leader replica
- Broadcast committed strokes back to all connected clients
- Redirect traffic when leader changes

The Gateway exposes:


Port 8080 — Public WebSocket Port


This port is accessed directly by browser clients.

---

### 3. Replica Nodes

There are three replica nodes in the system:


Replica1 :3001
Replica2 :3002
Replica3 :3003


Each replica runs an Express-based HTTP server implementing a simplified RAFT protocol.

Replica Responsibilities:

- Maintain an append-only stroke log
- Participate in leader election
- Replicate log entries to peers
- Commit entries when majority acknowledges
- Handle synchronization of restarted nodes

Each replica can exist in one of three states:

- Follower
- Candidate
- Leader

Leader Election:

If a follower does not receive a heartbeat within a timeout, it becomes a candidate and requests votes from other replicas.

---

## Docker Networking — Service Discovery

All services are connected using a shared Docker bridge network called:


raft-net


Docker automatically assigns hostnames to containers using their service names.

This allows containers to communicate using service names instead of IP addresses.

Example:


http://replica1:3001

http://replica2:3002

http://replica3:3003


Here:

- `replica1` resolves to the Replica1 container
- `replica2` resolves to the Replica2 container
- `replica3` resolves to the Replica3 container

This mechanism is called:


Docker Service Discovery


It ensures reliable communication between containers.

---

## Port Configuration

The system uses two main types of ports:

### Public Port


8080 — Gateway WebSocket Port


Used for:

- Browser connections
- Real-time drawing communication

Accessible from outside Docker.

---

### Internal Replica Ports


3001 — Replica1
3002 — Replica2
3003 — Replica3


Used for:

- Inter-replica communication
- Gateway-to-replica RPC calls
- RAFT consensus communication

These ports are used inside the Docker network.

---

## Request Flow Example

When a user draws on the canvas:

1. Browser sends stroke to Gateway
2. Gateway forwards stroke to Leader Replica
3. Leader appends stroke to its log
4. Leader sends AppendEntries RPC to followers
5. Followers acknowledge receipt
6. Leader commits the entry
7. Gateway broadcasts committed stroke to all clients

This ensures:

- Consistent drawings
- Fault tolerance
- Real-time synchronization

---

## Fault Tolerance Design

The system tolerates failures using the RAFT protocol.

If the leader fails:

1. Followers detect missing heartbeat
2. New election begins
3. New leader is selected
4. System continues without downtime

If a follower restarts:

1. Leader synchronizes missing log entries
2. Follower rejoins cluster
3. State remains consistent

---

## Summary

MiniRAFT uses a distributed cluster architecture consisting of:

- Browser Frontend
- WebSocket Gateway
- Three RAFT Replica Nodes

This architecture ensures:

- High availability
- Fault tolerance
- Consistent distributed state
- Real-time collaboration