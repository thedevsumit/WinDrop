const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseIdAndFields } = require('./wireParsers');

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
const io = new Server(server, {
    cors: { origin: "*" }
});

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

// For folder uploads, the frontend appends each file with its relative
// path AS the filename (see the frontend section) — e.g. a file at
// "photos/vacation/img1.jpg" arrives here with originalname exactly that.
// Multer's flat filename() above would collide different subdirectories'
// files if they happened to share a basename, so folder uploads use a
// dedicated storage config that reconstructs the real subdirectory
// structure under a per-transfer temp folder instead.
const folderStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempFolder = req.tempFolderPath; // set in the route handler before multer runs
        const relDir = path.dirname(file.originalname);
        const fullDir = relDir === '.' ? tempFolder : path.join(tempFolder, relDir);
        fs.mkdirSync(fullDir, { recursive: true });
        cb(null, fullDir);
    },
    filename: (req, file, cb) => cb(null, path.basename(file.originalname))
});

// Assigns req.tempFolderPath BEFORE multer's own middleware runs, since
// folderStorage's destination callback above depends on it already existing.
function assignFolderTempPath(req, res, next) {
    const transferId = Date.now().toString();
    req.transferId = transferId;
    req.tempFolderPath = path.join('./uploads', `folder_${transferId}`);
    fs.mkdirSync(req.tempFolderPath, { recursive: true });
    next();
}

const uploadFolder = multer({ storage: folderStorage });

// --- SPAWN CORE ENGINE ---
const coreEngine = spawn(coreCommand);

// Folder IDs the user has already accepted as a whole — per-file REQUESTs
// arriving under one of these (id pattern "<folderId>_<index>") are
// auto-accepted without prompting the user again, since the decision to
// receive the folder was already made once.
const acceptedFolderSessions = new Set();
const rejectedFolderSessions = new Set();

// Per-folder aggregate state, keyed by folderId, so the UI can show
// "file 2 of 4" instead of raw per-file IDs.
const folderReceiveState = new Map();

// Filename for each per-file id inside a folder RECEIVE, so a later
// ERROR line (which only carries the id) can be reported against the
// actual relative path rather than a meaningless per-file id.
const folderReceiveFileNames = new Map();
// Accumulated {path, code}[] per folder RECEIVE transfer, for the final
// FOLDER_TRANSFER_COMPLETE summary and for display/history.
const folderReceiveFailedFiles = new Map();

// Same two concerns, mirrored for a folder SEND: which file is currently
// being sent (from the sender's own "📄 (i/N) relPath" progress line),
// and which files ultimately failed.
const folderSendCurrentFile = new Map();
const folderSendFailedFiles = new Map();

function folderIdOf(perFileId) {
    const idx = perFileId.lastIndexOf('_');
    if (idx === -1) return null;
    return perFileId.substring(0, idx);
}

// Wraps a child process's stdout so the callback always receives complete
// lines, never a fragment. Node's 'data' event delivers whatever bytes the
// OS pipe happened to have ready -- there is no guarantee a line written by
// the C++ side in one call arrives in one 'data' event. Splitting each
// chunk on '\n' independently (the previous approach) silently corrupts
// any line that happens to straddle a chunk boundary: this is exactly what
// turned "INCOMING_REQUEST:id|filename|size|sender" into two separate,
// meaningless fragments in testing, which made the auto-accept logic for
// folder transfers never fire and left the receiver hung waiting for a
// decision indefinitely.
function onCompleteLines(stream, callback) {
    let buffer = '';
    stream.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // last element is either '' or an incomplete line -- keep it for next time
        lines.forEach(line => callback(line));
    });
}

onCompleteLines(coreEngine.stdout, (rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;

    {

        if (line.includes('Founded Peer:')) {

            const parts = line.split('Founded Peer: ');

            if (parts.length > 1) {
                const raw = parts[1].replace(' Alive', '').trim();

                if (raw.includes(':')) {
                    const [name, ip] = raw.split(':');

                    if (!ip || ip === "127.0.0.1" || myIps.includes(ip)) {
                        return;
                    }

                    peers.set(ip, name);

                    const peerList = Array.from(peers.entries()).map(([ip, name]) => ({
                        name,
                        ip
                    }));

                    console.log("🟢 Active Devices:", peerList);

                    io.emit('peers_list', peerList);
                }
            }

        } else if (line.includes('INCOMING_FOLDER_REQUEST:')) {

            const payload = line.split('INCOMING_FOLDER_REQUEST:')[1].trim();
            const [id, folderName, fileCount, totalSize, sender] = payload.split('|');

            folderReceiveState.set(id, {
                folderName,
                fileCount: parseInt(fileCount),
                totalSize: parseInt(totalSize),
                sender,
                filesCompleted: 0
            });

            const history = loadHistory();
            history.unshift({
                id,
                filename: folderName,
                size: parseInt(totalSize),
                fileCount: parseInt(fileCount),
                sender,
                targetIp: 'localhost',
                direction: 'received',
                isFolder: true,
                startTime: new Date().toISOString(),
                status: 'pending'
            });
            saveHistory(history);

            console.log(`🔔 Folder Request: ${sender} wants to send "${folderName}" (${fileCount} files, ${totalSize} bytes) [ID:${id}]`);

            io.emit('incoming-folder-request', {
                id,
                folderName,
                fileCount: parseInt(fileCount),
                totalSize: parseInt(totalSize),
                sender
            });

        } else if (line.includes('FOLDER_TRANSFER_COMPLETE:')) {

            const payload = line.split('FOLDER_TRANSFER_COMPLETE:')[1].trim();
            const { id, fields } = parseIdAndFields(payload);
            const received = fields.received || 0;
            const failed = fields.failed || 0;
            const total = fields.total || 0;

            const history = loadHistory();
            const idx = history.findIndex(t => t.id === id);
            const failedFiles = folderReceiveFailedFiles.get(id) || [];
            if (idx !== -1) {
                history[idx].status = (failed === 0 && received === total) ? 'success' : 'partial';
                history[idx].filesReceived = received;
                history[idx].filesFailed = failed;
                history[idx].failedFiles = failedFiles;
                history[idx].endTime = new Date().toISOString();
                saveHistory(history);
            }

            io.emit('folder-progress', {
                id,
                direction: 'receive',
                filesCompleted: received,
                filesFailed: failed,
                fileCount: total,
                failedFiles,
                status: (failed === 0 && received === total) ? 'completed' : 'partial'
            });

            folderReceiveState.delete(id);
            acceptedFolderSessions.delete(id);
            folderReceiveFailedFiles.delete(id);
            // Individual per-file-id entries in folderReceiveFileNames are
            // small and self-limiting (one per file ever received), but
            // clear the ones for this folder now rather than let them sit.
            for (const key of folderReceiveFileNames.keys()) {
                if (folderIdOf(key) === id) folderReceiveFileNames.delete(key);
            }

        } else if (line.includes('INCOMING_REQUEST:')) {

            const parts = line.split('INCOMING_REQUEST:');

            if (parts.length > 1) {
                const payload = parts[1].trim();
                const [id, filename, size, sender] = payload.split('|');
                const parentFolderId = folderIdOf(id);

                if (parentFolderId && acceptedFolderSessions.has(parentFolderId)) {
                    // This file belongs to a folder the user already
                    // accepted as a whole — auto-accept it and don't
                    // surface a second prompt.
                    coreEngine.stdin.write(`REQUEST_ACCEPT:${id}\n`);
                    folderReceiveFileNames.set(id, filename);

                    const folderState = folderReceiveState.get(parentFolderId);
                    io.emit('folder-progress', {
                        id: parentFolderId,
                        direction: 'receive',
                        currentFile: filename,
                        filesCompleted: folderState ? folderState.filesCompleted : 0,
                        fileCount: folderState ? folderState.fileCount : null,
                        status: 'receiving'
                    });
                    return;
                }

                if (parentFolderId && rejectedFolderSessions.has(parentFolderId)) {
                    // Folder was rejected — reject every per-file REQUEST
                    // that still arrives under it too.
                    coreEngine.stdin.write(`REQUEST_REJECT:${id}\n`);
                    return;
                }

                // Ordinary standalone single-file request — existing behavior.
                const history = loadHistory();
                history.unshift({
                    id,
                    filename,
                    size: parseInt(size),
                    sender,
                    targetIp: 'localhost',
                    direction: 'received',
                    startTime: new Date().toISOString(),
                    status: 'pending'
                });
                saveHistory(history);

                console.log(`🔔 Transfer Request: ${sender} wants to send ${filename} (${size} bytes) [ID:${id}]`);

                io.emit('incoming-transfer-request', { id, filename, size, sender });
            }

        } else if (line.includes('TRANSFER_PROGRESS:')) {

            const parts = line.split('TRANSFER_PROGRESS:');

            if (parts.length > 1) {
                const payload = parts[1].trim();
                const [id, currentChunk, totalChunks] = payload.split('|');
                const parentFolderId = folderIdOf(id);

                if (parentFolderId && folderReceiveState.has(parentFolderId)) {
                    io.emit('folder-progress', {
                        id: parentFolderId,
                        fileProgress: Math.round((parseInt(currentChunk) / parseInt(totalChunks)) * 100),
                        filesCompleted: folderReceiveState.get(parentFolderId).filesCompleted,
                        fileCount: folderReceiveState.get(parentFolderId).fileCount,
                        status: 'receiving'
                    });
                    return;
                }

                io.emit('transfer-progress', {
                    id,
                    currentChunk: parseInt(currentChunk),
                    totalChunks: parseInt(totalChunks)
                });
            }

        } else if (line.startsWith('RECEIVED_OK|')) {

            const id = line.split('|')[1].trim();
            const parentFolderId = folderIdOf(id);

            if (parentFolderId && folderReceiveState.has(parentFolderId)) {
                const state = folderReceiveState.get(parentFolderId);
                state.filesCompleted++;
                io.emit('folder-progress', {
                    id: parentFolderId,
                    filesCompleted: state.filesCompleted,
                    fileCount: state.fileCount,
                    status: 'receiving'
                });
                return; // overall folder completion comes from FOLDER_TRANSFER_COMPLETE
            }

            const history = loadHistory();
            const idx = history.findIndex(t => t.id === id);
            if (idx !== -1) {
                history[idx].status = 'success';
                history[idx].endTime = new Date().toISOString();
                saveHistory(history);
            }

            io.emit('transfer-progress', { id, status: 'completed' });

        } else if (line.startsWith('ERROR:')) {
            // Generic error parser for Core Engine
            const rawError = line.substring(6).trim();
            const [code, id] = rawError.split('|');
            const parentFolderId = id ? folderIdOf(id) : null;

            const errorMessages = {
                'CHECKSUM_MISMATCH': 'The received file is corrupted.',
                'DISK_FULL': 'Receiver disk is full.',
                'CERT_MISMATCH': 'This peer\'s security certificate has changed since you last connected — possible security risk. Transfer blocked.',
                'TLS_HANDSHAKE_FAILED': 'Could not establish a secure connection to the peer.',
                'PERMISSION_DENIED': 'Receiver could not write the file.',
                'TRANSFER_REJECTED': 'The transfer was rejected.',
                'RESUME_STATE_INVALID': 'Cannot resume from the current state.',
                'PEER_DISCONNECTED': 'The peer disconnected unexpectedly.',
                'FILE_BUSY': 'A file with this name is already being received.'
            };

            const message = errorMessages[code] || 'An unknown error occurred.';

            console.log(`❌ Receiver Error [ID: ${id || 'System'}]: ${code}`);

            if (parentFolderId && folderReceiveState.has(parentFolderId)) {
                // A single file within a folder failed — surface it as a
                // folder-scoped warning, don't fail the whole folder UI;
                // FOLDER_TRANSFER_COMPLETE will report the true final count.
                const failedPath = folderReceiveFileNames.get(id) || id;
                if (!folderReceiveFailedFiles.has(parentFolderId)) {
                    folderReceiveFailedFiles.set(parentFolderId, []);
                }
                folderReceiveFailedFiles.get(parentFolderId).push({ path: failedPath, code });

                io.emit('folder-file-error', { folderId: parentFolderId, fileId: id, path: failedPath, code, message });
                return;
            }

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

        } else if (line.length > 0) {
            console.log(`⚙️ [C++] ${line}`);
        }
    }
});
coreEngine.on('error', (err) => {
    console.error(
        '❌ Failed to start C++ Core Engine. Did you compile it?',
        err.message
    );
});
// --- TRANSFER DECISION ROUTE ---
app.post('/transfer/decision', (req, res) => {
    const { id, decision, isFolder } = req.body;
    if (!id || !decision) {
        return res.status(400).json({
            error: "id and decision required"
        });
    }

    if (isFolder) {
        if (decision === 'accept') {
            acceptedFolderSessions.add(id);
            coreEngine.stdin.write(`FOLDER_ACCEPT:${id}\n`);
        } else {
            rejectedFolderSessions.add(id);
            coreEngine.stdin.write(`FOLDER_REJECT:${id}\n`);
            folderReceiveState.delete(id);
        }
        console.log(`⚖️ Folder decision for ${id}: ${decision}`);
        return res.json({ success: true });
    }

    // IMPORTANT:
    // Use the SAME transfer ID received from the frontend/core.
    // This ID is also used by the wire protocol.
    const command =
        decision === 'accept'
            ? `REQUEST_ACCEPT:${id}\n`
            : `REQUEST_REJECT:${id}\n`;

    console.log(`⚖️ Decision for ${id}: ${decision}`);

    coreEngine.stdin.write(command);

    res.json({
        success: true
    });
});

// --- HISTORY API ---
app.get('/api/transfers', (req, res) => {
    res.json(loadHistory());
});

// Track active transfers: transferId -> { process, filename, targetIp }
const activeTransfers = new Map();

// --- FILE UPLOAD & SEND ROUTE (single file, unchanged) ---
app.post('/send', upload.single('file'), (req, res) => {

    const { targetIp } = req.body;
    const filePath = req.file.path;

    if (!targetIp) {
        return res.status(400).json({
            error: "Target IP missing"
        });
    }

    const transferId = Date.now().toString();
    const filename = req.file.originalname;

    const history = loadHistory();
    const newTransfer = {
        id: transferId,
        filename: filename,
        size: req.file.size,
        targetIp,
        direction: 'sent',
        startTime: new Date().toISOString(),
        status: 'pending'
    };
    history.unshift(newTransfer);
    saveHistory(history);

    console.log(`🚀 Starting async send: ${filename} → ${targetIp} [ID: ${transferId}]`);

    const sender = spawn(senderCommand, [targetIp, filePath, transferId]);

    activeTransfers.set(transferId, { process: sender, filename, targetIp });

    sender.on('error', (err) => {
        console.error(`❌ Failed to start C++ Sender for ${transferId}.`, err.message);
        activeTransfers.delete(transferId);
    });

    onCompleteLines(sender.stdout, (rawLine) => {
        const line = rawLine.trim();
        if (line.length === 0) return;

        {
            if (line.startsWith('SENDER_PROGRESS:')) {
                const parts = line.substring(16).split('|');
                if (parts.length === 3) {
                    const [sId, current, total] = parts;
                    const progress = Math.round((parseInt(current) / parseInt(total)) * 100);
                    io.emit('sending-progress', { transferId, filename, progress, status: 'sending' });
                }
            } else if (line.startsWith('ERROR:')) {
                const rawError = line.substring(6).trim();
                const [code, id] = rawError.split('|');
                const errorMessages = {
                    'CERT_MISMATCH': 'This peer\'s security certificate has changed since you last connected — possible security risk. Transfer blocked.',
                    'TLS_HANDSHAKE_FAILED': 'Could not establish a secure connection to the peer.',
                    'CHECKSUM_MISMATCH': 'The received file is corrupted.',
                    'DISK_FULL': 'Receiver disk is full.',
                    'PERMISSION_DENIED': 'Receiver could not write the file.',
                    'TRANSFER_REJECTED': 'The transfer was rejected.',
                    'PEER_DISCONNECTED': 'The peer disconnected unexpectedly.',
                    'FILE_BUSY': 'A file with this name is already being received.'
                };
                const message = errorMessages[code] || 'An unknown error occurred.';
                console.log(`❌ Sender Error [ID: ${id || 'System'}]: ${code}`);
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
            } else if (line.length > 0) {
                console.log(`📤 [SENDER ${transferId}]: ${line}`);
            }
        }
    });

    sender.stderr.on("data", (data) => {
        console.error(`❌ [SENDER ${transferId} ERROR]: ${data.toString()}`);
    });

    sender.on('close', (code) => {
        console.log(`🏁 Sender ${transferId} finished (Code:${code})`);
        const currentHistory = loadHistory();
        const idx = currentHistory.findIndex(t => t.id === transferId);
        if (idx !== -1) {
            currentHistory[idx].endTime = new Date().toISOString();
            if (currentHistory[idx].status === 'pending') {
                currentHistory[idx].status = code === 0 ? 'success' : 'failed';
            }
            saveHistory(currentHistory);
        }
        io.emit('sending-progress', { transferId, filename, status: code === 0 ? 'completed' : 'failed' });
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        activeTransfers.delete(transferId);
    });

    res.json({ success: true, transferId });
});

// --- FOLDER UPLOAD & SEND ROUTE ---
// Frontend must append each File with its relative path as the filename:
//   formData.append('files', file, file.webkitRelativePath)
// so req.files[].originalname arrives here already carrying the
// subdirectory structure (e.g. "myFolder/photos/img1.jpg").
app.post('/send-folder', assignFolderTempPath, uploadFolder.array('files'), (req, res) => {

    const { targetIp } = req.body;
    const transferId = req.transferId;
    const tempFolderPath = req.tempFolderPath;

    if (!targetIp) {
        return res.status(400).json({ error: "Target IP missing" });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files received" });
    }

    // The uploaded relative paths are typically "topLevelFolderName/rest/of/path"
    // (that's what webkitRelativePath gives you) — buildManifest() on the
    // sender side walks tempFolderPath itself, so point it at the actual
    // folder root, one level in, to avoid double-nesting the folder name.
    const uploadedRoots = fs.readdirSync(tempFolderPath);
    const actualFolderRoot = uploadedRoots.length === 1 && fs.statSync(path.join(tempFolderPath, uploadedRoots[0])).isDirectory()
        ? path.join(tempFolderPath, uploadedRoots[0])
        : tempFolderPath;

    const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);
    const folderName = uploadedRoots.length === 1 ? uploadedRoots[0] : `folder_${transferId}`;

    const history = loadHistory();
    history.unshift({
        id: transferId,
        filename: folderName,
        size: totalSize,
        fileCount: req.files.length,
        targetIp,
        direction: 'sent',
        isFolder: true,
        startTime: new Date().toISOString(),
        status: 'pending'
    });
    saveHistory(history);

    console.log(`🚀 Starting async folder send: ${folderName} (${req.files.length} files) → ${targetIp} [ID: ${transferId}]`);

    const sender = spawn(senderCommand, [targetIp, actualFolderRoot, transferId, '--folder']);

    activeTransfers.set(transferId, { process: sender, filename: folderName, targetIp, isFolder: true });

    sender.on('error', (err) => {
        console.error(`❌ Failed to start C++ Sender (folder) for ${transferId}.`, err.message);
        activeTransfers.delete(transferId);
    });

    onCompleteLines(sender.stdout, (rawLine) => {
        const line = rawLine.trim();
        if (line.length === 0) return;

        {
            if (line.startsWith('SENDER_PROGRESS:')) {
                const parts = line.substring(16).split('|');
                if (parts.length === 3) {
                    const [perFileId, current, total] = parts;
                    const progress = Math.round((parseInt(current) / parseInt(total)) * 100);
                    io.emit('folder-progress', {
                        id: transferId,
                        direction: 'send',
                        currentFile: folderSendCurrentFile.get(transferId),
                        fileProgress: progress,
                        status: 'sending'
                    });
                }
            } else if (line.startsWith('📄')) {
                // "📄 (2/4) photos/img2.png" — surfaces which file is currently sending
                const match = line.match(/\((\d+)\/(\d+)\)\s+(.+)/);
                if (match) {
                    folderSendCurrentFile.set(transferId, match[3]);
                    io.emit('folder-progress', {
                        id: transferId,
                        direction: 'send',
                        currentFile: match[3],
                        filesCompleted: parseInt(match[1]) - 1,
                        fileCount: parseInt(match[2]),
                        status: 'sending'
                    });
                }
            } else if (line.startsWith('FOLDER_SEND_COMPLETE:')) {
                const payload = line.split('FOLDER_SEND_COMPLETE:')[1].trim();
                const { id, fields } = parseIdAndFields(payload);
                const sent = fields.sent || 0;
                const failed = fields.failed || 0;
                const total = fields.total || 0;
                const failedFiles = folderSendFailedFiles.get(id) || [];

                const h = loadHistory();
                const idx = h.findIndex(t => t.id === id);
                if (idx !== -1) {
                    h[idx].status = failed === 0 ? 'success' : 'partial';
                    h[idx].filesSent = sent;
                    h[idx].filesFailed = failed;
                    h[idx].failedFiles = failedFiles;
                    h[idx].endTime = new Date().toISOString();
                    saveHistory(h);
                }

                io.emit('folder-progress', {
                    id,
                    direction: 'send',
                    filesCompleted: sent,
                    filesFailed: failed,
                    fileCount: total,
                    failedFiles,
                    status: failed === 0 ? 'completed' : 'partial'
                });

                folderSendCurrentFile.delete(id);
                folderSendFailedFiles.delete(id);
            } else if (line.startsWith('ERROR:')) {
                const rawError = line.substring(6).trim();
                const [code, id] = rawError.split('|');
                const errorMessages = {
                    'CERT_MISMATCH': 'This peer\'s security certificate has changed since you last connected — possible security risk. Transfer blocked.',
                    'TLS_HANDSHAKE_FAILED': 'Could not establish a secure connection to the peer.',
                    'CHECKSUM_MISMATCH': 'The received file is corrupted.',
                    'DISK_FULL': 'Receiver disk is full.',
                    'PERMISSION_DENIED': 'Receiver could not write the file.',
                    'TRANSFER_REJECTED': 'The transfer was rejected.',
                    'PEER_DISCONNECTED': 'The peer disconnected unexpectedly.',
                    'FILE_BUSY': 'A file with this name is already being received.'
                };
                const message = errorMessages[code] || 'An unknown error occurred.';
                console.log(`❌ Sender (folder) Error [ID: ${id || 'System'}]: ${code}`);

                // Per-file errors inside a folder send arrive with an id like
                // "<transferId>_<index>" — the file this refers to is
                // whichever one the most recent "📄" line named, since
                // sending is strictly sequential (one file at a time).
                const failedPath = folderSendCurrentFile.get(transferId) || id;
                if (!folderSendFailedFiles.has(transferId)) {
                    folderSendFailedFiles.set(transferId, []);
                }
                folderSendFailedFiles.get(transferId).push({ path: failedPath, code });

                io.emit('folder-file-error', { folderId: transferId, fileId: id, path: failedPath, code, message });
            } else if (line.length > 0) {
                console.log(`📤 [SENDER(folder) ${transferId}]: ${line}`);
            }
        }
    });

    sender.stderr.on("data", (data) => {
        console.error(`❌ [SENDER(folder) ${transferId} ERROR]: ${data.toString()}`);
    });

    sender.on('close', (code) => {
        console.log(`🏁 Folder sender ${transferId} finished (Code:${code})`);
        const currentHistory = loadHistory();
        const idx = currentHistory.findIndex(t => t.id === transferId);
        if (idx !== -1) {
            currentHistory[idx].endTime = new Date().toISOString();
            if (currentHistory[idx].status === 'pending') {
                currentHistory[idx].status = code === 0 ? 'success' : 'failed';
            }
            saveHistory(currentHistory);
        }
        // Clean up the temp upload folder now that the sender is done with it.
        fs.rm(tempFolderPath, { recursive: true, force: true }, (err) => {
            if (err) console.error(`⚠️ Failed to clean up temp folder ${tempFolderPath}:`, err.message);
        });
        activeTransfers.delete(transferId);
    });

    res.json({ success: true, transferId });
});

// --- SOCKET CONNECTION ---
io.on("connection", (socket) => {
    console.log("🔌 Client connected");
    const peerList = Array.from(peers.entries()).map(([ip, name]) => ({ name, ip }));
    socket.emit("peers_list", peerList);
});

server.listen(5000, () =>
    console.log('✅ Lighthouse Backend at http://localhost:5000')
);