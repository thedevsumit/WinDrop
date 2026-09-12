#!/bin/bash

echo "Building WinDrop..."

cleanup() {
    echo -e "\nShutting down WinDrop..."
    kill $NODE_PID $FRONTEND_PID 2>/dev/null
    pkill -f "./core" 2>/dev/null
    pkill -f "./sender" 2>/dev/null
    echo "Shutdown complete."
    exit 0
}

trap cleanup SIGINT

echo "Setting up Backend..."
cd backend || { echo "Backend directory not found"; exit 1; }

echo "Compiling C++ Engines..."
if [ "$(uname)" = "Linux" ] || [ "$(uname)" = "Darwin" ]; then
    PLATFORM_FILE="net_platform_posix.cpp"
else
    PLATFORM_FILE="net_platform_win.cpp"
fi

g++ -pthread core.cpp sha256.cpp "$PLATFORM_FILE" -o core || { echo "Compilation of core failed"; exit 1; }
g++ -pthread sender.cpp sha256.cpp "$PLATFORM_FILE" -o sender || { echo "Compilation of sender failed"; exit 1; }

if [ ! -d "node_modules" ]; then
    echo "Installing backend modules..."
    npm install
fi

echo "Starting Node Backend..."
node index.js &
NODE_PID=$!

cd ..

echo "Setting up Frontend..."
cd frontend || { echo "Frontend directory not found"; exit 1; }

if [ ! -d "node_modules" ]; then
    echo "Installing frontend modules..."
    npm install
fi

echo "Starting React Frontend..."
BROWSER=none npm run dev &
FRONTEND_PID=$!

echo -e "\nWinDrop is Live! Press Ctrl+C to safely shut everything down.\n"

wait $NODE_PID $FRONTEND_PID