#!/bin/bash
# Run this on the SENDING laptop, after benchmark_receiver.sh is already
# running on the other machine.
#
# Usage: ./benchmark_sender.sh <receiver_ip>

RECEIVER_IP="$1"
if [ -z "$RECEIVER_IP" ]; then
    echo "Usage: $0 <receiver_ip>"
    exit 1
fi

cd "$(dirname "$0")/backend" || { echo "Run this from the repo root, or place it next to backend/"; exit 1; }

SIZES_MB=(10 50 100 250)
TRIALS=3
RESULTS_FILE="../BENCHMARKS.md"

echo "# WinDrop Benchmark Results" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "Network: NITJ_E_BLOCK | Date: $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "| File Size | Trial | Time (s) | Throughput (MB/s) |" >> "$RESULTS_FILE"
echo "|---|---|---|---|" >> "$RESULTS_FILE"

for size in "${SIZES_MB[@]}"; do
    testfile="/tmp/bench_${size}mb.bin"
    head -c "${size}000000" /dev/urandom > "$testfile"

    for trial in $(seq 1 $TRIALS); do
        echo "Running ${size}MB, trial $trial..."
        output=$(./sender "$RECEIVER_IP" "$testfile" "bench-${size}mb-${trial}-$RANDOM" 2>&1)
        bench_line=$(echo "$output" | grep "BENCHMARK:")

        if [ -z "$bench_line" ]; then
            echo "  FAILED -- no BENCHMARK line found. Output was:"
            echo "$output" | sed 's/^/    /'
            echo "| ${size}MB | $trial | FAILED | FAILED |" >> "$RESULTS_FILE"
            continue
        fi

        elapsed_ms=$(echo "$bench_line" | cut -d: -f2 | cut -d\| -f1)
        bytes=$(echo "$bench_line" | cut -d\| -f2)
        elapsed_s=$(echo "scale=3; $elapsed_ms / 1000" | bc)
        throughput=$(echo "scale=2; ($bytes / 1000000) / $elapsed_s" | bc)

        echo "  ${elapsed_s}s -> ${throughput} MB/s"
        echo "| ${size}MB | $trial | $elapsed_s | $throughput |" >> "$RESULTS_FILE"
    done

    rm -f "$testfile"
done

echo ""
echo "Done. Results written to $RESULTS_FILE"