#include <iostream>
#include <fstream>
#include <cstring>
#include <random>
#include <algorithm>
#include <vector>
#include "sha256.h"
#include "net_platform.h"

using namespace std;

const int CHUNK_SIZE = 1024;

long long getFileSize(const string &filePath)
{
    ifstream in(filePath, ios::binary | ios::ate);
    return in.tellg();
}

int main(int argc, char *argv[])
{
    if (argc < 4)
    {
        cerr << "Usage: ./sender <target_ip> <file_path>" << endl;
        return 1;
    }

    Net::init();
    string target_ip = argv[1];
    string file_path = argv[2];
    string requestId = argv[3];

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
        return 1;
    }

    // Resume Support
    string filename = file_path.substr(file_path.find_last_of("/\\") + 1);
    long long fileSize = getFileSize(file_path);
    string resume_query = "RESUME_QUERY:" + requestId + "|" + filename + "|" + to_string(fileSize) + "\n";
    Net::sendData(sock, resume_query.c_str(), resume_query.length());
    char buffer[1024];
    memset(buffer, 0, 1024);
    int bytes_received = Net::recvData(sock, buffer, sizeof(buffer) - 1);
    int lastChunk = 0;
    if (bytes_received > 0)
    {
        string response(buffer, bytes_received);
        if (response.find("RESUME_RESPONSE:OK|") == 0)
        {
            string chunk_str = response.substr(18);
            lastChunk = stoi(chunk_str);
            cout << "🔄 Resuming transfer from chunk " << lastChunk << endl;
        }
        else
        {
            cout << "🆕 Starting new transfer." << endl;
        }
    }

    // Handshake
    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0)
        strcpy(hostname, "Unknown_Peer");
    string senderName(hostname);

    string request = "REQUEST:" + requestId + "|" + filename + "|" + to_string(fileSize) + "|" + senderName + "\n";
    Net::sendData(sock, request.c_str(), request.length());
    cout << "📡 Handshake request sent (" << requestId << "). Waiting for acceptance..." << endl;

    memset(buffer, 0, 1024);
    bytes_received = Net::recvData(sock, buffer, sizeof(buffer) - 1);
    if (bytes_received <= 0)
    {
        cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
        Net::closeSocket(sock);
        return 1;
    }

    string response(buffer, bytes_received);
    if (response.find("REQUEST_ACCEPT:" + requestId) == 0)
    {
        cout << "✅ Transfer accepted! Starting stream..." << endl;

        ifstream infile(file_path, ios::binary);
        if (!infile.is_open())
        {
            cout << "ERROR:PERMISSION_DENIED|" << requestId << endl;
            Net::closeSocket(sock);
            return 1;
        }

        if (lastChunk > 0)
        {
            infile.seekg((long long)lastChunk * CHUNK_SIZE);
        }

        char fileBuffer[CHUNK_SIZE];
        int totalChunks = (fileSize + CHUNK_SIZE - 1) / CHUNK_SIZE;
        int currentChunk = lastChunk;

        while (infile.read(fileBuffer, sizeof(fileBuffer)) || infile.gcount() > 0)
        {
            int bytes_to_send = infile.gcount();
            Net::sendData(sock, fileBuffer, bytes_to_send);

            memset(buffer, 0, 1024);
            int ack_bytes = Net::recvData(sock, buffer, sizeof(buffer) - 1);

            if (ack_bytes > 0)
            {
                currentChunk += (bytes_to_send + CHUNK_SIZE - 1) / CHUNK_SIZE;
                cout << "SENDER_PROGRESS:" << requestId << "|" << currentChunk << "|" << totalChunks << endl;
            }
            else
            {
                cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
                break;
            }
        }

        // Delivery Confirmation
        string checksum = WinDrop::computeSHA256(file_path);
        string complete_msg = "COMPLETE:" + checksum + "\n";
        Net::sendData(sock, complete_msg.c_str(), complete_msg.length());
        cout << "🏁 File sent. Waiting for delivery confirmation..." << endl;

        memset(buffer, 0, 1024);
        bytes_received = Net::recvData(sock, buffer, sizeof(buffer) - 1);
        if (bytes_received > 0)
        {
            string final_resp(buffer, bytes_received);
            if (final_resp.find("DELIVERED_ACK") == 0)
            {
                cout << "🌟 SUCCESS: File delivered and verified!" << endl;
            }
            else if (final_resp.find("ERROR:CHECKSUM_MISMATCH") == 0) {
                cout << "ERROR:CHECKSUM_MISMATCH|" << requestId << endl;
            } else if (final_resp.find("ERROR:DISK_FULL") == 0) {
                cout << "ERROR:DISK_FULL|" << requestId << endl;
            } else {
                cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
            }
        } else {
            cout << "ERROR:PEER_DISCONNECTED|" << requestId << endl;
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

    Net::closeSocket(sock);
    Net::cleanup();
    return 0;
}
