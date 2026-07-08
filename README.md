<div align="center">

# WinDrop

### High-performance peer-to-peer file sharing powered by MERN and C++

WinDrop combines a modern React interface with a native C++ networking core for peer discovery and direct file transmission.

[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=node.js&logoColor=white)]()
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?logo=react&logoColor=black)]()
[![Express](https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=white)]()
[![C++](https://img.shields.io/badge/C%2B%2B-P2P_Core-00599C?logo=cplusplus&logoColor=white)]()

</div>

---

## Overview

**WinDrop** is a peer-to-peer file-sharing application built using a hybrid **React, Node.js, Express, and C++ architecture**.

The web layer provides an accessible interface for managing file-sharing sessions, while the native C++ layer handles peer discovery and direct socket-based file transmission.

---

## Features

- Direct peer-to-peer file transfer
- Native C++ socket-based networking
- Lighthouse-style peer discovery
- Chunk-based file transmission
- Sender and receiver communication
- React-based web interface
- Node.js and Express coordination layer
- Automated startup and C++ compilation
- Graceful process cleanup

---

## Architecture

```text
┌─────────────────────┐
│   React Frontend    │
│   User Interface    │
└──────────┬──────────┘
           │
           │ HTTP / Signaling
           ▼
┌─────────────────────┐
│ Node.js + Express   │
│ Backend             │
└──────────┬──────────┘
           │
           │ Process Coordination
           ▼
┌─────────────────────┐
│ C++ Networking Core │
│ Peer Discovery      │
└──────────┬──────────┘
           │
           │ Direct Socket Transfer
           ▼
    ┌─────────────┐
    │ Peer ↔ Peer │
    └─────────────┘
```

The system separates responsibilities into three layers:

- **Frontend** — manages user interaction and file-sharing workflows
- **Backend** — handles application coordination and communication with native processes
- **C++ Core** — manages peer discovery and direct socket-based transmission

---

## Project Structure

```text
WinDrop/
├── backend/
│   ├── .gitignore
│   ├── core
│   ├── core.cpp
│   ├── index.js
│   ├── package-lock.json
│   ├── package.json
│   ├── sender
│   └── sender.cpp
│
├── frontend/
│   ├── src/
│   ├── .gitignore
│   ├── eslint.config.js
│   ├── index.html
│   ├── package-lock.json
│   ├── package.json
│   ├── README.md
│   └── vite.config.js
│
├── sockets/
│   ├── broadcaster
│   ├── broadcaster.cpp
│   ├── core
│   ├── core.cpp
│   ├── listener
│   ├── listener.cpp
│   ├── my_file.txt
│   ├── received_file.txt
│   ├── receiver
│   ├── receiver.cpp
│   ├── sender
│   └── sender.cpp
│
└── start.sh
```

---

## Tech Stack

| Layer | Technology |
|------|------------|
| Frontend | React, Vite |
| Backend | Node.js, Express |
| Networking Core | C++ |
| Communication | TCP/IP Sockets |
| Build | g++ |
| Automation | Bash |

---

## Getting Started

### Prerequisites

Ensure the following are installed:

- Node.js
- npm
- g++
- Bash-compatible shell

Verify:

```bash
node --version
npm --version
g++ --version
```

### 1. Clone the Repository

```bash
git clone https://github.com/thedevsumit/WinDrop.git
cd WinDrop
```

### 2. Make the Startup Script Executable

```bash
chmod +x start.sh
```

### 3. Run WinDrop

```bash
./start.sh
```

The startup script handles:

- C++ source compilation
- Backend dependency installation
- Frontend dependency installation
- Native core startup
- Node.js backend startup
- React frontend startup
- Background process cleanup on exit

---

## How It Works

```text
1. User selects a file
        │
        ▼
2. Sharing session is initialized
        │
        ▼
3. Peer discovery begins
        │
        ▼
4. Connection details are exchanged
        │
        ▼
5. Direct socket connection is established
        │
        ▼
6. File is transmitted between peers
        │
        ▼
7. Receiver reconstructs the file
```

---

## Development

Run components manually if required.

### Backend

```bash
cd backend
npm install
node index.js
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Compile C++ Core

```bash
cd backend
g++ core.cpp -o core
g++ sender.cpp -o sender
```

---

## Author

**Sumit Kumar**

GitHub: [@thedevsumit](https://github.com/thedevsumit)

---

<div align="center">

Built with React, Node.js, Express, and C++ for direct peer-to-peer file sharing.

</div>
