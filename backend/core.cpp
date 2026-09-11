#include <iostream>
#include <fstream>
#include <thread>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <map>
#include <mutex>
#include <condition_variable>
#include <sstream>
#include <vector>
#include <ifaddrs.h>
#include <netdb.h>

using namespace std;

struct RequestState {
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

string getLocalIP() {
    char buffer[256];
    string best_ip = "127.0.0.1";
    FILE *pipe = popen("ipconfig.exe", "r");
    if (!pipe) return best_ip;
    while (fgets(buffer, sizeof(buffer), pipe) != NULL) {
        string line = buffer;
        if (line.find("IPv4") != string::npos) {
            size_t colon_pos = line.find(":");
            if (colon_pos != string::npos) {
                string ip = line.substr(colon_pos + 1);
                ip.erase(ip.find_last_not_of(" \n\r\t") + 1);
                ip.erase(0, ip.find_first_not_of(" \n\r\t"));
                if (ip.find("172.") != 0 && ip.find("169.254.") != 0 && ip != "127.0.0.1") {
                    best_ip = ip;
                    if (best_ip.find("10.") == 0 || best_ip.find("192.168.") == 0) break;
                }
            }
        }
    }
    pclose(pipe);
    return best_ip;
}

void run_udp_broadcaster() {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    int broadcast_enable = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast_enable, sizeof(broadcast_enable));
    struct sockaddr_in broadcast_addr;
    broadcast_addr.sin_family = AF_INET;
    broadcast_addr.sin_port = htons(8888);
    broadcast_addr.sin_addr.s_addr = inet_addr("239.255.255.250");
    string ip = getLocalIP();
    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0) strcpy(hostname, "Unknown_Peer");
    string name(hostname);
    string message = name + ":" + ip + " Alive";
    while (true) {
        sendto(sock, message.c_str(), message.length(), 0, (struct sockaddr *)&broadcast_addr, sizeof(broadcast_addr));
        sleep(2);
    }
    close(sock);
}

void run_udp_listener() {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in listen_addr;
    listen_addr.sin_family = AF_INET;
    listen_addr.sin_port = htons(8888);
    listen_addr.sin_addr.s_addr = htonl(INADDR_ANY);
    bind(sock, (struct sockaddr *)&listen_addr, sizeof(listen_addr));
    struct ip_mreq mreq;
    mreq.imr_multiaddr.s_addr = inet_addr("239.255.255.250");
    mreq.imr_interface.s_addr = htonl(INADDR_ANY);
    setsockopt(sock, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq));
    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0) strcpy(hostname, "Unknown_Peer");
    string my_name(hostname);
    char buffer[1024];
    while (true) {
        memset(buffer, 0, 1024);
        recvfrom(sock, buffer, sizeof(buffer), 0, nullptr, nullptr);
        string received_msg(buffer);
        if (received_msg.find(my_name) == string::npos) {
            cout << "Founded Peer: " << buffer << "\n";
        }
    }
    close(sock);
}

void run_stdin_listener() {
    string line;
    while (getline(cin, line)) {
        if (line.empty()) continue;
        size_t colon_pos = line.find(':');
        if (colon_pos == string::npos) continue;
        string command = line.substr(0, colon_pos);
        string id = line.substr(colon_pos + 1);
        if (!id.empty() && id.back() == '\r') id.pop_back();
        if (!id.empty() && id.back() == '\n') id.pop_back();

        lock_guard<mutex> lock(requests_mutex);
        if (pending_requests.count(id)) {
            auto state = pending_requests[id];
            {
                lock_guard<mutex> state_lock(state->mtx);
                state->decision_made = true;
                state->accepted = (command == "REQUEST_ACCEPT");
            }
            state->cv.notify_one();
        }
    }
}

void handle_client(int new_socket) {
    char buffer[1024];
    memset(buffer, 0, 1024);
    int bytes_read = recv(new_socket, buffer, sizeof(buffer) - 1, 0);
    if (bytes_read <= 0) {
        close(new_socket);
        return;
    }

    string raw_data(buffer, bytes_read);
    if (raw_data.find("REQUEST:") == 0) {
        string payload = raw_data.substr(8);
        size_t pos = 0;
        vector<string> parts;
        while ((pos = payload.find('|')) != string::npos) {
            parts.push_back(payload.substr(0, pos));
            payload.erase(0, pos + 1);
        }
        parts.push_back(payload);

        if (parts.size() < 4) {
            close(new_socket);
            return;
        }

        string id = parts[0];
        string filename = parts[1];
        string size_str = parts[2];
        string sender = parts[3];
        if (!sender.empty() && sender.back() == '\n') sender.pop_back();
        if (!sender.empty() && sender.back() == '\r') sender.pop_back();

        cout << "INCOMING_REQUEST:" << id << "|" << filename << "|" << size_str << "|" << sender << endl;

        auto state = make_shared<RequestState>();
        state->socket = new_socket;
        state->id = id;
        state->filename = filename;
        state->sender = sender;
        try { state->size = stoll(size_str); } catch (...) { state->size = 0; }

        {
            lock_guard<mutex> lock(requests_mutex);
            pending_requests[id] = state;
        }

        unique_lock<mutex> state_lock(state->mtx);
        state->cv.wait(state_lock, [&]{ return state->decision_made; });

        if (state->accepted) {
            string resp = "REQUEST_ACCEPT:" + id + "\n";
            send(new_socket, resp.c_str(), resp.length(), 0);

            memset(buffer, 0, 1024);
            ofstream outfile(filename, ios::binary);
            while ((bytes_read = recv(new_socket, buffer, sizeof(buffer), 0)) > 0) {
                outfile.write(buffer, bytes_read);
            }
            outfile.close();
            cout << "✅ File Saved: " << filename << endl;
        } else {
            string resp = "REQUEST_REJECT:" + id + "\n";
            send(new_socket, resp.c_str(), resp.length(), 0);
        }

        {
            lock_guard<mutex> lock(requests_mutex);
            pending_requests.erase(id);
        }
        close(new_socket);
    } else {
        close(new_socket);
    }
}

void run_tcp_server() {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in address;
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(8080);
    bind(server_fd, (struct sockaddr *)&address, sizeof(address));
    listen(server_fd, 5);
    while (true) {
        int addrlen = sizeof(address);
        int new_socket = accept(server_fd, (struct sockaddr *)&address, (socklen_t *)&addrlen);
        thread(handle_client, new_socket).detach();
    }
    close(server_fd);
}

int main() {
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
    return 0;
}
