#!/bin/bash

echo "Building WinDrop..."

cleanup() {
    echo -e "\nShutting down WinDrop..."

    kill "$NODE_PID" "$FRONTEND_PID" 2>/dev/null

    pkill -f "./core" 2>/dev/null
    pkill -f "./core.exe" 2>/dev/null
    pkill -f "./sender" 2>/dev/null
    pkill -f "./sender.exe" 2>/dev/null

    echo "Shutdown complete."
    exit 0
}

trap cleanup SIGINT

echo "Setting up Backend..."

cd backend || {
    echo "Backend directory not found"
    exit 1
}

if [ ! -f "cert.pem" ] || [ ! -f "key.pem" ]; then
    echo "Generating self-signed TLS certificate for local LAN use..."
    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
fi

echo "Compiling C++ Engines..."

OS_NAME="$(uname)"

if [[ "$OS_NAME" == "Linux" ]]; then

    echo "Compiling for Linux..."

    g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp \
        -o core -lssl -lcrypto || {
        echo "Compilation of core failed"
        exit 1
    }

    g++ -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp \
        -o sender -lssl -lcrypto || {
        echo "Compilation of sender failed"
        exit 1
    }

elif [[ "$OS_NAME" == "Darwin" ]]; then

    echo "Compiling for macOS..."

    # macOS doesn't ship OpenSSL dev headers -- Apple dropped them in favor
    # of its own Security framework. The standard fix is Homebrew, but
    # Homebrew doesn't put openssl on the default compiler search path
    # (Apple Silicon: /opt/homebrew, Intel: /usr/local), so we have to find
    # it explicitly rather than assuming a bare -lssl -lcrypto will link.
    OPENSSL_PREFIX=""
    if command -v brew &> /dev/null; then
        OPENSSL_PREFIX="$(brew --prefix openssl@3 2>/dev/null || brew --prefix openssl 2>/dev/null)"
    fi

    if [ -z "$OPENSSL_PREFIX" ] || [ ! -d "$OPENSSL_PREFIX/include" ]; then
        echo "Could not find OpenSSL via Homebrew."
        echo "Install it with:  brew install openssl@3"
        echo "Then re-run this script."
        exit 1
    fi

    echo "Using OpenSSL from: $OPENSSL_PREFIX"

    g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_posix.cpp \
        -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" \
        -o core -lssl -lcrypto || {
        echo "Compilation of core failed"
        exit 1
    }

    g++ -std=c++17 sender.cpp sha256.cpp net_platform_posix.cpp \
        -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" \
        -o sender -lssl -lcrypto || {
        echo "Compilation of sender failed"
        exit 1
    }

else

    echo "Compiling for Windows (MinGW)..."

    g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_win.cpp \
        -o core.exe -lws2_32 -liphlpapi -lssl -lcrypto -lcrypt32 || {
        echo "Compilation of core.exe failed"
        exit 1
    }

    g++ -std=c++17 sender.cpp sha256.cpp net_platform_win.cpp \
        -o sender.exe -lws2_32 -liphlpapi -lssl -lcrypto -lcrypt32 || {
        echo "Compilation of sender.exe failed"
        exit 1
    }

fi

if [ ! -d "node_modules" ]; then
    echo "Installing backend modules..."
    npm install
fi

echo "Starting Node Backend..."

node index.js &
NODE_PID=$!

cd ..

echo "Setting up Frontend..."

cd frontend || {
    echo "Frontend directory not found"
    exit 1
}

if [ ! -d "node_modules" ]; then
    echo "Installing frontend modules..."
    npm install
fi

echo "Starting React Frontend..."

BROWSER=none npm run dev &
FRONTEND_PID=$!

echo -e "\nWinDrop is Live! Press Ctrl+C to safely shut everything down.\n"

wait "$NODE_PID" "$FRONTEND_PID"