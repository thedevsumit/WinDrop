# WinDrop Benchmark Results

Measured on real hardware over NITJ_E_BLOCK WiFi (not loopback, not simulated) using `benchmark_sender.sh` / `benchmark_receiver.sh`, two physical laptops. Each run streams 10MB/50MB/100MB/250MB files, 3 trials each, timed entirely within the sender process from the start of streaming to a verified `DELIVERED_ACK` (i.e., only counted if the receiver's SHA-256 check actually passed).

## Run 1 — 2026-09-14

| File Size | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| 10MB | 1.74 MB/s | 2.32 MB/s | 1.62 MB/s |
| 50MB | 3.02 MB/s | 4.68 MB/s | 3.93 MB/s |
| 100MB | 3.95 MB/s | 4.94 MB/s | 4.00 MB/s |
| 250MB | 5.48 MB/s | 9.46 MB/s | 9.80 MB/s |

## Run 2 — 2026-09-14 15:31 IST

| File Size | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| 10MB | 7.54 MB/s | 8.16 MB/s | 6.92 MB/s |
| 50MB | 8.72 MB/s | 8.07 MB/s | 9.03 MB/s |
| 100MB | **FAILED** | **FAILED** | **FAILED** |
| 250MB | 9.71 MB/s | 9.68 MB/s | 9.53 MB/s |

**100MB failures in this run are a known resume-protocol bug, not a network or throughput issue** — see [Known Issues](#known-issues) below. Excluded from the summary stats.

## Run 3 — 2026-09-14 15:34 IST

| File Size | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| 10MB | 5.75 MB/s | 7.00 MB/s | 6.99 MB/s |
| 50MB | 7.06 MB/s | 8.71 MB/s | 9.39 MB/s |
| 100MB | 9.39 MB/s | 8.84 MB/s | 9.21 MB/s |
| 250MB | 9.24 MB/s | 9.82 MB/s | 9.84 MB/s |

## Summary (valid trials only, n = 9 per size except 100MB where n = 6)

| File Size | Min | Max | Average |
|---|---|---|---|
| 10MB | 1.62 MB/s | 8.16 MB/s | 5.34 MB/s |
| 50MB | 3.02 MB/s | 9.39 MB/s | 6.96 MB/s |
| 100MB | 3.95 MB/s | 9.39 MB/s | 6.72 MB/s |
| 250MB | 5.48 MB/s | 9.84 MB/s | 9.17 MB/s |

**Observed range across all valid trials: ~1.6–9.8 MB/s**, with larger files consistently trending toward the top of that range (250MB averaged 9.17 MB/s vs. 10MB's 5.34 MB/s) — consistent with TCP needing some ramp-up distance before reaching steady-state throughput, and per-transfer overhead (handshake, discovery) mattering proportionally more for small files.

**Run-to-run variance is real and notable**: Run 1's 10–100MB numbers are 3–5x lower than the equivalent sizes in Runs 2 and 3, despite running on the same network within the same session. This reflects genuine WiFi variability (signal conditions, other traffic on the access point) rather than a code regression between runs — the same binaries were used throughout.

## Known Issues

- **Resume protocol bug (found during this benchmark run)**: if a transfer is interrupted mid-stream, the receiver correctly writes a `.part.meta` checkpoint — but a *subsequent* transfer reusing the same destination filename does not correctly validate that the `.part` file's actual byte content matches the new transfer before attempting to resume from the stale checkpoint. This produced consistent failures for repeated same-named test files after a mid-transfer disconnect (Run 2's 100MB trials). **Fix planned**: validate resume state against a content fingerprint (e.g., hash of the first N bytes), not just file size, before honoring a `RESUME_RESPONSE:OK`.