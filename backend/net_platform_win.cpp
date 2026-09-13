#include "net_platform.h"
#include <iostream>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")

namespace Net
{
    socket_t createSocket(int type)
    {
        return socket(AF_INET, type, 0);
    }

    void closeSocket(socket_t fd)
    {
        closesocket(fd);
    }

    int sendData(socket_t fd, const void *buf, size_t len)
    {
        return send(fd, (const char *)buf, len, 0);
    }

    int sendTo(socket_t fd, const void *buf, size_t len, const struct sockaddr_in *addr)
    {
        return sendto(fd, (const char *)buf, len, 0, (struct sockaddr *)addr, sizeof(struct sockaddr_in));
    }

    int recvData(socket_t fd, void *buf, size_t len)
    {
        return recv(fd, (char *)buf, len, 0);
    }

    void setReuseAddr(socket_t fd)
    {
        int reuse = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));
    }

    void enableBroadcast(socket_t fd)
    {
        int broadcast = 1;
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, (const char *)&broadcast, sizeof(broadcast));
    }

    void joinMulticastGroup(socket_t fd, const char *group)
    {
        struct ip_mreq mreq;
        mreq.imr_multiaddr.s_addr = inet_addr(group);
        mreq.imr_interface.s_addr = htonl(INADDR_ANY);
        setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, (const char *)&mreq, sizeof(mreq));
    }

    void setMulticastInterface(socket_t fd, const char *localIp)
    {
        struct in_addr localInterface;
        localInterface.s_addr = inet_addr(localIp);
        setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, (const char *)&localInterface, sizeof(localInterface));
    }

    int inetPton(const char *ip, struct sockaddr_in *addr)
    {
        addr->sin_family = AF_INET;
        return InetPtonA(AF_INET, ip, &addr->sin_addr);
    }

    std::string inetNton(struct sockaddr_in *addr)
    {
        char buf[INET_ADDRSTRLEN];
        InetNtopA(AF_INET, &addr->sin_addr, buf, INET_ADDRSTRLEN);
        return std::string(buf);
    }

    std::string getLocalIP()
    {
        ULONG outBufLen = 15000;
        IP_ADAPTER_ADDRESSES *pAddresses = (IP_ADAPTER_ADDRESSES *)malloc(outBufLen);

        if (GetAdaptersAddresses(AF_INET, GAA_FLAG_INCLUDE_PREFIX, NULL, pAddresses, &outBufLen) == NO_ERROR)
        {
            for (PIP_ADAPTER_ADDRESSES pCurrAddresses = pAddresses; pCurrAddresses != NULL; pCurrAddresses = pCurrAddresses->Next)
            {
                if (pCurrAddresses->OperStatus != IfOperStatusUp)
                    continue;
                if (pCurrAddresses->IfType == IF_TYPE_SOFTWARE_LOOPBACK)
                    continue;

                for (PIP_ADAPTER_UNICAST_ADDRESS pUnicast = pCurrAddresses->FirstUnicastAddress; pUnicast != NULL; pUnicast = pUnicast->Next)
                {
                    sockaddr_in *sa_in = (sockaddr_in *)pUnicast->Address.lpSockaddr;
                    char buf[INET_ADDRSTRLEN];
                    inet_ntop(AF_INET, &(sa_in->sin_addr), buf, INET_ADDRSTRLEN);
                    std::string ip = std::string(buf);
                    free(pAddresses);
                    return ip;
                }
            }
        }
        if (pAddresses)
            free(pAddresses);
        return "127.0.0.1";
    }

    void init()
    {
        WSADATA wsaData;
        WSAStartup(MAKEWORD(2, 2), &wsaData);
    }

    void cleanup()
    {
        WSACleanup();
    }
}
