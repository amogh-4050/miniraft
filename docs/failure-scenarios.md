# MiniRAFT Failure Scenarios

This document describes how the MiniRAFT system behaves under various failure conditions.

The system is designed to remain available and consistent using the RAFT consensus algorithm.

---

# Failure Scenarios Table

| Scenario | Expected Behavior |
|---------|-------------------|
| **Leader killed** | Followers stop receiving heartbeats. After timeout, a new election begins. One follower becomes candidate, gathers majority votes, and becomes the new leader. Gateway updates leader reference automatically. System continues accepting strokes. |
| **Follower restarted** | Restarted follower rejoins cluster as follower. Leader synchronizes missing log entries using `/sync-log`. Follower catches up to latest committed state and resumes normal operation. |
| **All 3 replicas killed** | Cluster becomes unavailable temporarily. When replicas restart, a new leader election occurs. System resumes once a leader is elected. No new strokes are accepted until leader exists. |
| **Hot-reload of leader** | Leader process restarts temporarily. Followers detect missing heartbeats and start election. A new leader is elected if timeout expires. Gateway automatically detects the new leader. |
| **Split vote** | Multiple candidates start election simultaneously. Votes are split and no leader is elected. Election timeout resets and another election cycle begins until majority is achieved. |
| **Stale leader receives stroke** | If an old leader receives a stroke after losing leadership, it rejects the request with `"not leader"` error. Gateway redirects requests to the correct leader. |
| **New browser joins mid-session** | When a new browser connects, Gateway requests `/log` from leader. Committed log entries are sent to the browser. Canvas initializes with current drawing state. |

---

# Notes

MiniRAFT maintains consistency and availability using:

- Leader election
- Majority quorum commit rule
- Log replication
- Heartbeat mechanism
- Automatic recovery

These mechanisms ensure that the distributed drawing system continues functioning even during node failures.