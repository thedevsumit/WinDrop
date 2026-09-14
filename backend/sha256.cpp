#include "sha256.h"
#include <cstdint>
#include <cstring>
#include <algorithm>
namespace
{

    const uint32_t K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

    inline uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

    struct Sha256Context
    {
        uint32_t h[8] = {
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
        unsigned char buffer[64];
        size_t bufferLen = 0;
        uint64_t totalLen = 0; // total message length in bytes

        void processBlock(const unsigned char *block)
        {
            uint32_t w[64];
            for (int i = 0; i < 16; ++i)
            {
                w[i] = (uint32_t(block[i * 4]) << 24) | (uint32_t(block[i * 4 + 1]) << 16) |
                       (uint32_t(block[i * 4 + 2]) << 8) | uint32_t(block[i * 4 + 3]);
            }
            for (int i = 16; i < 64; ++i)
            {
                uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
                uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16] + s0 + w[i - 7] + s1;
            }

            uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
            uint32_t e = h[4], f = h[5], g = h[6], hh = h[7];

            for (int i = 0; i < 64; ++i)
            {
                uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                uint32_t ch = (e & f) ^ (~e & g);
                uint32_t temp1 = hh + S1 + ch + K[i] + w[i];
                uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
                uint32_t temp2 = S0 + maj;

                hh = g;
                g = f;
                f = e;
                e = d + temp1;
                d = c;
                c = b;
                b = a;
                a = temp1 + temp2;
            }

            h[0] += a;
            h[1] += b;
            h[2] += c;
            h[3] += d;
            h[4] += e;
            h[5] += f;
            h[6] += g;
            h[7] += hh;
        }

        void update(const unsigned char *data, size_t len)
        {
            totalLen += len;
            while (len > 0)
            {
                size_t toCopy = std::min(len, size_t(64) - bufferLen);
                std::memcpy(buffer + bufferLen, data, toCopy);
                bufferLen += toCopy;
                data += toCopy;
                len -= toCopy;
                if (bufferLen == 64)
                {
                    processBlock(buffer);
                    bufferLen = 0;
                }
            }
        }

        void finalize(unsigned char digest[32])
        {
            uint64_t bitLen = totalLen * 8;

            unsigned char pad = 0x80;
            update(&pad, 1);

            unsigned char zero = 0x00;
            while (bufferLen != 56)
            {
                update(&zero, 1);
            }

            unsigned char lenBytes[8];
            for (int i = 0; i < 8; ++i)
            {
                lenBytes[i] = (unsigned char)(bitLen >> (56 - i * 8));
            }
            // Append the length directly into the final block without going
            // through update() again (which would re-trigger the padding logic).
            std::memcpy(buffer + bufferLen, lenBytes, 8);
            processBlock(buffer);

            for (int i = 0; i < 8; ++i)
            {
                digest[i * 4] = (unsigned char)(h[i] >> 24);
                digest[i * 4 + 1] = (unsigned char)(h[i] >> 16);
                digest[i * 4 + 2] = (unsigned char)(h[i] >> 8);
                digest[i * 4 + 3] = (unsigned char)(h[i]);
            }
        }
    };

} // namespace

namespace WinDrop
{

    std::string computeSHA256(const std::string &filePath)
    {
        std::ifstream file(filePath, std::ios::binary);
        if (!file)
            return "";

        Sha256Context ctx;
        unsigned char buffer[4096];
        while (file.read(reinterpret_cast<char *>(buffer), sizeof(buffer)) || file.gcount() > 0)
        {
            ctx.update(buffer, static_cast<size_t>(file.gcount()));
        }
        file.close();

        unsigned char digest[32];
        ctx.finalize(digest);

        std::stringstream ss;
        ss << std::hex << std::setfill('0');
        for (int i = 0; i < 32; ++i)
        {
            ss << std::setw(2) << (int)digest[i];
        }
        return ss.str();
    }
    std::string computeSHA256Prefix(const std::string &filePath, size_t maxBytes)
    {
        std::ifstream file(filePath, std::ios::binary);
        if (!file)
            return "";

        Sha256Context ctx;
        unsigned char buffer[4096];
        size_t remaining = maxBytes;

        while (remaining > 0)
        {
            size_t toRead = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
            file.read(reinterpret_cast<char *>(buffer), toRead);
            std::streamsize got = file.gcount();
            if (got <= 0)
                break;
            ctx.update(buffer, static_cast<size_t>(got));
            remaining -= static_cast<size_t>(got);
        }
        file.close();

        unsigned char digest[32];
        ctx.finalize(digest);
        std::stringstream ss;
        ss << std::hex << std::setfill('0');
        for (int i = 0; i < 32; ++i)
            ss << std::setw(2) << (int)digest[i];
        return ss.str();
    }
}