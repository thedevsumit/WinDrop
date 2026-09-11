#include <iostream>
#include <fstream>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <random>
#include <algorithm>
#include <vector>

using namespace std;

string generateRequestId() {
    const string charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    string id = "";
    random_device rd;
    mt19937 gen(rd());
    uniform_int_distribution<> dis(0, charset.size() - 1);
    for (int i = 0; i < 8; ++i) id += charset[dis(gen)];
    return id;
}

long long getFileSize(const string& filePath) {
    ifstream in(filePath, ios::binary | ios::ate);
    return in.tellg();
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        cerr << "Usage: ./sender <target_ip> <file_path>" << endl;
        return 1;
    }

    string target_ip = argv[1];
    string file_path = argv[2];

    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        cerr << "Socket creation error" << endl;
        return 1;
    }

    struct sockaddr_in serv_addr;
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(8080);
    if (inet_pton(AF_INET, target_ip.c_str(), &serv_addr.sin_addr) <= 0) {
        cerr << "Invalid address/ Address not supported" << endl;
        return 1;
    }

    cout << "🔄 Attempting connection to " << target_ip << "..." << endl;
    if (connect(sock, (struct sockaddr *)&serv_addr, sizeof(serv_addr)) < 0) {
        cerr << "connection Failed. Is the other C++ engine running?" << endl;
        return 1;
    }

    // Handshake
    string requestId = generateRequestId();
    string filename = file_path.substr(file_path.find_last_of("/\\") + 1);
    long long fileSize = getFileSize(file_path);

    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0) strcpy(hostname, "Unknown_Peer");
    string senderName(hostname);

    string request = "REQUEST:" + requestId + "|" + filename + "|" + to_string(fileSize) + "|" + senderName + "\n";
    send(sock, request.c_str(), request.length(), 0);
    cout << "📡 Handshake request sent (" << requestId << "). Waiting for acceptance..." << endl;

    char buffer[1024];
    memset(buffer, 0, 1024);
    int bytes_received = recv(sock, buffer, sizeof(buffer) - 1, 0);
    if (bytes_received <= 0) {
        cerr << "❌ Connection lost during handshake." << endl;
        close(sock);
        return 1;
    }

    string response(buffer, bytes_received);
    if (response.find("REQUEST_ACCEPT:" + requestId) == 0) {
        cout << "✅ Transfer accepted! Starting stream..." << endl;

        ifstream infile(file_path, ios::binary);
        if (!infile.is_open()) {
            cerr << "Could not open file: " << file_path << endl;
            close(sock);
            return 1;
        }

        char fileBuffer[4096];
        while (infile.read(fileBuffer, sizeof(fileBuffer)) || infile.gcount() > 0) {
            send(sock, fileBuffer, infile.gcount(), 0);
        }

        cout << "SUCCESS: " << filename << " sent!" << endl;
        infile.close();
    } else {
        cerr << "❌ Transfer rejected by receiver." << endl;
    }

    close(sock);
    return 0;
}
