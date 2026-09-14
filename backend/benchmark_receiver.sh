#!/bin/bash
# Run this on the RECEIVING laptop.
# Starts core in benchmark mode -- auto-accepts every incoming transfer,
# no manual clicking needed for repeated automated runs.

cd "$(dirname "$0")/backend" || { echo "Run this from the repo root, or place it next to backend/"; exit 1; }

if [ ! -f "cert.pem" ] || [ ! -f "key.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
fi

echo "Starting receiver in benchmark mode. Leave this running."
echo "Note this machine's LAN IP (run 'ip addr' or 'hostname -I') -- you'll need it on the sender side."
./core --benchmark-auto-accept