<div align="center">

# WinDrop

### A resumable, checksum-verified P2P file transfer protocol — built from raw sockets up

WinDrop moves files directly between peers on a LAN with no server, no cloud, and no dependency on a third party ever seeing your data. A React UI and Node.js coordination layer sit on top of a hand-built C++ transfer protocol that handles discovery, handshakes, chunked streaming, resume-after-failure, and end-to-end integrity verification.

[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=node.js&logoColor=white)]()
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?logo=react&logoColor=black)]()
[![Express](https://img.shields.io/badge/Express-Coordination-000000?logo=express&logoColor=white)]()
[![C++](https://img.shields.io/badge/C%2B%2B-P2P_Core-00599C?logo=cplusplus&logoColor=white)]()
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-black?logo=socket.io&logoColor=white)]()
[![Cross Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-lightgrey)]()
[![Build & Test](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml/badge.svg)](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml)
</div>

---

## Why this exists

Most "file sharing" side projects are a thin wrapper around an HTTP upload endpoint. WinDrop isn't — it's an actual transfer protocol: peers find each other over UDP multicast, negotiate a resumable session over TCP, stream data in acknowledged chunks, and verify the result with a SHA-256 checksum before either side calls it done. The web UI is just the front door; the interesting engineering is in the C++ core.

---

## Features

- **Zero-config peer discovery** — UDP multicast broadcast (a "lighthouse" that continuously announces presence), no manual IP entry
- **Drag-and-drop file selection** with a live search state while peers are being discovered
- **Accept / reject handshake** — receiver sees filename, size, and sender name and approves or denies before a single byte of file data moves
- **Resumable transfers** — a `RESUME_QUERY` on connect lets an interrupted transfer pick up from the last acknowledged chunk instead of restarting from zero
- **End-to-end integrity verification** — SHA-256 checksum computed over the full file and compared before a transfer is marked delivered
- **Real-time progress** — per-chunk ACKs streamed live to the UI via Socket.IO, both for the sender's outbound progress and the receiver's inbound progress
- **Concurrent sends** — the backend spawns an independent C++ sender process per outbound transfer, so multiple sends can run in parallel without blocking each other
- **Buffered async disk writes** — chunks are ACKed the moment they're received in memory; writes are batched and flushed to disk every 16 chunks, with `.part.meta` checkpoint updates happening only *after* a successful flush so a crash mid-batch never claims data that isn't actually on disk
- **Structured error codes** — `PERMISSION_DENIED`, `DISK_FULL`, `CHECKSUM_MISMATCH`, `TRANSFER_REJECTED`, `RESUME_STATE_INVALID` — surfaced to the UI instead of a generic failure message
- **Cross-platform networking core** — a platform abstraction layer isolates WinSock2 (Windows) from POSIX sockets (Linux/macOS) behind one API
- **Transfer history** — a persisted JSON log of every transfer's peer, filename, size, timing, and outcome, exposed via a REST endpoint
- **One-command startup** — `start.sh` detects the OS, compiles the right native binaries, installs dependencies, and launches all three layers together with clean process teardown on exit

---

## Architecture

```text
┌─────────────────────┐
│   React Frontend    │   drag & drop · accept/reject modal · live progress · history
│   User Interface    │
└──────────┬──────────┘
           │ HTTP upload (multer) + Socket.IO (live events)
           ▼
┌─────────────────────┐
│ Node.js + Express   │   spawns/coordinates native processes, persists transfer history
│ Coordination Layer  │
└──────────┬──────────┘
           │ spawn() + stdio parsing
           ▼
┌─────────────────────┐
│ C++ Networking Core │   discovery · handshake · chunking · resume · checksum
│ (net_platform: WinSock2 ⇄ POSIX)
└──────────┬──────────┘
           │ UDP multicast (discovery, port 8888) / TCP (transfer, port 8080)
           ▼
    ┌─────────────┐
    │ Peer ↔ Peer │
    └─────────────┘
```

- **Frontend** — drag-and-drop upload, accept/reject modal, live per-transfer progress bars, "Recent Transfers" history panel
- **Backend** — receives the uploaded file over HTTP, spawns a native `sender` process pointed at it, spawns and keeps one long-running `core` process listening for inbound transfers, and relays both processes' stdout as structured events to the browser over Socket.IO
- **C++ Core** — a persistent multi-threaded engine (`core`) that broadcasts/listens for peers, accepts inbound handshakes, and streams data to disk; a separate short-lived `sender` binary is spawned per outbound transfer

---

## Transfer Protocol

WinDrop's protocol is designed to be resumable, verifiable, and safe against partial writes.

### 1. Discovery (UDP)

The core continuously broadcasts its presence so peers never need a manually typed IP.

| | |
|---|---|
| **Message** | `[Hostname]:[IP] Alive` |
| **Transport** | UDP Multicast `239.255.255.250`, port `8888`, every 2 seconds |

### 2. Handshake (TCP, port 8080)

No file data moves until both sides agree.

| Step | Message | Direction |
|---|---|---|
| 1. Resume check | `RESUME_QUERY:filename\|size` | Sender → Receiver |
| 2. Resume reply | `RESUME_RESPONSE:OK\|lastChunk` or `RESUME_RESPONSE:NO` | Receiver → Sender |
| 3. Transfer request | `REQUEST:id\|filename\|size\|senderName` | Sender → Receiver |
| 4. User decision | `REQUEST_ACCEPT:id` or `REQUEST_REJECT:id` | Receiver → Sender |

The receiver's core blocks on a condition variable per request until the frontend's accept/reject click comes back down through the backend and into the core's stdin — a real producer/consumer handoff between the UI and a native thread.

### 3. Transmission (TCP)

| | |
|---|---|
| **Chunk size** | 1 KB |
| **Acknowledgment** | `ACK:chunkNumber` sent after every chunk received |
| **Progress events** | `TRANSFER_PROGRESS:id\|current\|total` (receiver) and `SENDER_PROGRESS:id\|current\|total` (sender), both relayed to the UI live |
| **Disk strategy** | Chunks are ACKed in memory immediately; writes are buffered and flushed to disk every 16 chunks. The `.part.meta` checkpoint is only updated *after* a successful flush |

### 4. Finalization (TCP)

| Step | Message | Direction |
|---|---|---|
| 1. Completion | `COMPLETE:sha256Hash` | Sender → Receiver |
| 2. Verify | Receiver computes a local SHA-256 hash of the assembled file and compares | — |
| 3a. Match | `DELIVERED_ACK` — `.part` file is atomically renamed to its final name, `.part.meta` is deleted | Receiver → Sender |
| 3b. Mismatch | `ERROR:CHECKSUM_MISMATCH` — `.part` file is kept, transfer is flagged as failed instead of silently accepted | Receiver → Sender |

### Structured Error Codes

`PERMISSION_DENIED` · `DISK_FULL` · `CHECKSUM_MISMATCH` · `TRANSFER_REJECTED` · `RESUME_STATE_INVALID`

---

## Resume Support

If a transfer is interrupted mid-stream:

1. Every 16 chunks, progress is checkpointed to `<filename>.part.meta` (total size, chunk size, last acked chunk).
2. Incoming data is written to `<filename>.part`, never directly to the final filename.
3. On retry, the sender sends `RESUME_QUERY` and the receiver replies with the last acknowledged chunk if a matching `.part.meta` exists (validated against file size to avoid resuming a stale/mismatched partial).
4. The sender seeks to `lastChunk * CHUNK_SIZE` and resumes streaming from there.
5. On successful completion and checksum verification, `.part` is atomically renamed to the final filename and its metadata file is removed.

---

## Project Structure

```text
WinDrop/
├── backend/
│   ├── core.cpp                  # persistent engine: discovery, handshake, chunk I/O, resume state
│   ├── sender.cpp                # per-transfer outbound process: resume query, chunk streaming, checksum
│   ├── net_platform.h            # platform abstraction interface (sockets, broadcast, multicast)
│   ├── net_platform_posix.cpp    # POSIX implementation (Linux/macOS)
│   ├── net_platform_win.cpp      # WinSock2 implementation (Windows)
│   ├── sha256.h / sha256.cpp     # SHA-256 implementation used for transfer verification
│   ├── index.js                  # Express + Socket.IO coordination layer, process spawning, history API
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                # drag & drop, accept/reject modal, progress, history UI
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
└── start.sh                       # detects OS, compiles native binaries, launches all three layers
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite |
| Backend | Node.js, Express, Socket.IO, Multer |
| Networking Core | C++ (WinSock2 / POSIX sockets via a platform abstraction layer) |
| Discovery | UDP Multicast |
| Transfer | TCP, chunked streaming |
| Integrity | Custom SHA-256 implementation |
| Build | g++ (Linux/macOS) / MinGW (Windows) |
| Automation | Bash (`start.sh`) |

---

## Getting Started

### Prerequisites

- Node.js & npm
- g++ (Linux/macOS) or MinGW-w64 (Windows)
- A Bash-compatible shell

```bash
node --version
npm --version
g++ --version
```

### Run it

```bash
git clone https://github.com/thedevsumit/WinDrop.git
cd WinDrop
chmod +x start.sh
./start.sh
```

`start.sh` detects your OS, compiles `core` and `sender` against the correct platform file, installs backend and frontend dependencies, starts both layers, and cleanly kills every background process on `Ctrl+C`.

### Run components manually

```bash
# Backend
cd backend
npm install
node index.js

# Frontend
cd frontend
npm install
npm run dev

# C++ core + sender (Linux/macOS)
cd backend
g++ -pthread core.cpp sha256.cpp net_platform_posix.cpp -o core
g++ sender.cpp sha256.cpp net_platform_posix.cpp -o sender

# C++ core + sender (Windows, MinGW)
g++ -pthread core.cpp sha256.cpp net_platform_win.cpp -o core.exe -lws2_32
g++ sender.cpp sha256.cpp net_platform_win.cpp -o sender.exe -lws2_32
```

---

## Learning Outcomes

Building WinDrop's protocol layer meant working through problems that don't come up in typical CRUD apps:

- **Raw TCP/UDP socket programming** in C++, including multicast discovery and a hand-rolled, newline-delimited protocol
- **Designing a resumable transfer protocol** — checkpointing, validating resume state against file size, and safely appending to partial files
- **End-to-end integrity verification** — implementing SHA-256 and handling the failure path explicitly (a mismatch is a rejected file, not a silent success)
- **Crash-safe I/O ordering** — buffering writes for throughput while keeping metadata checkpoints strictly *after* a successful flush, never before
- **Cross-platform systems programming** — isolating WinSock2 vs. POSIX socket APIs behind one internal interface so the protocol code never branches on OS
- **Bridging native processes and a web UI** — parsing structured stdout lines from long-running and short-lived C++ processes and re-emitting them as typed Socket.IO events, including coordinating a UI-driven decision back into a blocked native thread via a condition variable

---

## Roadmap

- [ ] Guard against two concurrent inbound transfers writing to the same destination filename
- [ ] TLS-secured handshake and transfer
- [ ] Bandwidth throttling controls in the UI
- [ ] Automated integration tests around the resume path
- [ ] Packaged binaries for one-click install on Windows/Linux

---

## Authors

**Sumit Kumar**
GitHub: [@thedevsumit](https://github.com/thedevsumit)

**Lovepreet Singh**
GitHub: [@luvpee](https://github.com/luvpee)

---

<div align="center">

Built with React, Node.js, Express, and C++ — direct peer-to-peer file transfer, no cloud in the middle.

</div>
