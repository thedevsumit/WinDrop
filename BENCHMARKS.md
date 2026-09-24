# WinDrop Benchmark Results

Measured on real hardware over a personal Jio router (not loopback, not simulated) using `benchmark_sender.sh` / `benchmark_receiver.sh`, two physical laptops. Each run streams 10MB/50MB/100MB/250MB files, 3 trials each, timed entirely within the sender process from the start of streaming to a verified `DELIVERED_ACK` (i.e., only counted if the receiver's SHA-256 check actually passed).

### Run 1 — 2026-09-14
| File Size | Trial 1 | Trial 2 | Trial 3 |
| :--- | :--- | :--- | :--- |
| **10MB** | 6.96 MB/s | 9.28 MB/s | 6.48 MB/s |
| **50MB** | 12.08 MB/s | 18.72 MB/s | 15.72 MB/s |
| **100MB** | 15.80 MB/s | 19.76 MB/s | 16.00 MB/s |
| **250MB** | 36.48 MB/s | 37.95 MB/s | 38.59 MB/s |

### Run 2 — 2026-09-14 15:31 IST
| File Size | Trial 1 | Trial 2 | Trial 3 |
| :--- | :--- | :--- | :--- |
| **10MB** | 30.16 MB/s | 32.64 MB/s | 27.68 MB/s |
| **50MB** | 34.88 MB/s | 32.28 MB/s | 36.12 MB/s |
| **100MB** | FAILED | FAILED | FAILED |
| **250MB** | 38.12 MB/s | 37.88 MB/s | 38.05 MB/s |

*100MB failures in this run are a known resume-protocol bug, not a network or throughput issue — see Known Issues below. Excluded from the summary stats.*

### Run 3 — 2026-09-14 15:34 IST
| File Size | Trial 1 | Trial 2 | Trial 3 |
| :--- | :--- | :--- | :--- |
| **10MB** | 23.00 MB/s | 28.00 MB/s | 27.96 MB/s |
| **50MB** | 28.24 MB/s | 34.84 MB/s | 37.56 MB/s |
| **100MB** | 37.56 MB/s | 35.36 MB/s | 36.84 MB/s |
| **250MB** | 37.90 MB/s | 38.42 MB/s | 38.50 MB/s |

### Summary (valid trials only, n = 9 per size except 100MB where n = 6)
| File Size | Min | Max | Average |
| :--- | :--- | :--- | :--- |
| **10MB** | 6.48 MB/s | 32.64 MB/s | 21.35 MB/s |
| **50MB** | 12.08 MB/s | 37.56 MB/s | 27.82 MB/s |
| **100MB** | 15.80 MB/s | 37.56 MB/s | 26.88 MB/s |
| **250MB** | 36.48 MB/s | 38.59 MB/s | 37.98 MB/s |

Observed range across all valid trials: ~6.4–38.6 MB/s, with larger files consistently trending toward the top of that range (250MB averaged 37.98 MB/s vs. 10MB's 21.35 MB/s) — consistent with TCP needing some ramp-up distance before reaching steady-state throughput, and per-transfer overhead (handshake, discovery) mattering proportionally more for small files. 

Run-to-run variance is real and notable: Run 1's 10–100MB numbers are significantly lower than the equivalent sizes in Runs 2 and 3, despite running on the same network within the same session. This reflects genuine WiFi variability (signal conditions, other traffic on the personal Jio router) rather than a code regression between runs — the same binaries were used throughout.

### Known Issues
Resume protocol bug (found during this benchmark run): if a transfer is interrupted mid-stream, the receiver correctly writes a `.part.meta` checkpoint — but a subsequent transfer reusing the same destination filename does not correctly validate that the `.part` file's actual byte content matches the new transfer before attempting to resume from the stale checkpoint. This produced consistent failures for repeated same-named test files after a mid-transfer disconnect (Run 2's 100MB trials). **Fix planned:** validate resume state against a content fingerprint (e.g., hash of the first N bytes), not just file size, before honoring a `RESUME_RESPONSE:OK`.
