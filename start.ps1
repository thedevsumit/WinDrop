# start.ps1 - Windows equivalent of start.sh
# Run from PowerShell: .\start.ps1
# (Or just double-click start.bat, which launches this for you.)

$ErrorActionPreference = "Stop"

Write-Host "Building WinDrop..."

function Test-CommandExists {
    param($Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

# --- Dependency checks ---
$missing = $false

if (-not (Test-CommandExists "g++")) {
    Write-Host "Missing: g++ (a C++ compiler)"
    $missing = $true
}
if (-not (Test-CommandExists "node")) {
    Write-Host "Missing: node (Node.js runtime)"
    $missing = $true
}

if ($missing) {
    Write-Host ""
    Write-Host "Install the missing tools, then re-run this script:"
    Write-Host "  - Node.js: https://nodejs.org"
    Write-Host "  - C++ compiler + OpenSSL: install MSYS2 from https://www.msys2.org,"
    Write-Host "    then from the 'MSYS2 MinGW64' terminal (NOT the default MSYS2 terminal) run:"
    Write-Host "      pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-openssl"
    Write-Host "    Then add C:\msys64\mingw64\bin to your PATH (System Properties >"
    Write-Host "    Environment Variables) so g++ is found from a normal PowerShell/cmd window."
    exit 1
}

# --- Locate OpenSSL headers/libs ---
# A plain/standalone MinGW install does NOT include OpenSSL dev files -- this
# is the single most common Windows setup blocker for this project. We look
# for the MSYS2 mingw64 OpenSSL package first (this is exactly what the
# project's own CI uses), then a couple of other common install locations.
$opensslCandidates = @(
    "C:\msys64\mingw64",
    "C:\tools\msys64\mingw64",
    "C:\OpenSSL-Win64"
)

$opensslPrefix = $null
foreach ($candidate in $opensslCandidates) {
    if (Test-Path "$candidate\include\openssl\ssl.h") {
        $opensslPrefix = $candidate
        break
    }
}

if (-not $opensslPrefix) {
    Write-Host ""
    Write-Host "Could not find OpenSSL development headers."
    Write-Host "g++ was found, but this project also needs OpenSSL's headers and"
    Write-Host "libraries to compile (for TLS), and a standalone MinGW install"
    Write-Host "does not include them."
    Write-Host ""
    Write-Host "Fix: install MSYS2 (https://www.msys2.org), then from the"
    Write-Host "'MSYS2 MinGW64' terminal run:"
    Write-Host "  pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-openssl"
    Write-Host "Then re-run this script from a shell where C:\msys64\mingw64\bin is on PATH."
    Write-Host ""
    Write-Host "If OpenSSL is installed somewhere else, edit the `$opensslCandidates"
    Write-Host "list near the top of this script to add that path."
    exit 1
}

Write-Host "Using OpenSSL from: $opensslPrefix"

# --- Backend: cert generation + compile ---
Push-Location backend

if (-not (Test-Path "cert.pem") -or -not (Test-Path "key.pem")) {
    Write-Host "Generating self-signed TLS certificate for local LAN use..."
    if (Test-CommandExists "openssl") {
        & openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
    } else {
        # Some MinGW/OpenSSL installs don't put openssl.exe on PATH even
        # though the library and headers are present. Fall back to the copy
        # that ships alongside the MSYS2 OpenSSL package.
        & "$opensslPrefix\bin\openssl.exe" req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=windrop-lan"
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Certificate generation failed. Is openssl.exe on PATH or in $opensslPrefix\bin?"
        Pop-Location
        exit 1
    }
}

Write-Host "Compiling C++ engines..."
$includeFlag = "-I$opensslPrefix\include"
$libFlag = "-L$opensslPrefix\lib"

& g++ -pthread -std=c++17 core.cpp sha256.cpp net_platform_win.cpp $includeFlag $libFlag -o core.exe -lws2_32 -liphlpapi -lssl -lcrypto -lcrypt32
if ($LASTEXITCODE -ne 0) {
    Write-Host "Compilation of core.exe failed"
    Pop-Location
    exit 1
}

& g++ -std=c++17 sender.cpp sha256.cpp net_platform_win.cpp $includeFlag $libFlag -o sender.exe -lws2_32 -liphlpapi -lssl -lcrypto -lcrypt32
if ($LASTEXITCODE -ne 0) {
    Write-Host "Compilation of sender.exe failed"
    Pop-Location
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing backend modules..."
    cmd.exe /c "npm install"
}

Write-Host "Starting Node backend..."
$nodeProcess = Start-Process -FilePath "node" -ArgumentList "index.js" -PassThru -NoNewWindow -WorkingDirectory (Get-Location)

Pop-Location

# --- Frontend ---
Push-Location frontend

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing frontend modules..."
    cmd.exe /c "npm install"
}

Write-Host "Starting React frontend..."
$env:BROWSER = "none"
# npm on Windows is npm.cmd, not a directly-executable file -- Start-Process
# can fail to resolve it directly, so this goes through cmd.exe /c instead,
# which reliably handles .cmd resolution the way a normal shell would.
$frontendProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -PassThru -NoNewWindow -WorkingDirectory (Get-Location)

Pop-Location

Write-Host ""
Write-Host "WinDrop is live! Press Ctrl+C to safely shut everything down."
Write-Host ""

try {
    while ($true) {
        Start-Sleep -Seconds 1
        if ($nodeProcess.HasExited) {
            Write-Host "Backend process exited unexpectedly."
            break
        }
        if ($frontendProcess.HasExited) {
            Write-Host "Frontend process exited unexpectedly."
            break
        }
    }
}
finally {
    Write-Host ""
    Write-Host "Shutting down WinDrop..."
    Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontendProcess.Id -Force -ErrorAction SilentlyContinue
    Get-Process core -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process sender -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "Shutdown complete."
}