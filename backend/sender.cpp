#include <iostream>
#include <fstream>
#include <cstring>
#include <random>
#include <algorithm>
#include <vector>
#include <chrono>
#include <filesystem>
#include "trust_store.h"
#include "sha256.h"
#include "net_platform.h"

namespace fs = std::filesystem;
using namespace std;

const int CHUNK_SIZE = 262144;

long long getFileSize(const string &filePath)
{
    ifstream in(filePath, ios::binary | ios::ate);
    return in.tellg();
}

// Walks folderPath recursively and returns {relativePath, sizeInBytes} for
// every regular file found. Paths are normalized to forward slashes so the
// wire format is identical regardless of which OS the sender runs on.
vector<pair<string, long long>> buildManifest(const string &folderPath)
{
    vector<pair<string, long long>> manifest;
    for (const auto &entry : fs::recursive_directory_iterator(folderPath))
    {
        if (entry.is_regular_file())
        {
            string relPath = fs::relative(entry.path(), folderPath).string();
            for (auto &c : relPath) if (c == '\\') c = '/';
            manifest.push_back({relPath, (long long)fs::file_size(entry.path())});
        }
    }
    return manifest;
}

// Sends exactly one file end-to-end: RESUME_QUERY, REQUEST handshake,
// streaming send, COMPLETE + checksum confirmation. Does NOT close the TLS
// connection or free the context — that's the caller's responsibility,
// since this is reused both for a standalone single-file transfer (caller
// closes right after) and for each file inside a folder transfer's loop
// (caller keeps the connection open for the next file).
//
// localFilePath is where to actually read bytes from on disk.
// wireFilename is what gets sent in the protocol (a bare basename for a
// standalone transfer, or a relative path like "photos/img1.jpg" for a
// folder-transfer entry).
//
// Returns false only when the underlying connection appears to have died
// (a send/recv call failed) — true otherwise, including ordinary rejection
// outcomes like FILE_BUSY or CHECKSUM_MISMATCH, since those still complete
// a valid request/response exchange and leave the connection usable for
// the next file in a folder loop.
bool sendOneFile(SSL *ssl, const string &localFilePath, const string &wireFilename,
                  const string &requestId, const string &senderName)
{
    long long fileSize = getFileSize(localFilePath);

    string prefixHash = WinDrop::computeSHA256Prefix(localFilePath, CHUNK_SIZE);
    string resume_query =
        "RESUME_QUERY:" + requestId + "|" +
        wireFilename + "|" +
        to_string(fileSize) + "|" +
        prefixHash + "\n";

    if (Net::sendData(ssl, resume_query.c_str(), resume_query.length()) <= 0)
        return false;

    char buffer[65536];
    memset(buffer, 0, sizeof(buffer));
    int bytes_received = Net::recvData(ssl, buffer, sizeof(buffer) - 1);
    if (bytes_received <= 0)
    {
        cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
        return false;
    }

    int lastChunk = 0;
    {
        string response(buffer, bytes_received);
        if (response.find("RESUME_RESPONSE:OK|") == 0)
        {
            string chunk_str = response.substr(19);
            try
            {
                lastChunk = stoi(chunk_str);
                cout << "🔄 Resuming transfer from chunk " << lastChunk << endl;
            }
            catch (...)
            {
                cout << "⚠️ Malformed resume response, starting from scratch." << endl;
                lastChunk = 0;
            }
        }
        else
        {
            cout << "🆕 Starting new transfer." << endl;
        }
    }

    string request =
        "REQUEST:" + requestId + "|" +
        wireFilename + "|" +
        to_string(fileSize) + "|" +
        senderName + "\n";

    if (Net::sendData(ssl, request.c_str(), request.length()) <= 0)
        return false;

    cout << "📡 Handshake request sent (" << requestId
         << "). Waiting for acceptance..." << endl;

    memset(buffer, 0, sizeof(buffer));
    bytes_received = Net::recvData(ssl, buffer, sizeof(buffer) - 1);
    if (bytes_received <= 0)
    {
        cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
        return false;
    }

    string response(buffer, bytes_received);
    bool connectionAlive = true;

    if (response.find("REQUEST_ACCEPT:" + requestId) == 0)
    {
        cout << "✅ Transfer accepted! Starting stream..." << endl;

        ifstream infile(localFilePath, ios::binary);
        if (!infile.is_open())
        {
            cout << "ERROR:PERMISSION_DENIED|" << requestId << endl;
            return true; // connection itself is still fine, just this file failed to open
        }

        if (lastChunk > 0)
            infile.seekg((long long)lastChunk * CHUNK_SIZE);

        char fileBuffer[CHUNK_SIZE];
        int totalChunks = (int)((fileSize + CHUNK_SIZE - 1) / CHUNK_SIZE);
        int currentChunk = lastChunk;
        long long bytesSent = (long long)lastChunk * CHUNK_SIZE;

        auto lastReport = chrono::steady_clock::now();
        auto transferStart = chrono::steady_clock::now();

        while (infile.read(fileBuffer, sizeof(fileBuffer)) || infile.gcount() > 0)
        {
            streamsize bytes_to_send = infile.gcount();
            int sent = Net::sendData(ssl, fileBuffer, bytes_to_send);

            if (sent <= 0)
            {
                cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
                infile.close();
                return false;
            }

            bytesSent += bytes_to_send;
            currentChunk = (int)((bytesSent + CHUNK_SIZE - 1) / CHUNK_SIZE);

            auto now = chrono::steady_clock::now();
            if (chrono::duration_cast<chrono::milliseconds>(now - lastReport).count() >= 150)
            {
                cout << "SENDER_PROGRESS:" << requestId << "|" << currentChunk << "|" << totalChunks << endl;
                lastReport = now;
            }
        }

        string checksum = WinDrop::computeSHA256(localFilePath);
        string complete_msg = "COMPLETE:" + checksum + "\n";
        if (Net::sendData(ssl, complete_msg.c_str(), complete_msg.length()) <= 0)
        {
            infile.close();
            return false;
        }

        cout << "🏁 File sent. Waiting for delivery confirmation..." << endl;

        memset(buffer, 0, sizeof(buffer));
        bytes_received = Net::recvData(ssl, buffer, sizeof(buffer) - 1);

        if (bytes_received > 0)
        {
            string final_resp(buffer, bytes_received);

            if (final_resp.find("DELIVERED_ACK") == 0)
            {
                auto transferEnd = chrono::steady_clock::now();
                long long elapsedMs = chrono::duration_cast<chrono::milliseconds>(
                                          transferEnd - transferStart)
                                          .count();
                cout << "BENCHMARK:" << elapsedMs << "|" << fileSize << endl;
                cout << "🌟 SUCCESS: File delivered and verified!" << endl;
            }
            else if (final_resp.find("ERROR:CHECKSUM_MISMATCH") == 0)
            {
                cout << "ERROR:CHECKSUM_MISMATCH|" << requestId << endl;
            }
            else if (final_resp.find("ERROR:DISK_FULL") == 0)
            {
                cout << "ERROR:DISK_FULL|" << requestId << endl;
            }
            else
            {
                cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
                connectionAlive = false;
            }
        }
        else
        {
            cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
            connectionAlive = false;
        }

        infile.close();
    }
    else if (response.find("ERROR:FILE_BUSY") == 0)
    {
        cout << "ERROR:FILE_BUSY|" << requestId << endl;
    }
    else
    {
        cout << "ERROR:TRANSFER_REJECTED|" << requestId << endl;
    }

    return connectionAlive;
}

int main(int argc, char *argv[])
{
    if (argc < 4)
    {
        cerr << "Usage: ./sender <target_ip> <file_path> <request_id>" << endl;
        return 1;
    }

    Net::init();
    SSL_CTX *client_tls_ctx = Net::createClientTLSContext();
    string target_ip = argv[1];
    string file_path = argv[2];
    string requestId = argv[3];
    bool isFolderMode = (argc >= 5 && string(argv[4]) == "--folder");

    socket_t sock = Net::createSocket(SOCK_STREAM);
    if (sock == -1)
    {
        cerr << "Socket creation error" << endl;
        return 1;
    }

    struct sockaddr_in serv_addr;
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(8080);
    if (Net::inetPton(target_ip.c_str(), &serv_addr) <= 0)
    {
        cerr << "Invalid address/ Address not supported" << endl;
        return 1;
    }

    cout << "🔄 Attempting connection to " << target_ip << "..." << endl;
    if (connect(sock, (struct sockaddr *)&serv_addr, sizeof(serv_addr)) < 0)
    {
        cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
        Net::closeSocket(sock);
        Net::cleanup();
        return 1;
    }

    Net::setNoDelay(sock);
    Net::setSocketBufferSize(sock, 1 << 20);
    SSL *ssl = Net::tlsConnect(sock, client_tls_ctx);
    if (!ssl)
    {
        cout << "ERROR:TLS_HANDSHAKE_FAILED|" << requestId << endl;
        Net::closeTLS(ssl, sock);
        SSL_CTX_free(client_tls_ctx);
        Net::cleanup();
        return 1;
    }

    // Trust-on-first-use certificate pinning
    string fingerprint = Net::getPeerCertFingerprint(ssl);
    auto known = WinDrop::loadTrustStore();
    auto it = known.find(target_ip);

    if (it == known.end())
    {
        cout << "🔑 New peer, trusting on first connection: " << fingerprint.substr(0, 16) << "..." << endl;
        WinDrop::trustPeer(target_ip, fingerprint);
    }
    else if (it->second != fingerprint)
    {
        cerr << "⚠️  WARNING: certificate for " << target_ip
             << " does NOT match the one seen previously. Possible MITM. Aborting." << endl;
        cout << "ERROR:CERT_MISMATCH|" << requestId << endl;
        Net::closeTLS(ssl, sock);
        SSL_CTX_free(client_tls_ctx);
        Net::cleanup();
        return 1;
    }

    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0)
        strcpy(hostname, "Unknown_Peer");
    string senderName(hostname);

    if (isFolderMode)
    {
        // file_path is actually a folder path in this mode.
        auto manifest = buildManifest(file_path);
        long long totalSize = 0;
        for (auto &entry : manifest) totalSize += entry.second;
        string folderName = fs::path(file_path).filename().string();
        if (folderName.empty()) folderName = "folder"; // path had a trailing slash

        string folderReq = "FOLDER_REQUEST:" + requestId + "|" + folderName + "|" +
                            to_string(manifest.size()) + "|" + to_string(totalSize) + "|" +
                            senderName + "\n";
        Net::sendData(ssl, folderReq.c_str(), folderReq.length());

        string manifestMsg = "FILE_MANIFEST:";
        for (size_t i = 0; i < manifest.size(); i++)
        {
            if (i > 0) manifestMsg += ";";
            manifestMsg += manifest[i].first + "|" + to_string(manifest[i].second);
        }
        manifestMsg += "\n";
        Net::sendData(ssl, manifestMsg.c_str(), manifestMsg.length());

        cout << "📦 Sent folder request: " << manifest.size() << " files, "
             << totalSize << " bytes total. Waiting for acceptance..." << endl;

        char folderBuffer[65536];
        memset(folderBuffer, 0, sizeof(folderBuffer));
        int folderBytes = Net::recvData(ssl, folderBuffer, sizeof(folderBuffer) - 1);
        if (folderBytes <= 0)
        {
            cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
            Net::closeTLS(ssl, sock);
            SSL_CTX_free(client_tls_ctx);
            Net::cleanup();
            return 1;
        }
        string folderResp(folderBuffer, folderBytes);

        if (folderResp.find("FOLDER_ACCEPT:" + requestId) == 0)
        {
            cout << "✅ Folder transfer accepted! Sending " << manifest.size() << " file(s)..." << endl;

            int filesSent = 0;
            int filesFailed = 0;
            for (size_t i = 0; i < manifest.size(); i++)
            {
                const string &relPath = manifest[i].first;
                string localPath = (fs::path(file_path) / relPath).string();
                string perFileId = requestId + "_" + to_string(i);

                cout << "📄 (" << (i + 1) << "/" << manifest.size() << ") " << relPath << endl;

                bool connectionAlive = sendOneFile(ssl, localPath, relPath, perFileId, senderName);
                filesSent++;
                if (!connectionAlive)
                {
                    filesFailed = (int)(manifest.size() - i); // this + everything not yet attempted
                    break;
                }
            }

            cout << "FOLDER_SEND_COMPLETE:" << requestId << "|sent=" << filesSent
                 << "|failed=" << filesFailed << "|total=" << manifest.size() << endl;
        }
        else
        {
            cout << "ERROR:TRANSFER_REJECTED|" << requestId << endl;
        }

        Net::closeTLS(ssl, sock);
        SSL_CTX_free(client_tls_ctx);
        Net::cleanup();
        return 0;
    }

    // Standalone single-file transfer
    string filename = file_path.substr(file_path.find_last_of("/\\") + 1);
    sendOneFile(ssl, file_path, filename, requestId, senderName);

    Net::closeTLS(ssl, sock);
    SSL_CTX_free(client_tls_ctx);
    Net::cleanup();
    return 0;
}