#!/bin/bash
set -e
cd "$(dirname "$0")/../../backend"

mkdir -p /tmp/windrop_corrupt_test
g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp -o /tmp/windrop_corrupt_test/core_test -lssl -lcrypto
g++ -pthread -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp -o /tmp/windrop_corrupt_test/sender_test -lssl -lcrypto

cd /tmp/windrop_corrupt_test
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan" 2>/dev/null

rm -f known_peers.txt core_log.txt bigfile.bin bigfile.bin.part bigfile.bin.part.meta sender_pipe

echo "Generating 500MB test file..."
head -c 500000000 /dev/urandom > bigfile.bin
ORIGINAL_CHECKSUM=$(sha256sum bigfile.bin | awk '{print $1}')

./core_test --benchmark-auto-accept < /dev/null > core_log.txt 2>&1 &
CORE_PID=$!
sleep 1

echo "Producing a partial .part file (kill mid-stream, same technique as the resume test)..."
mkfifo sender_pipe
./sender_test 127.0.0.1 bigfile.bin corrupttest1 > sender_pipe 2>&1 &
SENDER_PID=$!
timeout 15 grep -m1 "SENDER_PROGRESS" sender_pipe > /dev/null
kill -9 $SENDER_PID 2>/dev/null
rm -f sender_pipe
sleep 0.5

if [ ! -f bigfile.bin.part ]; then
    echo "FAIL: no .part file produced to corrupt"
    kill -9 $CORE_PID 2>/dev/null
    exit 1
fi

echo "Corrupting the first chunk of the .part file (this is exactly what the resume prefix-hash check covers)..."
python3 -c "
with open('bigfile.bin.part', 'r+b') as f:
    f.seek(100)
    f.write(b'\x00' * 10)
"

echo "Attempting resume against the corrupted .part file..."
./sender_test 127.0.0.1 bigfile.bin corrupttest2 > sender_resume_log.txt 2>&1
cat sender_resume_log.txt

kill -9 $CORE_PID 2>/dev/null

if ! grep -q "RESUME_STATE_INVALID" core_log.txt; then
    echo "FAIL: the corrupted resume was not detected — no RESUME_STATE_INVALID in receiver log"
    echo "--- receiver log ---"
    cat core_log.txt
    exit 1
fi
echo "Confirmed: corrupted resume was correctly rejected (RESUME_STATE_INVALID)"

if ! grep -q "Starting new transfer" sender_resume_log.txt; then
    echo "FAIL: sender did not fall back to a fresh transfer after rejection"
    exit 1
fi

if ! grep -q "SUCCESS" sender_resume_log.txt; then
    echo "FAIL: fresh transfer after rejection did not complete successfully"
    exit 1
fi

FINAL_CHECKSUM=$(sha256sum bigfile.bin | awk '{print $1}')
if [ "$FINAL_CHECKSUM" != "$ORIGINAL_CHECKSUM" ]; then
    echo "FAIL: checksum mismatch — original $ORIGINAL_CHECKSUM, got $FINAL_CHECKSUM"
    exit 1
fi

echo "PASS: corrupted .part file was correctly rejected, and the final file is byte-exact"
exit 0