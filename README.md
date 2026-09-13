<div align="center">

# WinDrop

### A resumable, checksum-verified, TLS-encrypted P2P file transfer protocol — built from raw sockets up

WinDrop moves files directly between peers on a LAN with no server, no cloud, and no dependency on a third party ever seeing your data. A React UI and Node.js coordination layer sit on top of a hand-built C++ transfer protocol that handles discovery, handshakes, high-throughput streaming, resume-after-failure, end-to-end integrity verification, and transport-layer encryption.

[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=node.js&logoColor=white)]()
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?logo=react&logoColor=black)]()
[![Express](https://img.shields.io/badge/Express-Coordination-000000?logo=express&logoColor=white)]()
[![C++](https://img.shields.io/badge/C%2B%2B-P2P_Core-00599C?logo=cplusplus&logoColor=white)]()
[![OpenSSL](https://img.shields.io/badge/TLS-OpenSSL-721412?logo=openssl&logoColor=white)]()
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-black?logo=socket.io&logoColor=white)]()
[![Cross Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-lightgrey)]()
[![Build & Test](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml/badge.svg)](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml)

</div>

---

## Why this exists

Most "file sharing" side projects are a thin wrapper around an HTTP upload endpoint. WinDrop isn't — it's an actual transfer protocol: peers find each other over UDP multicast, negotiate a resumable session over TCP, stream data over a TLS-encrypted channel, and verify the result with a SHA-256 checksum before either side calls it done. The web UI is just the front door; the interesting engineering is in the C++ core.

---

## Features

- **Zero-config peer discovery** — UDP multicast broadcast, no manual IP entry, with session-ID-based self-detection so a peer never discovers itself
- **Drag-and-drop file selection**
- **Accept / reject handshake** — receiver sees filename, size, and sender name and approves or denies before a single byte of file data moves
- **TLS-encrypted transfer channel** — the entire file-transfer TCP connection (handshake, control messages, and file data) is wrapped in TLS via OpenSSL. UDP discovery broadcasts remain plaintext by design — there's nothing sensitive in an "I exist" announcement
- **High-throughput streaming** — 64 KB chunks, `TCP_NODELAY` enabled, and no per-chunk application-level acknowledgment: the sender streams continuously and relies on TCP's own transport-layer flow control plus an end-to-end SHA-256 check at completion, rather than duplicating reliability at the application layer
- **Resumable transfers** — a `RESUME_QUERY` on connect lets an interrupted transfer pick up from the last acknowledged chunk instead of restarting from zero
- **End-to-end integrity verification** — a real, from-scratch SHA-256 implementation (FIPS 180-4), verified against known test vectors in CI on every push
- **Sampled progress reporting** — progress events are throttled to every ~150ms rather than fired per chunk, so status updates don't become their own bottleneck at high throughput
- **Structured error codes** surfaced to the UI — `PERMISSION_DENIED`, `DISK_FULL`, `CHECKSUM_MISMATCH`, `TRANSFER_REJECTED`, `RESUME_STATE_INVALID`, `PEER_DISCONNECTED`, `FILE_BUSY`, `TLS_HANDSHAKE_FAILED`
- **Cross-platform networking core** — a platform abstraction layer isolates WinSock2 (Windows) from POSIX sockets (Linux/macOS) behind one API
- **Transfer history** — a persisted JSON log of every transfer's peer, filename, size, timing, and outcome
- **Automated CI** — every push builds `core`/`sender` on both Ubuntu and Windows and runs the unit test suite
- **One-command startup** — `start.sh` detects the OS, generates a local TLS certificate on first run, compiles the right native binaries, and launches all three layers together

---

## Architecture

```text
┌─────────────────────┐
│   React Frontend    │   drag & drop · accept/reject modal · live progress · history
└──────────┬──────────┘
           │ HTTP upload (multer) + Socket.IO (live events)
           ▼
┌─────────────────────┐
│ Node.js + Express   │   spawns/coordinates native processes, persists transfer history
└──────────┬──────────┘
           │ spawn() + stdio parsing
           ▼
┌─────────────────────┐
│ C++ Networking Core │   discovery · handshake · streaming · resume · checksum
│ (net_platform: WinSock2 ⇄ POSIX, TLS via OpenSSL)
└──────────┬──────────┘
           │ UDP multicast (discovery, plaintext, port 8888)
           │ TCP + TLS (file transfer, port 8080)
           ▼
    ┌─────────────┐
    │ Peer ↔ Peer │
    └─────────────┘
```

---

## Security

The file-transfer TCP channel is wrapped in TLS (OpenSSL). On first run, `start.sh` generates a **self-signed certificate** for the receiving peer — this is a LAN peer-to-peer tool, not a public-facing service, so there's no public CA to validate against, and the sending peer intentionally does not verify the certificate chain (`SSL_VERIFY_NONE`). This protects against passive eavesdropping on the local network; it does not protect against an active attacker who can intercept the initial connection (a proper trust-on-first-use or pre-shared-fingerprint model would be needed for that, and is on the roadmap below). This tradeoff is documented here deliberately, not an oversight.

---

## Transfer Protocol

### 1. Discovery (UDP, plaintext)
Peers broadcast a `sessionId:hostname:ip` message every 2 seconds over UDP multicast (`239.255.255.250:8888`). A random per-run session ID (not hostname matching) is used to filter out a peer's own broadcasts.

### 2. TLS Handshake (TCP, port 8080)
Immediately after `accept()`/`connect()`, both sides perform a TLS handshake before any application data is exchanged.

### 3. Resume Check + Request Handshake
| Step | Message | Direction |
|---|---|---|
| Resume check | `RESUME_QUERY:id\|filename\|size` | Sender → Receiver |
| Resume reply | `RESUME_RESPONSE:OK\|lastChunk` or `RESUME_RESPONSE:NO` | Receiver → Sender |
| Transfer request | `REQUEST:id\|filename\|size\|senderName` | Sender → Receiver |
| User decision | `REQUEST_ACCEPT:id` or `REQUEST_REJECT:id` | Receiver → Sender |

### 4. Streaming
64 KB chunks are streamed continuously with no per-chunk acknowledgment — the sender relies on TCP's own flow control and checks only its own `send()` return value. The receiver tracks exact bytes received against the known total size from the handshake, buffering and flushing to disk in batches, with `.part.meta` checkpoints written only after a successful flush.

### 5. Finalization
| Step | Message | Direction |
|---|---|---|
| Completion | `COMPLETE:sha256Hash` | Sender → Receiver |
| Verify | Receiver computes a local SHA-256 hash and compares | — |
| Match | `DELIVERED_ACK` — atomic rename from `.part` to final filename | Receiver → Sender |
| Mismatch | `ERROR:CHECKSUM_MISMATCH` — `.part` file kept, transfer flagged failed | Receiver → Sender |

---

## Testing & CI

Every push builds `core` and `sender` on both `ubuntu-latest` and `windows-latest`, and runs two standalone unit test suites:

- `tests/test_sha256.cpp` — verifies the SHA-256 implementation against known test vectors (empty string, `"abc"`, and the standard `"quick brown fox"` vector), plus a single-byte-change collision check.
- `tests/test_metadata.cpp` — verifies the resume-checkpoint read/write logic, including corrupted-file handling.

```bash
cd tests
g++ -std=c++17 -I../backend test_sha256.cpp ../backend/sha256.cpp -o test_sha256 && ./test_sha256
g++ -std=c++17 -I../backend test_metadata.cpp -o test_metadata && ./test_metadata
```

---

## Project Structure

```text
WinDrop/
├── backend/
│   ├── core.cpp                  # discovery, handshake, TLS accept, streaming receive, resume, checksum
│   ├── sender.cpp                # per-transfer outbound process: resume query, TLS connect, streaming send
│   ├── net_platform.h            # platform abstraction + inline OpenSSL TLS wrappers
│   ├── net_platform_posix.cpp    # POSIX sockets (Linux/macOS)
│   ├── net_platform_win.cpp      # WinSock2 sockets (Windows)
│   ├── metadata.h                # resume-checkpoint read/write (unit-testable in isolation)
│   ├── sha256.h / sha256.cpp     # from-scratch SHA-256 (FIPS 180-4)
│   ├── index.js                  # Express + Socket.IO coordination, process spawning, history API
│   └── package.json
├── frontend/
│   └── src/App.jsx               # drag & drop, accept/reject modal, progress, history UI
├── tests/
│   ├── test_sha256.cpp
│   └── test_metadata.cpp
├── .github/workflows/build.yml   # CI: build + test on Ubuntu and Windows
└── start.sh                      # generates TLS cert, compiles, launches all layers
```

---

## Getting Started

### Prerequisites
- Node.js & npm
- g++ (Linux/macOS) or MinGW-w64 (Windows)
- OpenSSL development headers (`libssl-dev` on Ubuntu; `mingw-w64-x86_64-openssl` via MSYS2 on Windows)

### Run it
```bash
git clone https://github.com/thedevsumit/WinDrop.git
cd WinDrop
chmod +x start.sh
./start.sh
```

`start.sh` generates a local self-signed TLS certificate on first run, detects your OS, compiles `core`/`sender` against the correct platform file, installs dependencies, and launches all three layers with clean shutdown on `Ctrl+C`.

---

## Roadmap

- [ ] Real cross-machine throughput benchmarks (before/after the streaming redesign, and plaintext vs. TLS overhead) — pending access to a second physical machine
- [ ] Trust-on-first-use or pre-shared certificate fingerprint, to harden the TLS trust model beyond "any cert is accepted"
- [ ] Manual "Add Device by IP" fallback in the UI, plus a live backend-connection-status indicator — for networks/environments (e.g. WSL2's default NAT mode) where UDP multicast discovery doesn't reach across the virtual network boundary
- [ ] Folder / multi-file transfer
- [ ] Bandwidth throttling
- [ ] Guard against two concurrent inbound transfers writing to the same destination filename

---

## Authors

**Sumit Kumar** — [@thedevsumit](https://github.com/thedevsumit)
**Lovepreet Singh** — [@luvpee](https://github.com/luvpee)

---

<div align="center">

Built with React, Node.js, Express, and C++ — direct, encrypted, peer-to-peer file transfer, no cloud in the middle.

</div>
