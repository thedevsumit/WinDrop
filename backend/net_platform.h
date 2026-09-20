#ifndef NET_PLATFORM_H
#define NET_PLATFORM_H
#include <sstream>
#include <iomanip>
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

namespace Net
{
    // Buffered, delimiter-based reader for the control protocol.
    //
    // recvData()/SSL_read() give you "whatever bytes are available right
    // now" — NOT "the next message." TCP (and TLS records on top of it)
    // have no concept of message boundaries: two back-to-back sendData()
    // calls can arrive coalesced into a single recvData() call on the
    // other end, and a message larger than one recv() call's worth can
    // arrive split across several. Every control message in this
    // protocol (REQUEST, RESUME_QUERY, FOLDER_REQUEST, FILE_MANIFEST,
    // COMPLETE, ...) is newline-terminated, so this class keeps
    // whatever partial/extra bytes were read past the previous '\n' and
    // returns exactly one line at a time, reading more from the socket
    // only when the buffer doesn't yet contain a full one. This is a
    // correctness requirement, not an optimization — without it,
    // FOLDER_REQUEST followed immediately by FILE_MANIFEST can either
    // hang (coalesced into one read, so the second recvData() call waits
    // forever for bytes that already arrived) or silently truncate a
    // large manifest (split across reads, first recvData() treated as
    // the whole thing).
    class MsgReader
    {
    public:
        explicit MsgReader(SSL *ssl) : ssl_(ssl) {}

        // Reads one newline-terminated message (delimiter stripped).
        // Returns false if the connection closed/errored before a full
        // line was available — treat this exactly like a failed
        // recvData() call (peer disconnected).
        bool readLine(std::string &out)
        {
            size_t nl;
            while ((nl = buf_.find('\n')) == std::string::npos)
            {
                char chunk[65536];
                int n = SSL_read(ssl_, chunk, sizeof(chunk));
                if (n <= 0) return false;
                buf_.append(chunk, n);
            }
            out = buf_.substr(0, nl);
            if (!out.empty() && out.back() == '\r') out.pop_back();
            buf_.erase(0, nl + 1);
            return true;
        }

        // Reads exactly n bytes (used for raw file-chunk streaming,
        // where the payload is length-prefixed by the caller's own
        // size tracking rather than newline-delimited). Any bytes
        // already buffered past the last readLine() are consumed
        // first.
        bool readExact(char *out, size_t n)
        {
            while (buf_.size() < n)
            {
                char chunk[65536];
                int r = SSL_read(ssl_, chunk, sizeof(chunk));
                if (r <= 0) return false;
                buf_.append(chunk, r);
            }
            memcpy(out, buf_.data(), n);
            buf_.erase(0, n);
            return true;
        }

    private:
        SSL *ssl_;
        std::string buf_;
    };

    // Lifecycle
    socket_t createSocket(int type);
    void closeSocket(socket_t fd);

    // Data Transfer (Plaintext)
    int sendData(socket_t fd, const void *buf, size_t len);
    int sendTo(socket_t fd, const void *buf, size_t len, const struct sockaddr_in *addr);
    int recvData(socket_t fd, void *buf, size_t len);

    void setReuseAddr(socket_t fd);
    void enableBroadcast(socket_t fd);
    void joinMulticastGroup(socket_t fd, const char *group);
    void setMulticastInterface(socket_t fd, const char *localIp);
    void setNoDelay(socket_t fd);
    void setSocketBufferSize(socket_t fd, int bytes);
    void setRecvTimeout(socket_t fd, int seconds);
    std::string getPeerCertFingerprint(ssl_st* ssl);
    // Addressing
    int inetPton(const char *ip, struct sockaddr_in *addr);
    std::string inetNton(struct sockaddr_in *addr);

    // Utility
    std::string getLocalIP();

    // Global Init/Cleanup (mostly for Windows)
    void init();
    void cleanup();

    // --- TLS Abstractions ---

    // Initialize OpenSSL context for the receiving peer (Core)
    inline SSL_CTX *createServerTLSContext(const char *certFile, const char *keyFile)
    {
        SSL_load_error_strings();
        OpenSSL_add_ssl_algorithms();

        const SSL_METHOD *method = TLS_server_method();
        SSL_CTX *ctx = SSL_CTX_new(method);
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
    inline SSL_CTX *createClientTLSContext()
    {
        SSL_load_error_strings();
        OpenSSL_add_ssl_algorithms();

        const SSL_METHOD *method = TLS_client_method();
        SSL_CTX *ctx = SSL_CTX_new(method);
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
    inline SSL *tlsAccept(socket_t sock, SSL_CTX *ctx)
    {
        SSL *ssl = SSL_new(ctx);
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
    inline SSL *tlsConnect(socket_t sock, SSL_CTX *ctx)
    {
        SSL *ssl = SSL_new(ctx);
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
    inline int sendData(SSL *ssl, const void *buf, size_t len)
    {
        return SSL_write(ssl, buf, (int)len);
    }

    // Overloaded TLS read (matches plaintext signature style)
    inline int recvData(SSL *ssl, void *buf, size_t len)
    {
        return SSL_read(ssl, buf, (int)len);
    }

    // Gracefully terminate TLS session and close underlying socket
    inline void closeTLS(SSL *ssl, socket_t sock)
    {
        if (ssl)
        {
            SSL_shutdown(ssl);
            SSL_free(ssl);
        }
        closeSocket(sock);
    }
    inline std::string getPeerCertFingerprint(SSL *ssl)
    {
        X509 *cert = SSL_get_peer_certificate(ssl);
        if (!cert)
            return "";

        unsigned char digest[EVP_MAX_MD_SIZE];
        unsigned int digest_len = 0;
        X509_digest(cert, EVP_sha256(), digest, &digest_len);
        X509_free(cert);

        std::ostringstream oss;
        for (unsigned int i = 0; i < digest_len; i++)
            oss << std::hex << std::setw(2) << std::setfill('0') << (int)digest[i];
        return oss.str();
    }
}

#endif