<div align="center">

# WinDrop

### A resumable, checksum-verified, TLS-encrypted P2P file transfer protocol — built from raw sockets up

WinDrop moves files directly between peers on a LAN with no server, no cloud, and no dependency on a third party ever seeing your data. A React UI and Node.js coordination layer sit on top of a hand-built C++ transfer protocol that handles discovery, handshakes, high-throughput streaming, resume-after-failure, end-to-end integrity verification, and transport-layer encryption with certificate pinning.

[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=node.js&logoColor=white)]()
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?logo=react&logoColor=black)]()
[![Express](https://img.shields.io/badge/Express-Coordination-000000?logo=express&logoColor=white)]()
[![C++](https://img.shields.io/badge/C%2B%2B-P2P_Core-00599C?logo=cplusplus&logoColor=white)]()
[![OpenSSL](https://img.shields.io/badge/TLS-OpenSSL-721412?logo=openssl&logoColor=white)]()
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-black?logo=socket.io&logoColor=white)]()
[![Cross Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)]()
[![Build & Test](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml/badge.svg)](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml)

</div>

---

## Why this exists

Most "file sharing" side projects are a thin wrapper around an HTTP upload endpoint. WinDrop isn't — it's an actual transfer protocol: peers find each other over UDP multicast, negotiate a resumable session over TCP, stream data over a TLS-encrypted channel pinned against certificate substitution, and verify the result with a SHA-256 checksum before either side calls it done. The web UI is just the front door; the interesting engineering is in the C++ core.

---

## Features

- **Zero-config peer discovery** — UDP multicast broadcast, no manual IP entry, with session-ID-based self-detection so a peer never discovers itself
- **Drag-and-drop file selection**
- **Accept / reject handshake** — receiver sees filename, size, and sender name and approves or denies before a single byte of file data moves
- **TLS-encrypted transfer channel with certificate pinning** — the entire file-transfer TCP connection (handshake, control messages, and file data) is wrapped in TLS via OpenSSL. On first connection to a peer, the sender records that peer's certificate fingerprint (trust-on-first-use); every later connection to the same peer is checked against that fingerprint, and a mismatch aborts the transfer before any data moves, with a `CERT_MISMATCH` error surfaced to the UI. UDP discovery broadcasts remain plaintext by design — there's nothing sensitive in an "I exist" announcement
- **Sanitized, attack-tested filename handling** — every filename that arrives over the network is passed through `sanitizeFilename()` before it ever touches the filesystem, stripping path components and rejecting traversal attempts; verified against a dedicated test suite and against a live exploit payload sent over an actual TLS connection during development
- **High-throughput streaming** — 256 KB chunks, `TCP_NODELAY` enabled, 1 MB send/receive socket buffers, and no per-chunk application-level acknowledgment: the sender streams continuously and relies on TCP's own transport-layer flow control plus an end-to-end SHA-256 check at completion, rather than duplicating reliability at the application layer
- **Resumable, content-verified transfers** — a `RESUME_QUERY` on connect lets an interrupted transfer pick up from the last flushed chunk instead of restarting from zero. Before resuming, the sender and receiver compare a SHA-256 hash of the partial file's first chunk — if the receiver's `.part` file doesn't actually match what the sender thinks it sent, the stale partial is discarded and the transfer restarts clean rather than resuming from a corrupted offset
- **Single-writer protection** — two inbound transfers can never write to the same destination filename concurrently; the second one is rejected with `FILE_BUSY` rather than racing the first
- **End-to-end integrity verification** — a real, from-scratch SHA-256 implementation (FIPS 180-4), verified against known test vectors in CI on every push
- **Sampled progress reporting** — progress events are throttled to every ~150ms rather than fired per chunk, so status updates don't become their own bottleneck at high throughput
- **Built-in benchmarking mode** — a `--benchmark-auto-accept` flag on the receiver skips the interactive accept prompt for scripted testing, and the sender emits a machine-readable `BENCHMARK:<elapsedMs>|<fileSizeBytes>` line on completion, so throughput can be measured programmatically instead of timed by hand
- **Structured error codes** surfaced to the UI — `PERMISSION_DENIED`, `DISK_FULL`, `CHECKSUM_MISMATCH`, `TRANSFER_REJECTED`, `RESUME_STATE_INVALID`, `PEER_DISCONNECTED`, `FILE_BUSY`, `TLS_HANDSHAKE_FAILED`, `CERT_MISMATCH`
- **Cross-platform networking core** — a platform abstraction layer isolates WinSock2 (Windows) from POSIX sockets (Linux/macOS) behind one API
- **Transfer history** — a persisted JSON log of every transfer's peer, filename, size, timing, and outcome
- **Automated CI** — every push builds `core`/`sender` and runs the unit test suite on Ubuntu, Windows, and macOS, plus a dedicated integration test suite (Linux) covering mid-transfer kill/resume, corrupted-partial-file rejection, and concurrent same-filename writers
- **One-command startup** — `start.sh` detects the OS, generates a local TLS certificate on first run, compiles the right native binaries (including resolving Homebrew's OpenSSL path on macOS), installs dependencies, and launches all three layers together

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
│ (net_platform: WinSock2 ⇄ POSIX, TLS via OpenSSL, cert pinning)
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

The file-transfer TCP channel is wrapped in TLS (OpenSSL). On first run, `start.sh` generates a **self-signed certificate** for the receiving peer — this is a LAN peer-to-peer tool, not a public-facing service, so there's no public CA to validate against.

To harden the trust model beyond blind certificate acceptance, WinDrop implements **trust-on-first-use (TOFU) certificate pinning**: the first time a sender connects to a given peer IP, it records the SHA-256 fingerprint of that peer's certificate to a local `known_peers.txt`. Every subsequent connection to that same IP is checked against the stored fingerprint — if it doesn't match, the connection is aborted before any protocol data is sent, and the UI surfaces a `CERT_MISMATCH` error. This protects every connection *after* the first against an active on-path attacker; it does not, and cannot, protect the very first connection to a brand-new peer, which is the same fundamental limitation SSH host-key pinning has. That tradeoff is inherent to TOFU, not an oversight.

Peer-supplied filenames (from both `REQUEST` and `RESUME_QUERY` messages) are sanitized via `sanitizeFilename()` before ever being used in a filesystem path — path components are stripped and traversal attempts (`../`, absolute paths, mixed separators) are rejected outright. This was verified not just by code review but by sending an actual path-traversal payload over a live TLS connection during development and confirming it was neutralized before reaching the filesystem.

---

## Performance

WinDrop uses continuous streaming (no per-chunk handshake), 256 KB chunks, `TCP_NODELAY`, and 1 MB socket buffers to keep a single TCP connection as close to link-saturated as a real network allows.

**Real-world result:** a 2.3 GB file transferred between two Linux laptops on a shared, congested college WiFi network (not a clean lab LAN) in 6 minutes 13 seconds — roughly 6.2 MB/s sustained.

**Controlled benchmark result:** 9.17 MB/s average (9.84 MB/s peak) on 250MB payloads, across 9 trials over 3 separate runs on real campus WiFi — see `BENCHMARKS.md` for the full trial-by-trial breakdown and methodology, produced using the built-in `--benchmark-auto-accept` / `BENCHMARK:` tooling.

---

## Transfer Protocol

### 1. Discovery (UDP, plaintext)
Peers broadcast a `sessionId:hostname:ip` message every 2 seconds over UDP multicast (`239.255.255.250:8888`). A random per-run session ID (not hostname matching) is used to filter out a peer's own broadcasts.

### 2. TLS Handshake + Certificate Pinning (TCP, port 8080)
Immediately after `accept()`/`connect()`, both sides perform a TLS handshake. The sender then checks the presented certificate's fingerprint against its local trust store before any further protocol data is sent — see Security above.

### 3. Resume Check + Request Handshake
| Step | Message | Direction |
|---|---|---|
| Resume check | `RESUME_QUERY:id\|filename\|size\|firstChunkHash` | Sender → Receiver |
| Resume reply | `RESUME_RESPONSE:OK\|lastChunk` or `RESUME_RESPONSE:NO` | Receiver → Sender |
| Transfer request | `REQUEST:id\|filename\|size\|senderName` | Sender → Receiver |
| User decision | `REQUEST_ACCEPT:id` or `REQUEST_REJECT:id` | Receiver → Sender |

The receiver only responds `RESUME_RESPONSE:OK` if the SHA-256 hash of its own `.part` file's first chunk matches the `firstChunkHash` the sender supplied — otherwise the stale/corrupted partial is discarded and the transfer starts fresh. Both `filename` fields are passed through `sanitizeFilename()` before any filesystem operation.

### 4. Streaming
256 KB chunks are streamed continuously with no per-chunk acknowledgment — the sender relies on TCP's own flow control and checks only its own `send()` return value. The receiver tracks exact bytes received against the known total size from the handshake, buffering and flushing to disk in 1 MB batches, with `.part.meta` checkpoints written only after a successful flush. A destination filename already being written to by another transfer is rejected with `FILE_BUSY`.

### 5. Finalization
| Step | Message | Direction |
|---|---|---|
| Completion | `COMPLETE:sha256Hash` | Sender → Receiver |
| Verify | Receiver computes a local SHA-256 hash and compares | — |
| Match | `DELIVERED_ACK` — atomic rename from `.part` to final filename | Receiver → Sender |
| Mismatch | `ERROR:CHECKSUM_MISMATCH` — `.part` file kept, transfer flagged failed | Receiver → Sender |

---

## Testing & CI

Every push builds `core` and `sender` and runs the full test suite on `ubuntu-latest`, `windows-latest`, and `macos-latest`.

### Unit tests (all three platforms)
- `tests/test_sha256.cpp` — verifies the SHA-256 implementation against known test vectors, plus a single-byte-change collision check
- `tests/test_metadata.cpp` — verifies the resume-checkpoint read/write logic, including corrupted-file handling
- `tests/test_path_utils.cpp` — verifies `sanitizeFilename()` against a battery of traversal payloads, including the exact exploit string used to originally confirm the vulnerability

### Integration tests (Linux, real compiled binaries over real sockets)
- `tests/integration/test_resume_kill.sh` — kills the sender mid-transfer on a genuinely large file, resumes, and asserts the final checksum is byte-exact
- `tests/integration/test_corrupted_resume.sh` — deliberately corrupts a partial file after interruption and asserts the receiver rejects the stale resume (`RESUME_STATE_INVALID`) instead of silently continuing from bad data
- `tests/integration/test_same_filename.sh` — fires two concurrent transfers at the identical destination filename and asserts exactly one succeeds and the other is rejected with `FILE_BUSY`
- `tests/integration/concurrent_stress_test.sh` — 25 simultaneous transfers to one receiver, asserting all succeed and reporting the file-descriptor delta before/after load

```bash
cd tests
g++ -std=c++17 -I../backend test_sha256.cpp ../backend/sha256.cpp -o test_sha256 && ./test_sha256
g++ -std=c++17 -I../backend test_metadata.cpp -o test_metadata && ./test_metadata
g++ -std=c++17 -I../backend test_path_utils.cpp -o test_path_utils && ./test_path_utils
```

The three integration scripts under `tests/integration/` build their own binaries and generate real (large, temporary) test files — run them individually rather than in parallel, since `core`'s TCP/UDP ports (8080/8888) are hardcoded and a second instance can't bind them while one is already running.

---

## Project Structure

```text
WinDrop/
├── backend/
│   ├── core.cpp                  # discovery, handshake, TLS accept, streaming receive, resume, checksum
│   ├── sender.cpp                # per-transfer outbound process: resume query, TLS connect + cert pinning, streaming send
│   ├── net_platform.h            # platform abstraction + inline OpenSSL TLS wrappers, incl. fingerprinting
│   ├── net_platform_posix.cpp    # POSIX sockets (Linux/macOS)
│   ├── net_platform_win.cpp      # WinSock2 sockets (Windows)
│   ├── path_utils.h              # sanitizeFilename() — isolated for unit testing
│   ├── trust_store.h             # TOFU certificate pinning read/write
│   ├── metadata.h                # resume-checkpoint read/write (unit-testable in isolation)
│   ├── sha256.h / sha256.cpp     # from-scratch SHA-256 (FIPS 180-4)
│   ├── index.js                  # Express + Socket.IO coordination, process spawning, history API
│   └── package.json
├── frontend/
│   └── src/App.jsx               # drag & drop, accept/reject modal, progress, history UI
├── tests/
│   ├── test_sha256.cpp
│   ├── test_metadata.cpp
│   ├── test_path_utils.cpp
│   └── integration/
│       ├── test_resume_kill.sh
│       ├── test_corrupted_resume.sh
│       ├── test_same_filename.sh
│       ├── concurrent_stress_test.sh
│       ├── benchmark_sender.sh
│       └── benchmark_receiver.sh
├── .github/workflows/build.yml   # CI: build + full test suite on Ubuntu, Windows, macOS
├── .gitignore                    # excludes compiled binaries and runtime artifacts
└── start.sh                      # generates TLS cert, compiles (incl. macOS Homebrew OpenSSL resolution), launches all layers
```

---

## Getting Started

### Prerequisites
- Node.js & npm
- g++ (Linux/macOS) or MinGW-w64 (Windows)
- OpenSSL development headers (`libssl-dev` on Ubuntu; `openssl@3` via Homebrew on macOS; `mingw-w64-x86_64-openssl` via MSYS2 on Windows)

### Run it
```bash
git clone https://github.com/thedevsumit/WinDrop.git
cd WinDrop
chmod +x start.sh
./start.sh
```

`start.sh` checks for missing dependencies up front (and tells you exactly what to install and how), generates a local self-signed TLS certificate on first run, detects your OS, compiles `core`/`sender` against the correct platform file, installs dependencies, and launches all three layers with clean shutdown on `Ctrl+C`.

### Benchmarking
The receiver can be started with `--benchmark-auto-accept` to skip the interactive accept prompt for scripted, repeatable timing runs. The sender prints a `BENCHMARK:<elapsedMs>|<fileSizeBytes>` line on completion, suitable for parsing in a test script.

---

## Troubleshooting

Real errors encountered and fixed during development, kept here so they don't have to be rediscovered.

### `Failed to initialize TLS Context with cert.pem/key.pem`
The `core` binary looks for `cert.pem`/`key.pem` in its **current working directory**, not next to the binary. If you're running `./core` (or a manually-built test binary) from somewhere other than `backend/`, or from a fresh directory with no certificate generated yet, it exits immediately with this error. `start.sh` handles this automatically; if you're running the binary directly, generate a cert first:
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
```

### `error: 'TCP_NODELAY' was not declared in this scope` (Linux)
`TCP_NODELAY` lives in `<netinet/tcp.h>`, which isn't pulled in automatically by the other socket headers. If you're extending `net_platform_posix.cpp` and hit this, add:
```cpp
#include <netinet/tcp.h>
```

### `SSL routines::SSL_CTX_use_certificate_file` / OpenSSL link errors on macOS
Homebrew's OpenSSL is intentionally *not* placed on the default compiler search path (Apple deprecated the system OpenSSL in favor of its own Security framework), so a bare `-lssl -lcrypto` fails to find headers or the library. Both `start.sh` and CI resolve this explicitly:
```bash
OPENSSL_PREFIX="$(brew --prefix openssl@3)"
g++ ... -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" -o core -lssl -lcrypto
```
If you're compiling manually on macOS and hit this, you're almost certainly missing the `-I`/`-L` flags above.

### `bind: Address already in use` / core exits immediately on startup
`core`'s TCP port (8080) and UDP discovery port (8888) are both hardcoded. This happens if another `core` instance (including a leftover one from a crashed test run) is still holding the port. Check for and kill it:
```bash
pkill -f "./core"
# or, to find exactly what's holding the port:
lsof -i :8080
```
This is also why the integration test scripts under `tests/integration/` must be run **one at a time**, never in parallel — two simultaneous `core` instances will always collide on these ports.

### Two peers on the same WiFi don't discover each other
Multicast discovery (`239.255.255.250:8888`) depends on the network actually forwarding multicast traffic between clients. Some routers and most corporate/campus WiFi have **IGMP snooping** enabled, which can silently drop multicast between two devices on the same AP even though normal internet traffic works fine for both. If discovery works on one network but not another, this is the first thing to suspect — it's a network configuration issue, not a WinDrop bug, though there's currently no in-app diagnostic to distinguish the two cases (see Roadmap).

### `libssl-dev` / OpenSSL headers missing (Linux)
```
fatal error: openssl/ssl.h: No such file or directory
```
```bash
sudo apt install -y libssl-dev        # Debian/Ubuntu
sudo dnf install -y openssl-devel     # Fedora
sudo pacman -S openssl                # Arch
```

### `CERT_MISMATCH` on a peer you expect to trust
This means the certificate presented by that IP address doesn't match the fingerprint WinDrop saved the first time it connected to that peer — by design, this is treated as a possible active attack and the transfer is refused. The most common *legitimate* cause is the peer's `cert.pem` having been regenerated (e.g. they deleted it and `start.sh` made a new one, or reinstalled). If you're certain the peer is legitimate, remove their stale entry from `known_peers.txt` and reconnect to re-pin:
```bash
# find and remove the line matching their IP
grep -v "<their-ip>" known_peers.txt > known_peers.tmp && mv known_peers.tmp known_peers.txt
```

---

## Roadmap

- [ ] Decouple disk writes from the network receive loop (dedicated writer thread + queue) so a slow disk can't stall the socket read and throttle throughput
- [ ] Parallel-stream transfer mode, to recover throughput on lossy/high-latency networks where a single TCP connection's congestion control caps well below link capacity
- [ ] Extend integration test coverage to macOS and Windows (currently Linux-only in CI)
- [ ] In-app diagnostic to distinguish "peer not on network" from "multicast blocked by network configuration" during failed discovery
- [ ] Folder / multi-file transfer
- [ ] Bandwidth throttling
- [ ] A documented way to un-pin/rotate a peer's certificate without manually editing `known_peers.txt`

---

## Authors

**Sumit Kumar** — [@thedevsumit](https://github.com/thedevsumit)
**Lovepreet Singh** — [@luvpee](https://github.com/luvpee)

---

<div align="center">

Built with React, Node.js, Express, and C++ — direct, encrypted, peer-to-peer file transfer, no cloud in the middle.

</div>