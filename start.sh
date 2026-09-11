
echo "Building"


cd backend

if [ ! -f core ] || [ ! -f sender ]; then
    echo "Compiling engines"
    g++ -pthread core.cpp sha256.cpp -o core
    g++ sender.cpp sha256.cpp -o sender
fi

if [ ! -d "node_modules" ]; then
    echo "Installing modules"
    npm i
fi

echo "Starting core of project"
./core &
CORE_PID=$!

node index.js &
NODE_PID=$!

cd ..


echo "Live"

trap "echo -e '\nShutting down'; kill -9 $CORE_PID $NODE_PID 2>/dev/null; exit" SIGINT

cd frontend

if [ ! -d "node_modules" ]; then
    echo "Installing modules"
    npm i
fi

BROWSER=none npm run dev