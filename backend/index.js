const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const os = require('os');

const app = express();
const HISTORY_FILE = './transfers.json';
const isWin = os.platform() === 'win32';
const coreCommand = isWin ? './core.exe' : './core';
const senderCommand = isWin ? './sender.exe' : './sender';

// Helper to load transfer history
function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    try {
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error("Error loading history:", e);
        return [];
    }
}

// Helper to save transfer history
function saveHistory(history) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error("Error saving history:", e);
    }
}

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
const coreEngine = spawn(coreCommand);

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
            const parts = line.split('INCOMING_REQUEST:');
            if (parts.length > 1) {
                const payload = parts[1].trim();
                const [id, filename, size, sender] = payload.split('|');
                
                // GAP 3 FIX: Record incoming transfers in history immediately
                const history = loadHistory();
                history.unshift({
                    id, filename, size: parseInt(size), sender, targetIp: 'localhost',
                    direction: 'received',
                    startTime: new Date().toISOString(),
                    status: 'pending'
                });
                saveHistory(history);

                console.log(`🔔 Transfer Request: \({sender} wants to send\){filename} (\({size} bytes) [ID:\){id}]`);
                io.emit('incoming-transfer-request', { id, filename, size, sender });
            }
        } else if (line.includes('TRANSFER_PROGRESS:')) {
            const parts = line.split('TRANSFER_PROGRESS:');
            if (parts.length > 1) {
                const payload = parts[1].trim();
                const [id, currentChunk, totalChunks] = payload.split('|');
                io.emit('transfer-progress', { id, currentChunk: parseInt(currentChunk), totalChunks: parseInt(totalChunks) });
            }
        } else if (line.startsWith('RECEIVED_OK|')) {
            // GAP 3 FIX: Mark received transfer as complete in history
            const id = line.split('|')[1].trim();
            const history = loadHistory();
            const idx = history.findIndex(t => t.id === id);
            if (idx !== -1) {
                history[idx].status = 'success';
                history[idx].endTime = new Date().toISOString();
                saveHistory(history);
            }
            io.emit('transfer-progress', { id, status: 'completed' });
        } else if (line.startsWith('ERROR:')) {
            // GAP 2 FIX: Generic error parser for Core Engine
            const rawError = line.substring(6).trim();
            const [code, id] = rawError.split('|');

            const errorMessages = {
                'CHECKSUM_MISMATCH': 'The received file is corrupted.',
                'DISK_FULL': 'Receiver disk is full.',
                'PERMISSION_DENIED': 'Receiver could not write the file.',
                'TRANSFER_REJECTED': 'The transfer was rejected.',
                'RESUME_STATE_INVALID': 'Cannot resume from the current state.',
                'PEER_DISCONNECTED': 'The peer disconnected unexpectedly.',
                'FILE_BUSY': 'A file with this name is already being received.'
            };

            const message = errorMessages[code] || 'An unknown error occurred.';
            console.log(`❌ Receiver Error [ID: \({id || 'System'}]:\){code}`);
            
            io.emit('transfer-error', { id, code, message });

            if (id) {
                const history = loadHistory();
                const idx = history.findIndex(t => t.id === id);
                if (idx !== -1) {
                    history[idx].status = 'failed';
                    history[idx].endTime = new Date().toISOString();
                    saveHistory(history);
                }
            }
        } else if (line.trim().length > 0) {
            console.log(`⚙️ [C++] ${line.trim()}`);
        }
    });
});

coreEngine.on('error', (err) => {
    console.error('❌ Failed to start C++ Core Engine. Did you compile it?', err.message);
});

// --- TRANSFER DECISION ROUTE ---
app.post('/transfer/decision', (req, res) => {
    const { id, decision } = req.body;
    if (!id || !decision) return res.status(400).json({ error: "id and decision required" });

    const command = decision === 'accept' ? `REQUEST_ACCEPT:\({id}\n` : `REQUEST_REJECT:\){id}\n`;
    console.log(`⚖️ Decision for \({id}:\){decision}`);
    coreEngine.stdin.write(command);
    res.json({ success: true });
});

// --- HISTORY API ---
app.get('/api/transfers', (req, res) => {
    res.json(loadHistory());
});

// Track active transfers: transferId -> { process, filename, targetIp }
const activeTransfers = new Map();

// --- FILE UPLOAD & SEND ROUTE ---
app.post('/send', upload.single('file'), (req, res) => {
    const { targetIp } = req.body;
    const filePath = req.file.path;

    if (!targetIp) {
        return res.status(400).json({ error: "Target IP missing" });
    }

    const transferId = Date.now().toString();
    const filename = req.file.originalname;

    const history = loadHistory();
    const newTransfer = {
        id: transferId,
        filename: filename,
        size: req.file.size,
        targetIp,
        direction: 'sent', // GAP 3 FIX: Distinguish sent vs received
        startTime: new Date().toISOString(),
        status: 'pending'
    };
    history.unshift(newTransfer);
    saveHistory(history);

    console.log(`🚀 Starting async send: \({filename} →\){targetIp} [ID: ${transferId}]`);

    // FINAL ID SYNC FIX: Pass transferId as argv[3]
    const sender = spawn(senderCommand, [targetIp, filePath, transferId]);
    
    activeTransfers.set(transferId, { process: sender, filename, targetIp });
    
    sender.on('error', (err) => {
        console.error(`❌ Failed to start C++ Sender for ${transferId}.`, err.message);
        activeTransfers.delete(transferId);
    });

    sender.stdout.on("data", (data) => {
        const output = data.toString();
        const lines = output.split('\n');

        lines.forEach(line => {
            if (line.startsWith('SENDER_PROGRESS:')) {
                const parts = line.substring(16).split('|');
                if (parts.length === 3) {
                    const [sId, current, total] = parts;
                    const progress = Math.round((parseInt(current) / parseInt(total)) * 100);
                    io.emit('sending-progress', {
                        transferId: transferId,
                        filename,
                        progress,
                        status: 'sending'
                    });
                }
            } else if (line.startsWith('ERROR:')) {
                // GAP 2 FIX: Generic error parser for Sender Process
                const rawError = line.substring(6).trim();
                const [code, id] = rawError.split('|');
                
                const errorMessages = {
                    'CHECKSUM_MISMATCH': 'The received file is corrupted.',
                    'DISK_FULL': 'Receiver disk is full.',
                    'PERMISSION_DENIED': 'Receiver could not write the file.',
                    'TRANSFER_REJECTED': 'The transfer was rejected.',
                    'PEER_DISCONNECTED': 'The peer disconnected unexpectedly.',
                    'FILE_BUSY': 'A file with this name is already being received.'
                };

                const message = errorMessages[code] || 'An unknown error occurred.';
                console.log(`❌ Sender Error [ID: \({id || 'System'}]:\){code}`);
                
                io.emit('transfer-error', { id, code, message });

                if (id) {
                    const h = loadHistory();
                    const idx = h.findIndex(t => t.id === id);
                    if (idx !== -1) {
                        h[idx].status = 'failed';
                        h[idx].endTime = new Date().toISOString();
                        saveHistory(h);
                    }
                }
            } else if (line.trim().length > 0) {
                console.log(`📤 [SENDER \({transferId}]:\){line.trim()}`);
            }
        });
    });

    sender.stderr.on("data", (data) => {
        console.error(`❌ [SENDER \({transferId} ERROR]:\){data.toString()}`);
    });

    sender.on('close', (code) => {
        console.log(`🏁 Sender \({transferId} finished (Code:\){code})`);

        const currentHistory = loadHistory();
        const idx = currentHistory.findIndex(t => t.id === transferId);
        if (idx !== -1) {
            currentHistory[idx].endTime = new Date().toISOString();
            // Code 0 means success. Anything else is failure, but if our ERROR parser
            // already caught a network drop and marked it failed, don't overwrite it.
            if (currentHistory[idx].status === 'pending') {
                currentHistory[idx].status = code === 0 ? 'success' : 'failed';
            }
            saveHistory(currentHistory);
        }

        io.emit('sending-progress', {
            transferId,
            filename,
            status: code === 0 ? 'completed' : 'failed'
        });

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        activeTransfers.delete(transferId);
    });

    res.json({ success: true, transferId });
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