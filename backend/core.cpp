#include <iostream>
#include <fstream>
#include <thread>
#include <chrono>
#include <cstring>
#include <map>
#include <set>
#include <mutex>
#include <condition_variable>
#include <sstream>
#include <vector>
#include <random>
#include <filesystem>
#include "sha256.h"
#include "net_platform.h"
#include "metadata.h"
#include "path_utils.h"
using namespace std;

const int CHUNK_SIZE = 262144; // 256 KB read/recv buffer per call
const size_t FLUSH_THRESHOLD = 1 << 20;
SSL_CTX *g_server_tls_ctx = nullptr;
struct RequestState
{
    int socket;
    string id;
    string filename;
    string sender;
    long long size;
    bool decision_made = false;
    bool accepted = false;
    condition_variable cv;
    mutex mtx;

    // Folder-transfer fields — unused (default) for a plain single-file REQUEST.
    bool isFolder = false;
    string folderName;
    int fileCount = 0;
    vector<pair<string, long long>> manifest;
};

map<string, shared_ptr<RequestState>> pending_requests;
mutex requests_mutex;

// --- GAP 4: Single-Writer Guard Globals ---
set<string> active_writes;
mutex writes_mutex;

// Only for scripted benchmarking (--benchmark-auto-accept) -- bypasses the
// interactive accept/reject prompt so automated multi-run tests don't need
// a human clicking Accept each time. Never set true in normal usage.
bool g_benchmarkAutoAccept = false;
// ------------------------------------------

// Shared session ID: generated once in main() before threads start,
// then read (never written) by both the broadcaster and listener threads.
// Write-once-then-read-only means no mutex is needed around it.
string my_session_id;

string getLocalIP()
{
    return Net::getLocalIP();
}

void run_udp_broadcaster()
{
    socket_t sock = Net::createSocket(SOCK_DGRAM);
    Net::enableBroadcast(sock);
    struct sockaddr_in broadcast_addr;
    broadcast_addr.sin_family = AF_INET;
    broadcast_addr.sin_port = htons(8888);
    broadcast_addr.sin_addr.s_addr = inet_addr("239.255.255.250");

    string ip = getLocalIP();
    Net::setMulticastInterface(sock, ip.c_str());

    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0)
        strcpy(hostname, "Unknown_Peer");
    string name(hostname);

    string message = name + ":" + ip + ":" + my_session_id + " Alive";

    while (true)
    {
        int result = Net::sendTo(sock, message.c_str(), message.length(), &broadcast_addr);
        if (result < 0)
        {
            cerr << "[broadcaster] sendTo failed" << endl;
        }
        std::this_thread::sleep_for(std::chrono::seconds(2));
    }
    Net::closeSocket(sock);
}

void run_udp_listener()
{
    socket_t sock = Net::createSocket(SOCK_DGRAM);
    Net::setReuseAddr(sock);
    struct sockaddr_in listen_addr;
    listen_addr.sin_family = AF_INET;
    listen_addr.sin_port = htons(8888);
    listen_addr.sin_addr.s_addr = htonl(INADDR_ANY);

    if (::bind(sock, (struct sockaddr *)&listen_addr, sizeof(listen_addr)) < 0)
    {
        cerr << "[listener] bind failed — port 8888 may be in use" << endl;
    }

    Net::joinMulticastGroup(sock, "239.255.255.250");
    // TODO: joinMulticastGroup currently returns void; consider changing it to
    // return int so a failed join can be logged here too.

    char buffer[65536];
    while (true)
    {
        memset(buffer, 0, 65536);
        int bytes = Net::recvData(sock, buffer, sizeof(buffer) - 1);
        if (bytes <= 0)
            continue;
        string received_msg(buffer, bytes);
        if (received_msg.find(my_session_id) == string::npos)
        {
            cout << "Founded Peer: " << buffer << "\n";
        }
    }
    Net::closeSocket(sock);
}

void run_stdin_listener()
{
    string line;
    while (getline(cin, line))
    {
        if (line.empty())
            continue;
        size_t colon_pos = line.find(':');
        if (colon_pos == string::npos)
            continue;
        string command = line.substr(0, colon_pos);
        string id = line.substr(colon_pos + 1);
        if (!id.empty() && id.back() == '\r')
            id.pop_back();
        if (!id.empty() && id.back() == '\n')
            id.pop_back();

        lock_guard lock(requests_mutex);
        if (pending_requests.count(id))
        {
            auto state = pending_requests[id];
            {
                lock_guard state_lock(state->mtx);
                state->decision_made = true;
                state->accepted = (command == "REQUEST_ACCEPT" || command == "FOLDER_ACCEPT");
            }
            state->cv.notify_one();
        }
    }
}

// Handles one "RESUME_QUERY:id|filename|size|firstChunkHash" message and
// sends the appropriate RESUME_RESPONSE. Used both for a standalone
// single-file transfer and, unchanged, for each file inside a folder
// transfer's per-file loop.
void handleResumeQuery(SSL *ssl, const string &raw_data)
{
    string payload = raw_data.substr(13);
    size_t pos1 = payload.find('|');
    size_t pos2 = (pos1 != string::npos) ? payload.find('|', pos1 + 1) : string::npos;
    size_t pos3 = (pos2 != string::npos) ? payload.find('|', pos2 + 1) : string::npos;
    if (pos1 == string::npos || pos2 == string::npos || pos3 == string::npos)
        return;

    string resumeId = payload.substr(0, pos1);
    string filename = WinDrop::sanitizeRelativePath(payload.substr(pos1 + 1, pos2 - pos1 - 1));
    long long size = stoll(payload.substr(pos2 + 1, pos3 - pos2 - 1));
    string senderPrefixHash = payload.substr(pos3 + 1);
    while (!senderPrefixHash.empty() && (senderPrefixHash.back() == '\n' || senderPrefixHash.back() == '\r'))
        senderPrefixHash.pop_back();

    long long metaSize;
    int lastChunk = WinDrop::read_metadata(filename, metaSize);
    string part_filename = filename + ".part";

    if (lastChunk != -1 && metaSize == size)
    {
        bool safeToResume = false;
        if (lastChunk >= 1)
        {
            string localPrefixHash = WinDrop::computeSHA256Prefix(part_filename, CHUNK_SIZE);
            safeToResume = (localPrefixHash == senderPrefixHash);
        }

        if (safeToResume)
        {
            string resp = "RESUME_RESPONSE:OK|" + to_string(lastChunk) + "\n";
            Net::sendData(ssl, resp.c_str(), resp.length());
        }
        else
        {
            cout << "ERROR:RESUME_STATE_INVALID|" << resumeId << endl;
            remove(part_filename.c_str());
            remove((filename + ".part.meta").c_str());
            string resp = "RESUME_RESPONSE:NO\n";
            Net::sendData(ssl, resp.c_str(), resp.length());
        }
    }
    else if (lastChunk != -1 && metaSize != size)
    {
        cout << "ERROR:RESUME_STATE_INVALID|" << resumeId << endl;
        string resp = "RESUME_RESPONSE:NO\n";
        Net::sendData(ssl, resp.c_str(), resp.length());
    }
    else
    {
        string resp = "RESUME_RESPONSE:NO\n";
        Net::sendData(ssl, resp.c_str(), resp.length());
    }
}

// Handles one "REQUEST:id|filename|size|sender" message end-to-end: the
// accept/reject wait, single-writer guard, subdirectory creation, streaming
// receive, and checksum-verified finalization. Does NOT close the TLS
// connection — that's the caller's decision, since this is now reused both
// for a standalone single-file transfer (caller closes right after) and for
// each file inside a folder transfer's loop (caller keeps the connection
// open for the next file).
//
// Returns false only when the underlying connection appears to have died
// (a recvData() call failed) — true otherwise, including ordinary rejection
// outcomes like FILE_BUSY or CHECKSUM_MISMATCH, since those still complete
// a valid request/response exchange and leave the connection usable.
bool handleFileRequest(SSL *ssl, socket_t sock, const string &raw_data, char *buffer, size_t bufferSize)
{
    string payload = raw_data.substr(8);
    size_t pos = 0;
    vector<string> parts;
    while ((pos = payload.find('|')) != string::npos)
    {
        parts.push_back(payload.substr(0, pos));
        payload.erase(0, pos + 1);
    }
    parts.push_back(payload);

    if (parts.size() < 4)
        return false;

    string id = parts[0];
    string filename = WinDrop::sanitizeRelativePath(parts[1]);
    string size_str = parts[2];
    string sender = parts[3];
    if (!sender.empty() && sender.back() == '\n')
        sender.pop_back();
    if (!sender.empty() && sender.back() == '\r')
        sender.pop_back();

    cout << "INCOMING_REQUEST:" << id << "|" << filename << "|" << size_str << "|" << sender << endl;

    auto state = make_shared<RequestState>();
    state->socket = (int)sock;
    state->id = id;
    state->filename = filename;
    state->sender = sender;
    try
    {
        state->size = stoll(size_str);
    }
    catch (...)
    {
        state->size = 0;
    }

    {
        lock_guard lock(requests_mutex);
        pending_requests[id] = state;
    }

    unique_lock state_lock(state->mtx);
    if (g_benchmarkAutoAccept)
    {
        state->decision_made = true;
        state->accepted = true;
        cout << "AUTO-ACCEPTED (benchmark mode): " << id << endl;
    }
    else
    {
        state->cv.wait(state_lock, [&]
                       { return state->decision_made; });
    }

    bool connectionAlive = true;

    if (state->accepted)
    {
        // --- GAP 4: Single-Writer Guard Check ---
        {
            lock_guard write_lock(writes_mutex);
            if (active_writes.count(filename))
            {
                Net::sendData(ssl, "ERROR:FILE_BUSY\n", 16);
                cout << "ERROR:FILE_BUSY|" << id << endl;
                lock_guard req_lock(requests_mutex);
                pending_requests.erase(id);
                return true; // connection is fine, just this file was rejected
            }
            active_writes.insert(filename);
        }
        // ----------------------------------------

        string resp = "REQUEST_ACCEPT:" + id + "\n";
        Net::sendData(ssl, resp.c_str(), resp.length());

        long long total_size = state->size;
        int chunks_received = 0;
        string part_filename = filename + ".part";

        long long metaSize;
        int lastChunk = WinDrop::read_metadata(filename, metaSize);
        if (lastChunk != -1 && metaSize == total_size)
        {
            chunks_received = lastChunk;
            cout << "🔄 Resuming transfer from chunk " << chunks_received << endl;
        }

        memset(buffer, 0, bufferSize);

        // If filename carries subdirectory structure (a folder-transfer
        // entry like "photos/vacation/img1.jpg"), make sure those
        // directories exist before trying to open the file. Harmless
        // no-op for a plain basename with no parent path.
        std::filesystem::path outPath(part_filename);
        if (outPath.has_parent_path())
        {
            std::error_code dirErr;
            std::filesystem::create_directories(outPath.parent_path(), dirErr);
            if (dirErr)
            {
                cout << "ERROR:PERMISSION_DENIED|" << id << endl;
                string err = "ERROR:PERMISSION_DENIED\n";
                Net::sendData(ssl, err.c_str(), err.length());
                {
                    lock_guard write_lock(writes_mutex);
                    active_writes.erase(filename);
                }
                {
                    lock_guard req_lock(requests_mutex);
                    pending_requests.erase(id);
                }
                return true;
            }
        }

        ofstream outfile(part_filename, ios::binary | ios::app);
        if (!outfile)
        {
            cout << "ERROR:PERMISSION_DENIED|" << id << endl;
            string err = "ERROR:PERMISSION_DENIED\n";
            Net::sendData(ssl, err.c_str(), err.length());

            // --- GAP 4: Erase from both maps on early return (Leak Fix) ---
            {
                lock_guard write_lock(writes_mutex);
                active_writes.erase(filename);
            }
            {
                lock_guard req_lock(requests_mutex);
                pending_requests.erase(id);
            }
            // --------------------------------------------------------------
            return true;
        }

        vector<char> write_buffer;
        // --- GAP 1: Track clean protocol exits ---
        bool transfer_completed = false;
        long long bytes_received_total = (long long)chunks_received * CHUNK_SIZE;
        auto lastReport = std::chrono::steady_clock::now();

        while (bytes_received_total < total_size)
        {
            long long remaining = total_size - bytes_received_total;
            size_t to_read = (size_t)std::min((long long)bufferSize, remaining);
            int bytes_read = Net::recvData(ssl, buffer, to_read);

            if (bytes_read <= 0)
            {
                connectionAlive = false;
                break; // disconnect — transfer_completed stays false
            }

            write_buffer.insert(write_buffer.end(), buffer, buffer + bytes_read);
            bytes_received_total += bytes_read;
            chunks_received = (int)(bytes_received_total / CHUNK_SIZE);

            if (write_buffer.size() >= FLUSH_THRESHOLD || bytes_received_total == total_size)
            {
                outfile.write(write_buffer.data(), write_buffer.size());
                WinDrop::save_metadata(filename, total_size, CHUNK_SIZE, chunks_received);
                write_buffer.clear();
            }

            // Progress sampling
            auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::milliseconds>(now - lastReport).count() >= 150)
            {
                cout << "TRANSFER_PROGRESS:" << id << "|" << chunks_received << "|" << (total_size + CHUNK_SIZE - 1) / CHUNK_SIZE << endl;
                lastReport = now;
            }
        }

        // Loop exits exactly when all file bytes are in — now safely read the control message
        if (bytes_received_total == total_size)
        {
            outfile.close();
            char completeBuf[128];
            memset(completeBuf, 0, sizeof(completeBuf));
            int n = Net::recvData(ssl, completeBuf, sizeof(completeBuf) - 1);
            if (n <= 0)
            {
                connectionAlive = false;
            }
            string complete_msg(completeBuf, n > 0 ? n : 0);

            if (complete_msg.find("COMPLETE:") == 0)
            {
                string sender_checksum = complete_msg.substr(9);
                if (!sender_checksum.empty() && sender_checksum.back() == '\n')
                    sender_checksum.pop_back();
                if (!sender_checksum.empty() && sender_checksum.back() == '\r')
                    sender_checksum.pop_back();

                string local_checksum = WinDrop::computeSHA256(part_filename);
                if (local_checksum == sender_checksum)
                {
                    if (rename(part_filename.c_str(), filename.c_str()) == 0)
                    {
                        cout << "✅ File Verified and Saved: " << filename << endl;
                        string meta_file = filename + ".part.meta";
                        remove(meta_file.c_str());
                        Net::sendData(ssl, "DELIVERED_ACK\n", 14);

                        // --- GAP 3: Signal final success to Node.js ---
                        cout << "RECEIVED_OK|" << id << endl;
                    }
                    else
                    {
                        cout << "ERROR:DISK_FULL|" << id << endl;
                        Net::sendData(ssl, "ERROR:DISK_FULL\n", 16);
                    }
                }
                else
                {
                    cout << "❌ Checksum Mismatch! Sender: " << sender_checksum << " Local: " << local_checksum << endl;
                    cout << "ERROR:CHECKSUM_MISMATCH|" << id << endl;
                    Net::sendData(ssl, "ERROR:CHECKSUM_MISMATCH\n", 24);
                }
                transfer_completed = true;
            }
        }
        else
        {
            if (outfile.is_open())
                outfile.close();
        }

        // --- GAP 1: Detect sudden network drops ---
        if (!transfer_completed)
        {
            cout << "ERROR:PEER_DISCONNECTED|" << id << endl;
        }

        // --- GAP 4: Release the filename lock ---
        {
            lock_guard write_lock(writes_mutex);
            active_writes.erase(filename);
        }
        // ----------------------------------------
    }
    else
    {
        string resp = "REQUEST_REJECT:" + id + "\n";
        Net::sendData(ssl, resp.c_str(), resp.length());
        cout << "ERROR:TRANSFER_REJECTED|" << id << endl;
    }

    {
        lock_guard lock(requests_mutex);
        pending_requests.erase(id);
    }

    return connectionAlive;
}

void handle_client(int new_socket)
{
    socket_t sock = (socket_t)new_socket;
    Net::setNoDelay(sock);
    Net::setSocketBufferSize(sock, 1 << 20);
    Net::setRecvTimeout(sock, 60);
    SSL *ssl = Net::tlsAccept(sock, g_server_tls_ctx);
    if (!ssl)
    {
        Net::closeTLS(ssl, sock);
        return;
    }
    char buffer[CHUNK_SIZE];
    memset(buffer, 0, CHUNK_SIZE);
    int bytes_read = Net::recvData(ssl, buffer, sizeof(buffer) - 1);
    if (bytes_read <= 0)
    {
        Net::closeTLS(ssl, sock);
        return;
    }

    string raw_data(buffer, bytes_read);

    // Handle Resume Query (standalone single-file case)
    if (raw_data.find("RESUME_QUERY:") == 0)
    {
        handleResumeQuery(ssl, raw_data);

        memset(buffer, 0, CHUNK_SIZE);
        bytes_read = Net::recvData(ssl, buffer, sizeof(buffer) - 1);
        if (bytes_read <= 0)
        {
            Net::closeTLS(ssl, sock);
            return;
        }
        raw_data = string(buffer, bytes_read);
    }

    if (raw_data.find("FOLDER_REQUEST:") == 0)
    {
        string payload = raw_data.substr(15);
        vector<string> parts;
        size_t pos = 0;
        while ((pos = payload.find('|')) != string::npos)
        {
            parts.push_back(payload.substr(0, pos));
            payload.erase(0, pos + 1);
        }
        parts.push_back(payload);

        if (parts.size() < 5)
        {
            Net::closeTLS(ssl, sock);
            return;
        }

        string id = parts[0];
        string folderName = WinDrop::sanitizeFilename(parts[1]); // basename-only is correct here, this is a display name, not a path
        int fileCount = 0;
        try { fileCount = stoi(parts[2]); } catch (...) { fileCount = 0; }
        string totalSizeStr = parts[3];
        string sender = parts[4];
        while (!sender.empty() && (sender.back() == '\n' || sender.back() == '\r'))
            sender.pop_back();

        // The manifest is sent as a second message, same pattern RESUME_QUERY
        // uses for its follow-up REQUEST — read it now, before deciding
        // anything about this folder request.
        memset(buffer, 0, CHUNK_SIZE);
        bytes_read = Net::recvData(ssl, buffer, sizeof(buffer) - 1);
        if (bytes_read <= 0)
        {
            Net::closeTLS(ssl, sock);
            return;
        }
        string manifestMsg(buffer, bytes_read);

        auto state = make_shared<RequestState>();
        state->socket = (int)sock;
        state->id = id;
        state->isFolder = true;
        state->folderName = folderName;
        state->fileCount = fileCount;
        state->sender = sender;
        try { state->size = stoll(totalSizeStr); } catch (...) { state->size = 0; }

        if (manifestMsg.find("FILE_MANIFEST:") == 0)
        {
            string entries = manifestMsg.substr(14);
            while (!entries.empty() && (entries.back() == '\n' || entries.back() == '\r'))
                entries.pop_back();

            size_t epos = 0;
            while ((epos = entries.find(';')) != string::npos)
            {
                string entry = entries.substr(0, epos);
                entries.erase(0, epos + 1);
                size_t sepPos = entry.find('|');
                if (sepPos != string::npos)
                {
                    string relPath = WinDrop::sanitizeRelativePath(entry.substr(0, sepPos));
                    long long fSize = 0;
                    try { fSize = stoll(entry.substr(sepPos + 1)); } catch (...) { fSize = 0; }
                    state->manifest.push_back({relPath, fSize});
                }
            }
            // Handle the final entry (no trailing semicolon)
            if (!entries.empty())
            {
                size_t sepPos = entries.find('|');
                if (sepPos != string::npos)
                {
                    string relPath = WinDrop::sanitizeRelativePath(entries.substr(0, sepPos));
                    long long fSize = 0;
                    try { fSize = stoll(entries.substr(sepPos + 1)); } catch (...) { fSize = 0; }
                    state->manifest.push_back({relPath, fSize});
                }
            }
        }

        cout << "INCOMING_FOLDER_REQUEST:" << id << "|" << folderName << "|"
             << fileCount << "|" << totalSizeStr << "|" << sender
             << "|filesParsed=" << state->manifest.size() << endl;

        {
            lock_guard lock(requests_mutex);
            pending_requests[id] = state;
        }

        unique_lock state_lock(state->mtx);
        if (g_benchmarkAutoAccept)
        {
            state->decision_made = true;
            state->accepted = true;
            cout << "AUTO-ACCEPTED (benchmark mode): " << id << endl;
        }
        else
        {
            state->cv.wait(state_lock, [&] { return state->decision_made; });
        }

        if (state->accepted)
        {
            string resp = "FOLDER_ACCEPT:" + id + "\n";
            Net::sendData(ssl, resp.c_str(), resp.length());
            cout << "FOLDER_ACCEPTED:" << id << "|filesToReceive=" << state->manifest.size() << endl;

            // Receive each file in the manifest sequentially, over this same
            // connection, reusing the exact single-file REQUEST/RESUME_QUERY
            // logic via the extracted helpers above.
            size_t filesReceived = 0;
            for (size_t i = 0; i < state->manifest.size(); i++)
            {
                memset(buffer, 0, CHUNK_SIZE);
                int nbytes = Net::recvData(ssl, buffer, CHUNK_SIZE - 1);
                if (nbytes <= 0)
                    break; // peer disconnected mid-folder

                string fileMsg(buffer, nbytes);

                if (fileMsg.find("RESUME_QUERY:") == 0)
                {
                    handleResumeQuery(ssl, fileMsg);
                    memset(buffer, 0, CHUNK_SIZE);
                    nbytes = Net::recvData(ssl, buffer, CHUNK_SIZE - 1);
                    if (nbytes <= 0)
                        break;
                    fileMsg = string(buffer, nbytes);
                }

                if (fileMsg.find("REQUEST:") == 0)
                {
                    bool connectionAlive = handleFileRequest(ssl, sock, fileMsg, buffer, CHUNK_SIZE);
                    filesReceived++;
                    if (!connectionAlive)
                        break;
                }
                else
                {
                    break; // unexpected message — stop the folder loop
                }
            }

            cout << "FOLDER_TRANSFER_COMPLETE:" << id << "|received=" << filesReceived
                 << "|total=" << state->manifest.size() << endl;
        }
        else
        {
            string resp = "FOLDER_REJECT:" + id + "\n";
            Net::sendData(ssl, resp.c_str(), resp.length());
            cout << "ERROR:TRANSFER_REJECTED|" << id << endl;
        }

        {
            lock_guard lock(requests_mutex);
            pending_requests.erase(id);
        }
        Net::closeTLS(ssl, sock);
        return;
    }

    if (raw_data.find("REQUEST:") == 0)
    {
        handleFileRequest(ssl, sock, raw_data, buffer, CHUNK_SIZE);
        Net::closeTLS(ssl, sock);
    }
    else
    {
        Net::closeTLS(ssl, sock);
    }
}

void run_tcp_server()
{
    socket_t server_fd = Net::createSocket(SOCK_STREAM);
    Net::setReuseAddr(server_fd);
    struct sockaddr_in address;
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(8080);
    ::bind(server_fd, (struct sockaddr *)&address, sizeof(address));
    listen(server_fd, 5);
    while (true)
    {
        int addrlen = sizeof(address);
        int new_socket = accept(server_fd, (struct sockaddr *)&address, (socklen_t *)&addrlen);
        thread(handle_client, new_socket).detach();
    }
    Net::closeSocket(server_fd);
}

int main(int argc, char *argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        if (string(argv[i]) == "--benchmark-auto-accept")
        {
            g_benchmarkAutoAccept = true;
            cout << "⚠️  Benchmark mode: auto-accepting all incoming transfers. Do not use outside of controlled testing." << endl;
        }
    }

    Net::init();
    setvbuf(stdout, NULL, _IONBF, 0);
    g_server_tls_ctx = Net::createServerTLSContext("cert.pem", "key.pem");
    if (!g_server_tls_ctx)
    {
        cerr << "Failed to initialize TLS Context with cert.pem/key.pem" << endl;
        return 1;
    }
    // Generate the session ID once, before any thread starts, so both the
    // broadcaster and listener see the same value with no race condition.
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dist(100000, 999999);
    my_session_id = to_string(dist(gen));

    cout << "LIGHTHOUSE CORE ENGINE STARTED\n";
    thread mouth(run_udp_broadcaster);
    thread ear(run_udp_listener);
    thread hands(run_tcp_server);
    thread brain(run_stdin_listener);
    mouth.join();
    ear.join();
    hands.join();
    brain.join();
    Net::cleanup();
    return 0;
}