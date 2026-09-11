#include "net_platform.h"
#include <iostream>
#include <ifaddrs.h>
#include <netdb.h>
#include <cstring>
#include <net/if.h>
namespace Net {
    socket_t createSocket(int type) {
        return socket(AF_INET, type, 0);
    }

    void closeSocket(socket_t fd) {
        close(fd);
    }

    int sendData(socket_t fd, const void* buf, size_t len) {
        return send(fd, buf, len, 0);
    }

    int sendTo(socket_t fd, const void* buf, size_t len, const struct sockaddr_in* addr) {
        return sendto(fd, buf, len, 0, (struct sockaddr*)addr, sizeof(struct sockaddr_in));
    }

    int recvData(socket_t fd, void* buf, size_t len) {
        return recv(fd, buf, len, 0);
    }

    void setReuseAddr(socket_t fd) {
        int reuse = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    }

    void enableBroadcast(socket_t fd) {
        int broadcast = 1;
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast));
    }

    void joinMulticastGroup(socket_t fd, const char* group) {
        struct ip_mreq mreq;
        mreq.imr_multiaddr.s_addr = inet_addr(group);
        mreq.imr_interface.s_addr = htonl(INADDR_ANY);
        setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq));
    }

    int inetPton(const char* ip, struct sockaddr_in* addr) {
        addr->sin_family = AF_INET;
        return inet_pton(AF_INET, ip, &addr->sin_addr);
    }

    std::string inetNton(struct sockaddr_in* addr) {
        char buf[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &addr->sin_addr, buf, INET_ADDRSTRLEN);
        return std::string(buf);
    }

    std::string getLocalIP() {
        struct ifaddrs *ifaddr, *ifa;
        char host[NI_MAXHOST];
        std::string best_ip = "127.0.0.1";

        getifaddrs(&ifaddr);
        for (ifa = ifaddr; ifa != nullptr; ifa = ifa->ifa_next) {
            if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
            if (ifa->ifa_flags & IFF_LOOPBACK) continue;

            int s = getnameinfo(ifa->ifa_addr, sizeof(struct sockaddr_in),
                                host, NI_MAXHOST, nullptr, 0, NI_NUMERICHOST);
            if (s == 0) {
                best_ip = std::string(host);
                break;
            }
        }
        freeifaddrs(ifaddr);
        return best_ip;
    }

    void init() {}
    void cleanup() {}
}
