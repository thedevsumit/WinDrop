#ifndef NET_PLATFORM_H
#define NET_PLATFORM_H

#include <string>
#include <vector>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    typedef SOCKET socket_t;
#else
    #include <sys/socket.h>
    #include <arpa/inet.h>
    #include <unistd.h>
    #include <netinet/in.h>
    typedef int socket_t;
#endif

namespace Net {
    // Lifecycle
    socket_t createSocket(int type);
    void closeSocket(socket_t fd);

    // Data Transfer
    int sendData(socket_t fd, const void* buf, size_t len);
    int sendTo(socket_t fd, const void* buf, size_t len, const struct sockaddr_in* addr);
    int recvData(socket_t fd, void* buf, size_t len);

    // Configuration
    void setReuseAddr(socket_t fd);
    void enableBroadcast(socket_t fd);
    void joinMulticastGroup(socket_t fd, const char* group);

    // Addressing
    int inetPton(const char* ip, struct sockaddr_in* addr);
    std::string inetNton(struct sockaddr_in* addr);

    // Utility
    std::string getLocalIP();

    // Global Init/Cleanup (mostly for Windows)
    void init();
    void cleanup();
}

#endif
