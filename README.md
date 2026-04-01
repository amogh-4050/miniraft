# MiniRAFT — Distributed Real-Time Drawing Board

Cloud Computing mini-project (PES University, 2025).  
A fault-tolerant collaborative whiteboard backed by a mini-RAFT consensus protocol across 3 Docker replicas.

---

## Architecture

```
Browser(s)
    │  WebSocket
    ▼
 Gateway :8080
    │  HTTP RPC
    ├──▶ Replica 1 :3001
    ├──▶ Replica 2 :3002
    └──▶ Replica 3 :3003
         (all on raft-net Docker bridge)
```

---

## Prerequisites

| Tool | Required Version |
|---|---|
| Docker | 24+ |
| Docker Compose plugin | v2 (use `docker compose` not `docker-compose`) |
| Git | any |

---

## Setup — Ubuntu / WSL2 (Recommended for all members)

### 1. Install Docker

```bash
sudo apt update
sudo apt install docker.io docker-compose-plugin -y
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Clone the repo

```bash
# Clone inside Linux filesystem — NOT /mnt/c on Windows
cd ~
git clone https://github.com/amogh-4050/miniraft.git
cd miniraft
```

### 3. Build images

```bash
docker compose build
```

First build takes ~2 minutes. Subsequent builds use layer cache and are much faster.

### 4. Start the cluster

```bash
docker compose up
```

Leave this terminal open — all replica + gateway logs appear here.

### 5. Verify everything is healthy

Open a second terminal:

```bash
docker compose ps
```

All four services should show `Up (healthy)` or `Up`.

```bash
curl http://localhost:3001/status | jq
curl http://localhost:3002/status | jq
curl http://localhost:3003/status | jq
```

Each should return JSON with `role`, `term`, `commitIndex`.

---

## Setup — Windows

> **Critical:** Do everything inside WSL2, not PowerShell or CMD. Bind mounts are 10x slower from the Windows filesystem.

### 1. Install WSL2

Open PowerShell as Administrator:

```powershell
wsl --install
# Restart your machine when prompted
```

### 2. Install Docker Desktop

- Download from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)
- During install: enable **WSL2 backend** (not Hyper-V)
- After install: Docker Desktop → Settings → Resources → WSL Integration → enable your distro

### 3. Open WSL2 terminal

Use Windows Terminal and select your Ubuntu/WSL2 profile.

### 4. Follow Ubuntu steps above from Step 2 onwards

Everything from `git clone` onward is identical to Ubuntu.

---

## Hot Reload (Edit → Auto Restart)

Each replica folder is bind-mounted into its container. Saving any `.js` file triggers nodemon to restart that container automatically — no manual restart needed.

```bash
# Example: edit replica1 code
code replica1/index.js   # save the file
# Watch the docker compose terminal — replica1 restarts within 1 second
```

---

## Useful Commands

```bash
# Start in background
docker compose up -d

# View logs
docker compose logs -f

# View logs for one service
docker compose logs -f replica1

# Restart one replica (triggers RAFT election)
docker compose restart replica1

# Kill one replica (simulates failure)
docker compose stop replica1

# Bring it back
docker compose start replica1

# Full teardown
docker compose down

# Rebuild after Dockerfile changes
docker compose build --no-cache
```

---

## Project Structure

```
miniraft/
├── docker-compose.yml
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── index.js          ← WebSocket server + leader tracking
├── replica1/             ← identical structure for 2 and 3
│   ├── Dockerfile
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── index.js          ← Express server + RAFT logic
├── frontend/
│   └── index.html        ← Canvas UI
└── docs/
    ├── architecture.md
    ├── api-spec.md
    └── failure-scenarios.md
```

---

## API Reference (Quick)

| Method | Endpoint | Called By | Purpose |
|---|---|---|---|
| GET | `/status` | Gateway | Get node role, term, commitIndex |
| GET | `/log` | Gateway | Get full committed log |
| POST | `/stroke` | Gateway | Submit a stroke (leader only) |
| POST | `/request-vote` | Peers | RAFT vote request |
| POST | `/append-entries` | Leader | Log replication + heartbeat |
| POST | `/heartbeat` | Leader | Keep followers alive |
| POST | `/sync-log` | Leader | Catch up a rejoining node |

Full schemas in `docs/api-spec.md`.

---

## Environment Variables

| Variable | Service | Example |
|---|---|---|
| `PORT` | Replica | `3001` |
| `NODE_ID` | Replica | `replica1` |
| `PEERS` | Replica | `http://replica2:3002,http://replica3:3003` |
| `PORT` | Gateway | `8080` |
| `REPLICAS` | Gateway | `http://replica1:3001,...` |

Set in `docker-compose.yml` — do not hardcode in source files.

---

## Team

| Member | Owns |
|---|---|
| Amogh Singh | Docker infrastructure, Gateway |
| Member 2 | RAFT core logic (`raft.js`) |
| Member 3 | Frontend canvas |
