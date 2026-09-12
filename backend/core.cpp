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
#include "sha256.h"
#include "net_platform.h"
#include "metadata.h"
using namespace std;

const int CHUNK_SIZE = 1024;

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
};

map<string, shared_ptr<RequestState>> pending_requests;
mutex requests_mutex;

// --- GAP 4: Single-Writer Guard Globals ---
set<string> active_writes;
mutex writes_mutex;
// ------------------------------------------

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
    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0)
        strcpy(hostname, "Unknown_Peer");
    string name(hostname);
    string message = name + ":" + ip + " Alive";
    while (true)
    {
        Net::sendData(sock, message.c_str(), message.length());
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
    bind(sock, (struct sockaddr *)&listen_addr, sizeof(listen_addr));
    Net::joinMulticastGroup(sock, "239.255.255.250");
    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0)
        strcpy(hostname, "Unknown_Peer");
    string my_name(hostname);
    char buffer[1024];
    while (true)
    {
        memset(buffer, 0, 1024);
        int bytes = Net::recvData(sock, buffer, sizeof(buffer) - 1);
        if (bytes <= 0)
            continue;
        string received_msg(buffer, bytes);
        if (received_msg.find(my_name) == string::npos)
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
                state->accepted = (command == "REQUEST_ACCEPT");
            }
            state->cv.notify_one();
        }
    }
}

void handle_client(int new_socket)
{
    socket_t sock = (socket_t)new_socket;
    char buffer[1024];
    memset(buffer, 0, 1024);
    int bytes_read = Net::recvData(sock, buffer, sizeof(buffer) - 1);
    if (bytes_read <= 0)
    {
        Net::closeSocket(sock);
        return;
    }

    string raw_data(buffer, bytes_read);

    // Handle Resume Query
    if (raw_data.find("RESUME_QUERY:") == 0)
    {
        string payload = raw_data.substr(13);
        size_t pos1 = payload.find('|');
        size_t pos2 = (pos1 != string::npos) ? payload.find('|', pos1 + 1) : string::npos;
        if (pos1 != string::npos && pos2 != string::npos)
        {
            string resumeId = payload.substr(0, pos1);
            string filename = payload.substr(pos1 + 1, pos2 - pos1 - 1);
            long long size = stoll(payload.substr(pos2 + 1));
            long long metaSize;
            int lastChunk = WinDrop::read_metadata(filename, metaSize);
            if (lastChunk != -1 && metaSize == size)
            {
                string resp = "RESUME_RESPONSE:OK|" + to_string(lastChunk) + "\n";
                Net::sendData(sock, resp.c_str(), resp.length());
            }
            else if (lastChunk != -1 && metaSize != size)
            {
                cout << "ERROR:RESUME_STATE_INVALID|" << resumeId << endl;
                string resp = "RESUME_RESPONSE:NO\n";
                Net::sendData(sock, resp.c_str(), resp.length());
            }
            else
            {
                string resp = "RESUME_RESPONSE:NO\n";
                Net::sendData(sock, resp.c_str(), resp.length());
            }
        }
        memset(buffer, 0, 1024);
        bytes_read = Net::recvData(sock, buffer, sizeof(buffer) - 1);
        if (bytes_read <= 0)
        {
            Net::closeSocket(sock);
            return;
        }
        raw_data = string(buffer, bytes_read);
    }

    if (raw_data.find("REQUEST:") == 0)
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
        {
            Net::closeSocket(sock);
            return;
        }

        string id = parts[0];
        string filename = parts[1];
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
        state->cv.wait(state_lock, [&]
                       { return state->decision_made; });

        if (state->accepted)
        {
            // --- GAP 4: Single-Writer Guard Check ---
            {
                lock_guard write_lock(writes_mutex);
                if (active_writes.count(filename))
                {
                    Net::sendData(sock, "ERROR:FILE_BUSY\n", 16);
                    cout << "ERROR:FILE_BUSY|" << id << endl;
                    Net::closeSocket(sock);

                    lock_guard req_lock(requests_mutex);
                    pending_requests.erase(id);
                    return;
                }
                active_writes.insert(filename);
            }
            // ----------------------------------------

            string resp = "REQUEST_ACCEPT:" + id + "\n";
            Net::sendData(sock, resp.c_str(), resp.length());

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

            memset(buffer, 0, 1024);
            ofstream outfile(part_filename, ios::binary | ios::app);
            if (!outfile)
            {
                cout << "ERROR:PERMISSION_DENIED|" << id << endl;
                string err = "ERROR:PERMISSION_DENIED\n";
                Net::sendData(sock, err.c_str(), err.length());
                Net::closeSocket(sock);

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
                return;
            }

            vector<char> write_buffer;
            const size_t FLUSH_THRESHOLD = 16 * CHUNK_SIZE;

            // --- GAP 1: Track clean protocol exits ---
            bool transfer_completed = false;

            while ((bytes_read = Net::recvData(sock, buffer, sizeof(buffer))) > 0)
            {
                if (bytes_read < 1024 && string(buffer, bytes_read).find("COMPLETE:") == 0)
                {
                    string complete_msg = string(buffer, bytes_read);
                    string sender_checksum = complete_msg.substr(9);
                    if (!sender_checksum.empty() && sender_checksum.back() == '\n')
                        sender_checksum.pop_back();
                    if (!sender_checksum.empty() && sender_checksum.back() == '\r')
                        sender_checksum.pop_back();

                    if (!write_buffer.empty())
                    {
                        outfile.write(write_buffer.data(), write_buffer.size());
                        chunks_received += write_buffer.size() / CHUNK_SIZE;
                        WinDrop::save_metadata(filename, total_size,CHUNK_SIZE,chunks_received);
                        write_buffer.clear();
                    }

                    outfile.close();

                    string local_checksum = WinDrop::computeSHA256(part_filename);
                    if (local_checksum == sender_checksum)
                    {
                        if (rename(part_filename.c_str(), filename.c_str()) == 0)
                        {
                            cout << "✅ File Verified and Saved: " << filename << endl;
                            string meta_file = filename + ".part.meta";
                            remove(meta_file.c_str());
                            Net::sendData(sock, "DELIVERED_ACK\n", 14);

                            // --- GAP 3: Signal final success to Node.js ---
                            cout << "RECEIVED_OK|" << id << endl;
                        }
                        else
                        {
                            cout << "ERROR:DISK_FULL|" << id << endl;
                            Net::sendData(sock, "ERROR:DISK_FULL\n", 16);
                        }
                    }
                    else
                    {
                        cout << "❌ Checksum Mismatch! Sender: " << sender_checksum << " Local: " << local_checksum << endl;
                        cout << "ERROR:CHECKSUM_MISMATCH|" << id << endl;
                        Net::sendData(sock, "ERROR:CHECKSUM_MISMATCH\n", 24);
                    }

                    // --- GAP 1 (Bug A): Mark clean exit regardless of checksum success/fail ---
                    transfer_completed = true;
                    bytes_read = -1;
                    break;
                }

                write_buffer.insert(write_buffer.end(), buffer, buffer + bytes_read);
                chunks_received++;

                string ack = "ACK:" + to_string(chunks_received) + "\n";
                Net::sendData(sock, ack.c_str(), ack.length());

                if (write_buffer.size() >= FLUSH_THRESHOLD)
                {
                    outfile.write(write_buffer.data(), write_buffer.size());
                    WinDrop::save_metadata(filename, total_size,CHUNK_SIZE,chunks_received);
                    write_buffer.clear();
                    cout << "💾 Flushed buffer to disk at chunk " << chunks_received << endl;
                }

                cout << "TRANSFER_PROGRESS:" << id << "|" << chunks_received << "|" << (total_size + CHUNK_SIZE - 1) / CHUNK_SIZE << endl;
            }
            if (outfile.is_open())
                outfile.close();

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
            Net::sendData(sock, resp.c_str(), resp.length());
            cout << "ERROR:TRANSFER_REJECTED|" << id << endl;
        }

        {
            lock_guard lock(requests_mutex);
            pending_requests.erase(id);
        }
        Net::closeSocket(sock);
    }
    else
    {
        Net::closeSocket(sock);
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
    bind(server_fd, (struct sockaddr *)&address, sizeof(address));
    listen(server_fd, 5);
    while (true)
    {
        int addrlen = sizeof(address);
        int new_socket = accept(server_fd, (struct sockaddr *)&address, (socklen_t *)&addrlen);
        thread(handle_client, new_socket).detach();
    }
    Net::closeSocket(server_fd);
}

int main()
{
    Net::init();
    setvbuf(stdout, NULL, _IONBF, 0);
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