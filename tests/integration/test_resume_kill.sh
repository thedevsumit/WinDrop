#!/bin/bash
set -e
cd "$(dirname "$0")/../../backend"

mkdir -p /tmp/windrop_resume_test
g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp -o /tmp/windrop_resume_test/core_test -lssl -lcrypto
g++ -pthread -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp -o /tmp/windrop_resume_test/sender_test -lssl -lcrypto

cd /tmp/windrop_resume_test
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan" 2>/dev/null

rm -f known_peers.txt core_log.txt bigfile.bin bigfile.bin.part bigfile.bin.part.meta sender_pipe

# 500MB is deliberately large — needs to be big enough that killing the
# sender right after the FIRST progress line still lands mid-stream, not
# after the transfer has already finished (loopback is fast).
echo "Generating 500MB test file..."
head -c 500000000 /dev/urandom > bigfile.bin
ORIGINAL_CHECKSUM=$(sha256sum bigfile.bin | awk '{print $1}')

./core_test --benchmark-auto-accept < /dev/null > core_log.txt 2>&1 &
CORE_PID=$!
sleep 1

echo "Starting transfer, will kill sender at first progress report..."
mkfifo sender_pipe
./sender_test 127.0.0.1 bigfile.bin killtest > sender_pipe 2>&1 &
SENDER_PID=$!

# Block until the sender has genuinely started streaming, then kill it hard.
timeout 15 grep -m1 "SENDER_PROGRESS" sender_pipe > /dev/null
kill -9 $SENDER_PID 2>/dev/null
rm -f sender_pipe
sleep 0.5

PARTIAL_SIZE=$(stat -c%s bigfile.bin.part 2>/dev/null || echo 0)
FULL_SIZE=$(stat -c%s bigfile.bin)

if [ "$PARTIAL_SIZE" -eq 0 ] || [ "$PARTIAL_SIZE" -ge "$FULL_SIZE" ]; then
    echo "FAIL: expected a genuinely partial .part file, got size $PARTIAL_SIZE (full is $FULL_SIZE)"
    kill -9 $CORE_PID 2>/dev/null
    exit 1
fi
echo "Confirmed partial .part file: $PARTIAL_SIZE / $FULL_SIZE bytes"

echo "Resuming transfer..."
./sender_test 127.0.0.1 bigfile.bin resumetest > sender_resume_log.txt 2>&1
cat sender_resume_log.txt

kill -9 $CORE_PID 2>/dev/null

if ! grep -q "Resuming transfer from chunk" sender_resume_log.txt; then
    echo "FAIL: resume did not actually resume — restarted from scratch instead"
    exit 1
fi

if ! grep -q "SUCCESS" sender_resume_log.txt; then
    echo "FAIL: resumed transfer did not complete successfully"
    exit 1
fi

FINAL_CHECKSUM=$(sha256sum bigfile.bin | awk '{print $1}')
if [ "$FINAL_CHECKSUM" != "$ORIGINAL_CHECKSUM" ]; then
    echo "FAIL: checksum mismatch after resume — original $ORIGINAL_CHECKSUM, got $FINAL_CHECKSUM"
    exit 1
fi

echo "PASS: mid-transfer kill + resume completed with correct byte-exact checksum"
exit 0