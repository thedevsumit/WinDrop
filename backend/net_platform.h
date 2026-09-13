#ifndef NET_PLATFORM_H
#define NET_PLATFORM_H

#include <string>
#include <vector>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <cstddef>
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

    // Data Transfer (Plaintext)
    int sendData(socket_t fd, const void* buf, size_t len);
    int sendTo(socket_t fd, const void* buf, size_t len, const struct sockaddr_in* addr);
    int recvData(socket_t fd, void* buf, size_t len);

    void setReuseAddr(socket_t fd);
    void enableBroadcast(socket_t fd);
    void joinMulticastGroup(socket_t fd, const char* group);
    void setMulticastInterface(socket_t fd, const char* localIp);
    void setNoDelay(socket_t fd);
    
    // Addressing
    int inetPton(const char* ip, struct sockaddr_in* addr);
    std::string inetNton(struct sockaddr_in* addr);

    // Utility
    std::string getLocalIP();

    // Global Init/Cleanup (mostly for Windows)
    void init();
    void cleanup();

    // --- TLS Abstractions ---

    // Initialize OpenSSL context for the receiving peer (Core)
    inline SSL_CTX* createServerTLSContext(const char* certFile, const char* keyFile)
    {
        SSL_load_error_strings();
        OpenSSL_add_ssl_algorithms();
        
        const SSL_METHOD* method = TLS_server_method();
        SSL_CTX* ctx = SSL_CTX_new(method);
        if (!ctx)
        {
            ERR_print_errors_fp(stderr);
            return nullptr;
        }

        if (SSL_CTX_use_certificate_file(ctx, certFile, SSL_FILETYPE_PEM) <= 0 ||
            SSL_CTX_use_PrivateKey_file(ctx, keyFile, SSL_FILETYPE_PEM) <= 0)
        {
            ERR_print_errors_fp(stderr);
            SSL_CTX_free(ctx);
            return nullptr;
        }
        return ctx;
    }

    // Initialize OpenSSL context for the sending peer
    inline SSL_CTX* createClientTLSContext()
    {
        SSL_load_error_strings();
        OpenSSL_add_ssl_algorithms();

        const SSL_METHOD* method = TLS_client_method();
        SSL_CTX* ctx = SSL_CTX_new(method);
        if (!ctx)
        {
            ERR_print_errors_fp(stderr);
            return nullptr;
        }

        // LAN P2P operates with self-signed certs; bypass public CA trust verification
        SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, nullptr);
        return ctx;
    }

    // Wrap accepted raw TCP socket in TLS server handshake
    inline SSL* tlsAccept(socket_t sock, SSL_CTX* ctx)
    {
        SSL* ssl = SSL_new(ctx);
        SSL_set_fd(ssl, (int)sock);
        if (SSL_accept(ssl) <= 0)
        {
            ERR_print_errors_fp(stderr);
            SSL_free(ssl);
            return nullptr;
        }
        return ssl;
    }

    // Wrap connected raw TCP socket in TLS client handshake
    inline SSL* tlsConnect(socket_t sock, SSL_CTX* ctx)
    {
        SSL* ssl = SSL_new(ctx);
        SSL_set_fd(ssl, (int)sock);
        if (SSL_connect(ssl) <= 0)
        {
            ERR_print_errors_fp(stderr);
            SSL_free(ssl);
            return nullptr;
        }
        return ssl;
    }

    // Overloaded TLS write (matches plaintext signature style)
    inline int sendData(SSL* ssl, const void* buf, size_t len)
    {
        return SSL_write(ssl, buf, (int)len);
    }

    // Overloaded TLS read (matches plaintext signature style)
    inline int recvData(SSL* ssl, void* buf, size_t len)
    {
        return SSL_read(ssl, buf, (int)len);
    }

    // Gracefully terminate TLS session and close underlying socket
    inline void closeTLS(SSL* ssl, socket_t sock)
    {
        if (ssl)
        {
            SSL_shutdown(ssl);
            SSL_free(ssl);
        }
        closeSocket(sock);
    }
}

#endif
