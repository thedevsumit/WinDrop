const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const multer = require('multer');
const fs = require('fs');

const app = express();
const os = require('os');

// Helper to get all IP addresses of the CURRENT machine
function getMyIPs() {
    const ips = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}
const myIps = getMyIPs();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 🔥 STORE UNIQUE PEERS
const peers = new Map();

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
        cb(null, './uploads');
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// --- SPAWN CORE ENGINE ---
const coreEngine = spawn('./core');

coreEngine.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');

    lines.forEach(line => {
        if (line.includes('Founded Peer:')) {
            const parts = line.split('Founded Peer: ');
            if (parts.length > 1) {
                const raw = parts[1].replace(' Alive', '').trim();
                if (raw.includes(':')) {
                    const [name, ip] = raw.split(':');
                    if (!ip || ip === "127.0.0.1" || myIps.includes(ip)) return;
                    peers.set(ip, name);
                    const peerList = Array.from(peers.entries()).map(([ip, name]) => ({
                        name,
                        ip
                    }));
                    console.log("🟢 Active Devices:", peerList);
                    io.emit('peers_list', peerList);
                }
            }
        } else if (line.includes('INCOMING_REQUEST:')) {
            const parts = line.split('INCOMING_REQUEST: ');
            if (parts.length > 1) {
                const payload = parts[1].trim();
                const [id, filename, size, sender] = payload.split('|');
                console.log(`🔔 Transfer Request: ${sender} wants to send ${filename} (${size} bytes) [ID: ${id}]`);
                io.emit('incoming-transfer-request', { id, filename, size, sender });
            }
        } else if (line.includes('TRANSFER_PROGRESS:')) {
            const parts = line.split('TRANSFER_PROGRESS: ');
            if (parts.length > 1) {
                const payload = parts[1].trim();
                const [id, currentChunk, totalChunks] = payload.split('|');
                io.emit('transfer-progress', { id, currentChunk: parseInt(currentChunk), totalChunks: parseInt(totalChunks) });
            }
        } else if (line.trim().length > 0) {
            console.log(`⚙️ [C++] ${line.trim()}`);
        }
    });
});

// --- TRANSFER DECISION ROUTE ---
app.post('/transfer/decision', (req, res) => {
    const { id, decision } = req.body;
    if (!id || !decision) return res.status(400).json({ error: "id and decision required" });

    const command = decision === 'accept' ? `REQUEST_ACCEPT:${id}\n` : `REQUEST_REJECT:${id}\n`;
    console.log(`⚖️ Decision for ${id}: ${decision}`);
    coreEngine.stdin.write(command);
    res.json({ success: true });
});

// --- FILE UPLOAD & SEND ROUTE ---
app.post('/send', upload.single('file'), (req, res) => {
    const { targetIp } = req.body;
    const filePath = req.file.path;

    if (!targetIp) {
        return res.status(400).json({ error: "Target IP missing" });
    }

    console.log(`🚀 Sending ${req.file.originalname} → ${targetIp}`);

    const sender = spawn('./sender', [targetIp, filePath]);

    sender.stdout.on("data", (data) => {
        console.log(`📤 [SENDER]: ${data.toString()}`);
    });

    sender.stderr.on("data", (data) => {
        console.error(`❌ [SENDER ERROR]: ${data.toString()}`);
    });

    sender.on('close', (code) => {
        console.log(`🏁 Sender finished (Code: ${code})`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.json({ success: code === 0 });
    });
});

// --- SOCKET CONNECTION ---
io.on("connection", (socket) => {
    console.log("🔌 Client connected");
    const peerList = Array.from(peers.entries()).map(([ip, name]) => ({
        name,
        ip
    }));
    socket.emit("peers_list", peerList);
});

server.listen(5000, () =>
    console.log('✅ Lighthouse Backend at http://localhost:5000')
);
