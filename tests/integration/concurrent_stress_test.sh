#!/bin/bash
set -e
cd "$(dirname "$0")/../../backend"

# Create the directory FIRST so the compiler has a place to put the output
mkdir -p /tmp/windrop_stress

# Build both binaries — the original version of this script only built core_test
# and never built sender_test at all.
g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp -o /tmp/windrop_stress/core_test -lssl -lcrypto
g++ -pthread -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp -o /tmp/windrop_stress/sender_test -lssl -lcrypto

# Change to the target directory
cd /tmp/windrop_stress

# Generate a real cert instead of the placeholder /path/to/cert.pem from before.
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan" 2>/dev/null

rm -f known_peers.txt core_stress.log sender_*.log file_*.bin

./core_test --benchmark-auto-accept < /dev/null > core_stress.log 2>&1 &
CORE_PID=$!
sleep 1

echo "Launching 25 concurrent transfers..."
declare -a SENDER_PIDS
for i in $(seq 1 25); do
    head -c 100000 /dev/urandom > "file_$i.bin"
    ./sender_test 127.0.0.1 "file_$i.bin" "stress_$i" > "sender_$i.log" 2>&1 &
    SENDER_PIDS+=($!)
done

# Wait ONLY on the sender PIDs. core_test runs forever by design (it's a
# server) — a bare `wait` with no arguments waits for every backgrounded job
# in the shell, including the server, and hangs forever. This was the actual
# bug behind "all 25 tests failed": every transfer had already succeeded, the
# script just never reached the point where it checked the logs.
for pid in "${SENDER_PIDS[@]}"; do
    wait "$pid"
done

FAILURES=0
for i in $(seq 1 25); do
    if ! grep -q "SUCCESS" "sender_$i.log"; then
        echo "FAIL: transfer $i did not complete successfully"
        FAILURES=$((FAILURES+1))
    fi
done

echo "Open file descriptors held by core process: $(ls /proc/$CORE_PID/fd 2>/dev/null | wc -l)"
kill -9 $CORE_PID 2>/dev/null

if [ $FAILURES -eq 0 ]; then
    echo "ALL 25 CONCURRENT TRANSFERS SUCCEEDED"
    exit 0
else
    echo "$FAILURES TRANSFER(S) FAILED UNDER CONCURRENT LOAD"
    exit 1
fi