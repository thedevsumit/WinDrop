## Manual Setup (if `start.sh` / `start.bat` / `start.ps1` doesn't work)

The startup scripts automate certificate generation, compilation, dependency install, and launching all three layers. If a script fails on your machine (permissions, missing tool, shell quirk), you can do every step by hand below.

---

### 1. Install prerequisites

**Windows**
- [Node.js LTS](https://nodejs.org) (includes npm)
- A C++ toolchain — either:
  - **MSYS2 + MinGW-w64** (recommended): install from [msys2.org](https://www.msys2.org), then in the MSYS2 MinGW64 shell:
    ```bash
    pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-openssl
    ```
  - or **Visual Studio Build Tools** with the "Desktop development with C++" workload (requires adjusting the compile commands below to use `cl` instead of `g++`)
- Add MinGW64's `bin` folder (e.g. `C:\msys64\mingw64\bin`) to your `PATH` so `g++` and `openssl` are found from any terminal

**Linux (Debian/Ubuntu)**
```bash
sudo apt update
sudo apt install -y build-essential libssl-dev nodejs npm
```
(Fedora: `sudo dnf install gcc-c++ openssl-devel nodejs npm` · Arch: `sudo pacman -S base-devel openssl nodejs npm`)

**macOS**
```bash
xcode-select --install        # C++ compiler (clang, invoked as g++)
brew install openssl@3 node
```

---

### 2. Generate a local TLS certificate

Run this once, from inside `backend/` (the `core` binary looks for `cert.pem`/`key.pem` in its current working directory at runtime):

```bash
cd backend
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
```

---

### 3. Compile the C++ core

Still inside `backend/`:

**Linux**
```bash
g++ -std=c++17 core.cpp net_platform_posix.cpp sha256.cpp -o core -lssl -lcrypto -lpthread
g++ -std=c++17 sender.cpp net_platform_posix.cpp sha256.cpp -o sender -lssl -lcrypto -lpthread
```

**macOS** (Homebrew's OpenSSL isn't on the default search path — you must point the compiler at it explicitly)
```bash
OPENSSL_PREFIX="$(brew --prefix openssl@3)"
g++ -std=c++17 -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" core.cpp net_platform_posix.cpp sha256.cpp -o core -lssl -lcrypto -lpthread
g++ -std=c++17 -I"$OPENSSL_PREFIX/include" -L"$OPENSSL_PREFIX/lib" sender.cpp net_platform_posix.cpp sha256.cpp -o sender -lssl -lcrypto -lpthread
```

**Windows** (from an MSYS2 MinGW64 shell)
```bash
g++ -std=c++17 core.cpp net_platform_win.cpp sha256.cpp -o core.exe -lssl -lcrypto -lws2_32
g++ -std=c++17 sender.cpp net_platform_win.cpp sha256.cpp -o sender.exe -lssl -lcrypto -lws2_32
```

---

### 4. Install Node dependencies and start the backend

```bash
# from backend/
npm install
node index.js
```

### 5. Install and start the frontend

In a second terminal:
```bash
cd frontend
npm install
npm run dev
```

Open the URL npm prints (typically `http://localhost:5173`).

---

## Setup Troubleshooting

*(Add these alongside the existing runtime troubleshooting entries — these are specifically first-time-setup issues.)*

### `g++: command not found` / `'g++' is not recognized`
The C++ compiler isn't installed or isn't on your `PATH`.
- **Windows**: confirm MSYS2's `mingw64\bin` is in `PATH`, and that you're running the command from an **MSYS2 MinGW64 shell**, not plain PowerShell or CMD — a regular Windows terminal won't have `g++` even after installing MSYS2 unless you add it to `PATH` yourself.
- **Linux**: `sudo apt install build-essential` (or your distro's equivalent).
- **macOS**: `xcode-select --install`.

### `fatal error: openssl/ssl.h: No such file or directory`
OpenSSL's headers aren't installed or aren't being found.
- **Linux**: `sudo apt install libssl-dev` (Fedora: `openssl-devel`, Arch: `openssl`).
- **macOS**: install via `brew install openssl@3`, then make sure you're passing `-I"$(brew --prefix openssl@3)/include"` — Homebrew deliberately does not put this on the default compiler path.
- **Windows (MSYS2)**: `pacman -S mingw-w64-x86_64-openssl`.

### `undefined reference to 'SSL_CTX_new'` (or similar linker errors)
The compiler found the headers but not the library, or `-lssl -lcrypto` was left off the compile command, or the flags are in the wrong order. Library flags (`-lssl -lcrypto`) must come **after** the source files on the command line — putting them first silently breaks linking on some GCC configurations.

### `Failed to initialize TLS Context with cert.pem/key.pem`
No certificate exists yet, or `core`/`sender` is being run from the wrong directory. The binaries look for `cert.pem` and `key.pem` in the **current working directory at launch**, not next to the executable. Run the `openssl req` command from Step 2 inside `backend/`, and always launch `core`/`sender` from `backend/` as well.

### `error: 'TCP_NODELAY' was not declared in this scope` (Linux, only if editing `net_platform_posix.cpp`)
`TCP_NODELAY` lives in `<netinet/tcp.h>`, which the other socket headers don't pull in automatically. Add `#include <netinet/tcp.h>`.

### `npm: command not found` / `npm install` fails immediately
Node.js wasn't installed, or was installed without npm. Reinstall from [nodejs.org](https://nodejs.org) (Windows/macOS) or your package manager (Linux), and confirm with `node -v && npm -v` before retrying.

### Windows: `start.bat`/`start.ps1` closes immediately with no visible error
Run it from an already-open terminal (`cmd.exe` or PowerShell) instead of double-clicking the file — double-clicking closes the window before you can read the error. From PowerShell, if the script is blocked from running:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\start.ps1
```

### `bind: Address already in use` on first-ever startup
Rare on a truly fresh setup, but happens if a previous crashed run (or another app) is holding port `8080` or `8888`.
```bash
# Linux/macOS
lsof -i :8080
pkill -f "./core"

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 8080 | Select-Object OwningProcess
Stop-Process -Id <PID>
```

### Two peers can't discover each other even after a clean setup
This is a network issue, not a setup issue — see the existing "Two peers on the same WiFi don't discover each other" entry below (IGMP snooping on the router/AP can block UDP multicast between devices even when normal traffic works).