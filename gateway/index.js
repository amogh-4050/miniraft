import express from "express";
import axios from "axios";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

// 🔧 ENV
const REPLICAS = process.env.REPLICAS.split(",");
const PORT = process.env.PORT || 8080;

// 🧠 Leader tracking
let currentLeader = null;

// 🔍 Find current leader
async function findLeader() {
    for (const replica of REPLICAS) {
        try {
            const res = await axios.get(`${replica}/status`, { timeout: 300 });

            if (res.data.role === "leader") {
                currentLeader = replica;
                console.log(`[gateway] Leader found: ${replica}`);
                return replica;
            }
        } catch (err) {
            // ignore dead nodes
        }
    }

    currentLeader = null;
    return null;
}

// 🔥 Send request to leader (WITH RETRY)
async function sendToLeader(path, data) {
    for (let i = 0; i < 5; i++) {
        try {
            if (!currentLeader) {
                await findLeader();
            }

            if (!currentLeader) throw new Error("No leader");

            return await axios.post(`${currentLeader}${path}`, data, {
                timeout: 500
            });

        } catch (err) {
            console.log(`[gateway] retry ${i + 1}...`);
            currentLeader = null;

            // wait for election
            await new Promise(res => setTimeout(res, 200));
        }
    }

    throw new Error("No leader available after retries");
}

// 🌐 HTTP route (optional testing)
app.post("/stroke", async (req, res) => {
    try {
        const response = await sendToLeader("/stroke", req.body);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: "No leader available" });
    }
});

// ✅ FIXES YOUR 404 ERROR
app.post("/leader", (req, res) => {
    console.log("[gateway] leader update:", req.body);
    res.json({ status: "ok" });
});

// 🚀 Start server
const server = app.listen(PORT, () => {
    console.log(`[gateway] running on ${PORT}`);
});

// 🔌 WebSocket (for frontend)
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
    console.log("[gateway] client connected");

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);

            const response = await sendToLeader("/stroke", data);

            // broadcast to all clients
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify(response.data));
                }
            });

        } catch (err) {
            ws.send(JSON.stringify({ error: "Failed to process request" }));
        }
    });
});
