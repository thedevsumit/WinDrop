# WinDrop: Evolution & Learning Outcomes

This document outlines the architectural journey of WinDrop from a basic file-sharing prototype to a robust, production-style P2P system.

## 🛠 The Evolution Journey

### 1. From "Push" to "Handshake"
**Original State**: Sender connected and immediately streamed data.
**Problem**: No control for the receiver; unwanted files could be written to disk.
**Solution**: Implemented a synchronous handshake (`REQUEST` $\rightarrow$ `DECISION` $\rightarrow$ `TRANSFER`).
**Outcome**: The receiver now explicitly accepts or rejects transfers via a React modal.

### 2. Real-Time Visibility
**Problem**: Users had no idea how much of a file had been transferred.
**Solution**: Implemented chunk-based progress tracking in both directions.
- **Receiving**: C++ core emits progress events $\rightarrow$ Node.js $\rightarrow$ Socket.IO $\rightarrow$ React Progress Bar.
- **Sending**: Sender emits progress after receiving ACKs $\rightarrow$ Node.js $\rightarrow$ Socket.IO $\rightarrow$ React Progress Bar.

### 3. Reliability & Resumability
**Problem**: Network interruptions forced transfers to restart from zero.
**Solution**: Introduced `.part` and `.part.meta` files.
- **Protocol**: Added `RESUME_QUERY` and `RESUME_RESPONSE` to the handshake.
- **Outcome**: Transfers can now resume from the last successfully written chunk.

### 4. Data Integrity
**Problem**: TCP ensures packet delivery, but not application-level file integrity.
**Solution**: Integrated SHA256 checksums.
- **Process**: Sender computes hash $\rightarrow$ sends as `COMPLETE:hash` $\rightarrow$ Receiver verifies local file $\rightarrow$ sends `DELIVERED_ACK`.

### 5. Performance Optimization
**Problem**: Frequent disk writes caused high latency and I/O overhead.
**Solution**: Implemented buffered writes.
- **Mechanism**: Data is accumulated in a memory buffer and flushed to disk only when a threshold (16KB) is reached.

### 6. System Robustness
**Problem**: Errors were silent or generic.
**Solution**: Implemented a structured error protocol (`ERROR:CODE|ID`).
- **Outcome**: Frontend can now display specific error toasts (e.g., `CHECKSUM_MISMATCH`, `PERMISSION_DENIED`).

### 7. User Experience (UX)
**Problem**: No record of past transfers; limited to one transfer at a time.
**Solution**:
- **History**: JSON-based persistence layer to track all transfer results.
- **Concurrency**: Transitioned to an asynchronous "Fire-and-Forget" model, allowing multiple simultaneous uploads.

### 8. Cross-Platform Compatibility
**Problem**: POSIX headers caused compilation failure on Windows.
**Solution**: Built a Platform Abstraction Layer (PAL).
- **Design**: Encapsulated OS-specific socket logic into a unified `Net` namespace.
- **Outcome**: Single codebase that compiles on both Windows (MinGW) and Linux.

## 🎓 Key Learning Outcomes

### Architectural Patterns
- **Hybrid Architecture**: Combining the agility of a MERN stack with the performance of C++ native sockets.
- **IPC Coordination**: Managing bidirectional communication between a high-level coordinator (Node.js) and a low-level engine (C++).
- **State Machines**: Implementing a multi-step handshake protocol to manage connection states.

### Networking Fundamentals
- **P2P Discovery**: Using UDP Broadcasting and Multicast for zero-config peer discovery.
- **TCP Stream Management**: Handling chunking, ACKs, and timeouts in a raw socket environment.
- **Platform Abstraction**: Learning how to wrap OS-specific APIs (Winsock vs. POSIX) to achieve portability.

### Systems Programming
- **Buffered I/O**: Understanding the trade-off between memory usage and disk I/O performance.
- **Concurrency**: Managing multi-threaded C++ servers and asynchronous Node.js child processes.
- **Integrity Verification**: Implementing end-to-end checksums to guarantee file correctness.
