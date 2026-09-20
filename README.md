<div align="center">

# WinDrop

**Resumable, checksum-verified, TLS-encrypted peer-to-peer file transfer — no server, no cloud.**

[![Build & Test](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml/badge.svg)](https://github.com/thedevsumit/WinDrop/actions/workflows/build.yml)
[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=node.js&logoColor=white)]()
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?logo=react&logoColor=black)]()
[![C++](https://img.shields.io/badge/C%2B%2B-P2P_Core-00599C?logo=cplusplus&logoColor=white)]()
[![OpenSSL](https://img.shields.io/badge/TLS-OpenSSL-721412?logo=openssl&logoColor=white)]()
[![Cross Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)]()

</div>

WinDrop moves files — or entire folders — directly between two peers on a LAN. Peers find each other over UDP multicast, negotiate a resumable session over TCP, stream data through a TLS-encrypted channel pinned against certificate substitution, and verify the result with SHA-256 before either side calls the transfer complete. A React UI and a Node.js coordination layer sit on top of a hand-built C++ transfer core that does all of the above.

---

## Features

- **Zero-config peer discovery** — UDP multicast broadcast (`239.255.255.250:8888`), session-ID-based self-filtering so a peer never discovers itself
- **Single-file and folder transfer** — send one file or an entire directory tree via "Choose Folder"; subdirectory structure is preserved end-to-end (manifest built by a recursive directory walk on the sender, reconstructed under the same relative paths on the receiver)
- **Accept / reject handshake** — receiver sees filename (or folder name + file count + total size), sender name, and approves or denies before a single byte of data moves
- **TLS-encrypted transfer channel with certificate pinning (TOFU)** — the TCP connection (handshake, control messages, file data) is wrapped in TLS via OpenSSL. On first contact with a peer, the fingerprint of its certificate is recorded; every later connection to that IP is checked against it, and a mismatch aborts the transfer with `CERT_MISMATCH`. This protects every connection *after* the first against an active on-path attacker — it cannot protect the first connection to a brand-new peer, the same limitation SSH host-key pinning has. UDP discovery broadcasts stay plaintext by design (nothing sensitive in an "I exist" announcement)
- **Delimiter-framed control protocol** — every control message is read through a buffered, newline-delimited reader (`Net::MsgReader`) rather than treating one `recv()` call as one message. TCP and TLS records don't preserve application write boundaries, so two messages sent back-to-back (as the folder-transfer handshake does) can otherwise arrive coalesced into a single read, or a large message can arrive split across several — either of which silently corrupts or truncates unframed parsing
- **Sanitized filename and path handling** — a single-file transfer's filename is reduced to a bare basename via `sanitizeFilename()`; a folder transfer's per-file relative path is checked segment-by-segment via `sanitizeRelativePath()`, rejecting absolute paths, drive letters, and a `..` segment anywhere in the path (not just at the start) while preserving legitimate subdirectory structure. Verified with a unit test suite and against a live path-traversal payload sent over an actual TLS connection during development
- **High-throughput streaming** — 256 KB chunks, `TCP_NODELAY`, 1 MB socket buffers, no per-chunk application-level ACK — relies on TCP's own flow control plus an end-to-end SHA-256 check at completion
- **Resumable, content-verified transfers** — a `RESUME_QUERY` on connect lets an interrupted transfer resume from the last flushed chunk, for both single-file and per-file-within-a-folder transfers. Before resuming, sender and receiver compare a SHA-256 hash of the partial file's first chunk; on mismatch the stale `.part` file is discarded and the transfer restarts clean
- **Single-writer protection** — a destination path already being written by one transfer rejects a second inbound transfer to the same path with `FILE_BUSY`; folder transfers are additionally namespaced per-transfer (folder display name + transfer id) so two folders with the same name, or the same folder sent twice, never collide on disk
- **Per-file folder transfer accounting** — a folder transfer keeps going if one file inside it fails; the failure is recorded and surfaced, and the final summary reports `received`/`failed`/`total` (or `sent`/`failed`/`total` on the sending side) rather than treating one bad file as a total-transfer failure
- **End-to-end integrity verification** — from-scratch SHA-256 (FIPS 180-4), checked against known test vectors in CI on every push
- **Sampled progress reporting** — progress events throttled to ~150ms intervals, at both the whole-folder and current-file level for folder transfers, so status updates don't become their own bottleneck
- **Built-in benchmarking mode** — `--benchmark-auto-accept` skips the interactive prompt on the receiver; the sender emits `BENCHMARK:<elapsedMs>|<fileSizeBytes>` on completion for scripted throughput testing
- **Structured error codes** surfaced to the UI — `PERMISSION_DENIED`, `DISK_FULL`, `CHECKSUM_MISMATCH`, `TRANSFER_REJECTED`, `RESUME_STATE_INVALID`, `PEER_DISCONNECTED`, `FILE_BUSY`, `TLS_HANDSHAKE_FAILED`, `CERT_MISMATCH`
- **Cross-platform networking core** — a platform abstraction layer isolates WinSock2 (Windows) from POSIX sockets (Linux/macOS) behind one API
- **Transfer history** — a persisted JSON log of every transfer's peer, filename, size, timing, and outcome
- **CI on every push** — builds `core`/`sender` and runs the unit test suite on Ubuntu, Windows, and macOS, plus a Linux integration suite covering mid-transfer kill/resume, corrupted-partial-file rejection, and concurrent same-filename writers

---

## Architecture

```text
┌─────────────────────┐
│   React Frontend    │   drag & drop · folder picker · accept/reject modal · live progress · history
└──────────┬──────────┘
           │ HTTP upload (multer) + Socket.IO (live events)
           ▼
┌─────────────────────┐
│ Node.js + Express   │   spawns/coordinates native processes, rebuilds folder structure from
│                      │   relative upload paths, persists transfer history
└──────────┬──────────┘
           │ spawn() + stdio parsing
           ▼
┌─────────────────────┐
│ C++ Networking Core │   discovery · handshake · streaming · resume · checksum · folder manifests
│ (net_platform: WinSock2 ⇄ POSIX, TLS via OpenSSL, cert pinning, buffered message framing)
└──────────┬──────────┘
           │ UDP multicast (discovery, plaintext, port 8888)
           │ TCP + TLS (file transfer, port 8080)
           ▼
    ┌─────────────┐
    │ Peer ↔ Peer │
    └─────────────┘
```

---

## Transfer Protocol

**1. Discovery (UDP, plaintext)** — peers broadcast `sessionId:hostname:ip` every 2 seconds over UDP multicast. A random per-run session ID filters out a peer's own broadcasts.

**2. TLS handshake + certificate pinning (TCP, port 8080)** — immediately after `accept()`/`connect()`, both sides perform a TLS handshake; the sender checks the peer's certificate fingerprint against its local trust store before any further protocol data is sent.

**3a. Single-file handshake**

| Step | Message | Direction |
|---|---|---|
| Resume check | `RESUME_QUERY:id\|filename\|size\|firstChunkHash` | Sender → Receiver |
| Resume reply | `RESUME_RESPONSE:OK\|lastChunk` or `RESUME_RESPONSE:NO` | Receiver → Sender |
| Transfer request | `REQUEST:id\|filename\|size\|senderName` | Sender → Receiver |
| User decision | `REQUEST_ACCEPT:id` or `REQUEST_REJECT:id` | Receiver → Sender |

**3b. Folder handshake** — sent instead of the above when the sender is started in `--folder` mode:

| Step | Message | Direction |
|---|---|---|
| Folder request | `FOLDER_REQUEST:id\|folderName\|fileCount\|totalSize\|senderName` | Sender → Receiver |
| Manifest | `FILE_MANIFEST:relPath1\|size1;relPath2\|size2;...` | Sender → Receiver |
| User decision | `FOLDER_ACCEPT:id` or `FOLDER_REJECT:id` | Receiver → Sender |

Both messages are read through `Net::MsgReader` on the receiver, not raw `recvData()` — see Design Notes below for why that distinction matters here specifically. On accept, the two sides then run the **3a single-file handshake once per manifest entry, over the same connection**, with the receiver namespacing every file under `<folderName>_<id>/<relPath>` so two folders (or the same folder sent twice) never collide on disk. `sanitizeRelativePath()` is applied to every manifest entry before it touches the filesystem.

**4. Streaming** — 256 KB chunks streamed continuously with no per-chunk ACK. The receiver tracks bytes received against the known total size, flushing to disk in 1 MB batches, with `.part.meta` checkpoints written only after a successful flush. A destination path already in use by another transfer is rejected with `FILE_BUSY`.

**5. Finalization** (per file)

| Step | Message | Direction |
|---|---|---|
| Completion | `COMPLETE:sha256Hash` | Sender → Receiver |
| Verify | Receiver computes a local SHA-256 hash and compares | — |
| Match | `DELIVERED_ACK` — atomic rename from `.part` to final filename | Receiver → Sender |
| Mismatch | `ERROR:CHECKSUM_MISMATCH` — `.part` kept, transfer flagged failed | Receiver → Sender |

For a folder transfer, step 5 repeats per manifest entry over the same connection; a per-file failure is recorded and the loop continues to the next file rather than aborting the whole folder. The connection closes after the last file, and the receiver logs `FOLDER_TRANSFER_COMPLETE:id|received=N|failed=N|total=N` (the sender logs the equivalent `FOLDER_SEND_COMPLETE`).

---

## Design Notes

**Message framing.** `SSL_read`/`SSL_write` (and the raw TCP `recv`/`send` beneath them) have no concept of message boundaries — one `sendData()` call is not guaranteed to correspond to exactly one `recvData()` call on the other end. Most of this protocol's exchanges are synchronous round-trips (send → wait for a specific reply → send next), which incidentally avoids the problem. The one place that isn't a round-trip is the folder handshake: `FOLDER_REQUEST` is sent immediately followed by `FILE_MANIFEST`, with nothing forcing a wait in between. Reading each with a single raw `recvData()` call on the receiver is unsafe two ways — the two messages can arrive coalesced into one read (corrupting the parse and then hanging on the second read, which waits for bytes that already arrived), or a large manifest can arrive split across several reads (silently truncating the file list). `Net::MsgReader` fixes this by buffering across reads and returning exactly one `\n`-delimited message at a time, however many underlying `SSL_read` calls that takes.

---

## Performance

256 KB chunks, `TCP_NODELAY`, and 1 MB socket buffers keep a single TCP connection close to link-saturated.

- **Real-world:** a 2.3 GB file transferred between two Linux laptops on shared, congested campus WiFi (not a clean lab LAN) in 6 min 13 sec — ~6.2 MB/s sustained.
- **Controlled benchmark:** 9.17 MB/s average (9.84 MB/s peak) on 250 MB payloads, across 9 trials over 3 runs on real campus WiFi. Full trial-by-trial breakdown and methodology in `BENCHMARKS.md`, produced with the built-in `--benchmark-auto-accept` / `BENCHMARK:` tooling.

These numbers are WiFi-bound, not link-bound — expect higher throughput on a wired LAN. Folder transfers currently send files sequentially over one connection rather than in parallel (see Roadmap).

---

## Getting Started

### Prerequisites
- Node.js & npm
- g++ (Linux/macOS) or MinGW-w64 (Windows)
- OpenSSL development headers — `libssl-dev` (Ubuntu/Debian), `openssl-devel` (Fedora), `openssl` (Arch), `openssl@3` via Homebrew (macOS), `mingw-w64-x86_64-openssl` via MSYS2 (Windows)

### Quick start
```bash
git clone https://github.com/thedevsumit/WinDrop.git
cd WinDrop
chmod +x start.sh   # Linux/macOS
./start.sh
```
```powershell
# Windows
.\start.ps1
# or start.bat
```
The script detects your OS, generates a local self-signed TLS certificate on first run, compiles `core`/`sender` against the correct platform file (resolving Homebrew's OpenSSL path on macOS), installs Node dependencies, and launches all three layers with clean shutdown on `Ctrl+C`.

### Manual setup (if the startup script fails)

**1. Install prerequisites** — see the OS-specific package lists above.
- **Windows**: install [MSYS2](https://www.msys2.org), then from the MSYS2 MinGW64 shell: `pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-openssl`, and add `C:\msys64\mingw64\bin` to `PATH`.

**2. Generate a TLS certificate** (from inside `backend/` — the binaries look for `cert.pem`/`key.pem` in their working directory at launch):
```bash
cd backend
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
```

**3. Compile the C++ core** (from inside `backend/` — matches what CI actually runs):
```bash
# Linux
g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp -o core -lssl -lcrypto
g++ -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp -o sender -lssl -lcrypto

# macOS — Homebrew's OpenSSL isn't on the default compiler path
OPENSSL_PREFIX="$(brew --prefix openssl@3)"
g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" -o core -lssl -lcrypto
g++ -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" -o sender -lssl -lcrypto

# Windows (MSYS2 MinGW64 shell)
g++ -std=c++17 core.cpp sha256.cpp net_platform_win.cpp -o core.exe -lssl -lcrypto -lws2_32
g++ -std=c++17 sender.cpp sha256.cpp net_platform_win.cpp -o sender.exe -lssl -lcrypto -lws2_32
```

**4. Start the backend**
```bash
# from backend/
npm install
node index.js
```

**5. Start the frontend** (second terminal)
```bash
cd frontend
npm install
npm run dev
```
Open the URL npm prints (typically `http://localhost:5173`).

### Benchmarking
Start the receiver with `--benchmark-auto-accept` to skip the interactive accept prompt for scripted, repeatable timing runs. The sender prints `BENCHMARK:<elapsedMs>|<fileSizeBytes>` on completion, suitable for parsing in a test script.

---

## Security

The file-transfer TCP channel is wrapped in TLS. On first run, a **self-signed certificate** is generated for the receiving peer — this is a LAN peer-to-peer tool, not a public-facing service, so there's no public CA to validate against.

To harden the trust model beyond blind certificate acceptance, WinDrop implements **trust-on-first-use (TOFU) certificate pinning**: the first time a sender connects to a given peer IP, it records the SHA-256 fingerprint of that peer's certificate in a local `known_peers.txt`. Every later connection to that IP is checked against the stored fingerprint; a mismatch aborts the connection before any protocol data is sent, and the UI surfaces `CERT_MISMATCH`. This protects every connection *after* the first against an active on-path attacker; it cannot protect the very first connection to a brand-new peer — the same tradeoff SSH host-key pinning makes.

Peer-supplied names are sanitized before touching the filesystem. A single-file transfer's filename goes through `sanitizeFilename()` (basename only — any directory component is stripped). A folder transfer's per-entry relative path goes through `sanitizeRelativePath()`, which normalizes separators, rejects a leading `/` or a Windows drive letter, and rejects a `..` (or empty) segment anywhere in the path — not just at the start, since a traversal segment buried mid-path (`photos/../../etc/passwd`) is exactly as dangerous as a leading one. Verified by code review and by sending an actual path-traversal payload over a live TLS connection during development.

---

## Testing & CI

Every push builds `core`/`sender` and runs the full test suite on `ubuntu-latest`, `windows-latest`, and `macos-latest`.

**Unit tests (all platforms)**
- `tests/test_sha256.cpp` — SHA-256 implementation against known test vectors, plus a single-byte-change collision check
- `tests/test_metadata.cpp` — resume-checkpoint read/write logic, including corrupted-file handling
- `tests/test_path_utils.cpp` — `sanitizeFilename()`/`sanitizeRelativePath()` against a battery of traversal payloads, including the exact exploit string used to originally confirm the vulnerability
- `tests/test_wire_parsers.js` — the key-value parsers behind `FOLDER_TRANSFER_COMPLETE`/`FOLDER_SEND_COMPLETE`, guarding specifically against a `received`/`failed`/`total` field-order regression that could otherwise misread a fully successful folder transfer as partial

**Integration tests (Linux, real compiled binaries over real sockets)**
- `tests/integration/test_resume_kill.sh` — kills the sender mid-transfer, resumes, asserts the final checksum is byte-exact
- `tests/integration/test_corrupted_resume.sh` — corrupts a partial file after interruption, asserts the receiver rejects the stale resume (`RESUME_STATE_INVALID`)
- `tests/integration/test_same_filename.sh` — fires two concurrent transfers at the same destination filename, asserts exactly one succeeds and the other is rejected with `FILE_BUSY`
- `tests/integration/concurrent_stress_test.sh` — 25 simultaneous transfers to one receiver, asserts all succeed, reports file-descriptor delta before/after load

```bash
cd tests
g++ -std=c++17 -I../backend test_sha256.cpp ../backend/sha256.cpp -o test_sha256 && ./test_sha256
g++ -std=c++17 -I../backend test_metadata.cpp -o test_metadata && ./test_metadata
g++ -std=c++17 -I../backend test_path_utils.cpp -o test_path_utils && ./test_path_utils
node test_wire_parsers.js
```
Run the integration scripts individually, not in parallel — `core`'s TCP/UDP ports (8080/8888) are hardcoded and a second instance can't bind them while one is running.

---

## Project Structure

```text
WinDrop/
├── backend/
│   ├── core.cpp                  # discovery, handshake, TLS accept, streaming receive, resume, checksum, folder loop
│   ├── sender.cpp                # per-transfer outbound process: manifest build, resume query, TLS connect + cert pinning, streaming send
│   ├── net_platform.h            # platform abstraction, inline OpenSSL TLS wrappers (incl. fingerprinting), Net::MsgReader
│   ├── net_platform_posix.cpp    # POSIX sockets (Linux/macOS)
│   ├── net_platform_win.cpp      # WinSock2 sockets (Windows)
│   ├── path_utils.h              # sanitizeFilename() + sanitizeRelativePath() — isolated for unit testing
│   ├── trust_store.h             # TOFU certificate pinning read/write
│   ├── metadata.h                # resume-checkpoint read/write (unit-testable in isolation)
│   ├── sha256.h / sha256.cpp     # from-scratch SHA-256 (FIPS 180-4)
│   ├── index.js                  # Express + Socket.IO coordination, process spawning, folder upload reconstruction, history API
│   ├── wireParsers.js            # key-value parsing for FOLDER_TRANSFER_COMPLETE / FOLDER_SEND_COMPLETE
│   └── package.json
├── frontend/
│   └── src/App.jsx               # drag & drop, folder picker, accept/reject modals, per-file + per-folder progress, history UI
├── tests/
│   ├── test_sha256.cpp
│   ├── test_metadata.cpp
│   ├── test_path_utils.cpp
│   ├── test_wire_parsers.js
│   └── integration/
│       ├── test_resume_kill.sh
│       ├── test_corrupted_resume.sh
│       ├── test_same_filename.sh
│       └── concurrent_stress_test.sh
├── benchmark_sender.sh / benchmark_receiver.sh
├── .github/workflows/build.yml   # CI: build + full test suite on Ubuntu, Windows, macOS
├── .gitignore
└── start.sh / start.bat / start.ps1
```

---

## Troubleshooting

### Setup
**`g++: command not found` / `'g++' is not recognized`** — compiler missing or not on `PATH`. Windows: run from an MSYS2 MinGW64 shell with its `bin` folder in `PATH`. Linux: `sudo apt install build-essential`. macOS: `xcode-select --install`.

**`fatal error: openssl/ssl.h: No such file or directory`** — OpenSSL headers missing. Linux: `sudo apt install libssl-dev`. macOS: `brew install openssl@3` and pass `-I"$(brew --prefix openssl@3)/include"`. Windows: `pacman -S mingw-w64-x86_64-openssl` in MSYS2.

**`undefined reference to 'SSL_CTX_new'`** — `-lssl -lcrypto` missing or in the wrong position; these flags must come *after* the source files on the g++ command line.

**`npm: command not found` / `npm install` fails immediately** — Node.js not installed or installed without npm. Reinstall from [nodejs.org](https://nodejs.org), confirm with `node -v && npm -v`.

**Windows: `start.bat`/`start.ps1` closes immediately with no visible error** — run it from an already-open terminal instead of double-clicking. If PowerShell blocks it:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\start.ps1
```

### Runtime
**`Failed to initialize TLS Context with cert.pem/key.pem`** — no certificate generated yet, or `core`/`sender` launched from the wrong directory (it looks for `cert.pem`/`key.pem` in its current working directory, not next to the binary). Generate the cert inside `backend/` and always launch from there.

**`error: 'TCP_NODELAY' was not declared in this scope` (Linux)** — only if editing `net_platform_posix.cpp`; add `#include <netinet/tcp.h>`.

**`bind: Address already in use` / core exits immediately** — another `core` instance (possibly a leftover crashed test run) is holding port 8080 or 8888.
```bash
# Linux/macOS
lsof -i :8080 && pkill -f "./core"
```
```powershell
# Windows
Get-NetTCPConnection -LocalPort 8080 | Select-Object OwningProcess
Stop-Process -Id <PID>
```
This is also why the integration test scripts must run one at a time.

**A folder transfer stalls or hangs right after being accepted** — if you're running code older than the `Net::MsgReader` fix (see Design Notes), this was a known issue: the `FOLDER_REQUEST`/`FILE_MANIFEST` pair could arrive coalesced into one read on a fast LAN/loopback, corrupting the parse and hanging the connection. Pull the latest `core.cpp`/`net_platform.h` if you hit this.

**Two peers on the same WiFi don't discover each other** — usually a network config issue, not a bug. Some routers and most corporate/campus WiFi enable **IGMP snooping**, which silently drops UDP multicast between two devices on the same AP even though normal traffic works fine. There's no in-app diagnostic yet to distinguish this from "peer not present" (see Roadmap).

**`CERT_MISMATCH` on a peer you expect to trust** — the certificate presented by that IP no longer matches the fingerprint pinned on first connection; treated as a possible active attack and refused by design. Usually legitimate cause: the peer regenerated `cert.pem` (deleted it, reinstalled, etc.). If you're certain the peer is legitimate, remove their stale entry and re-pin:
```bash
grep -v "<their-ip>" known_peers.txt > known_peers.tmp && mv known_peers.tmp known_peers.txt
```

---

## Roadmap

- [ ] Extend the buffered `Net::MsgReader` framing to every control-message read path, not just the folder handshake, for defense-in-depth against message splitting under adverse network conditions
- [ ] Parallel/concurrent file sending within a folder transfer, instead of strictly sequential over one connection
- [ ] Decouple disk writes from the network receive loop (dedicated writer thread + queue) so a slow disk can't stall the socket read
- [ ] Parallel-stream transfer mode to recover throughput on lossy/high-latency networks
- [ ] Extend integration test coverage to macOS and Windows (currently Linux-only in CI), including a folder-transfer integration test
- [ ] In-app diagnostic to distinguish "peer not on network" from "multicast blocked by network config"
- [ ] Bandwidth throttling
- [ ] Documented way to un-pin/rotate a peer's certificate without manually editing `known_peers.txt`

---

## Authors

**Sumit Kumar** — [@thedevsumit](https://github.com/thedevsumit)
**Lovepreet Singh** — [@luvpee](https://github.com/luvpee)