#ifndef TRUST_STORE_H
#define TRUST_STORE_H
#include <string>
#include <fstream>
#include <map>

namespace WinDrop
{
    inline std::string trustStorePath() { return "known_peers.txt"; }

    inline std::map<std::string, std::string> loadTrustStore()
    {
        std::map<std::string, std::string> peers;
        std::ifstream in(trustStorePath());
        std::string ip, fp;
        while (in >> ip >> fp) peers[ip] = fp;
        return peers;
    }

    inline void trustPeer(const std::string& ip, const std::string& fingerprint)
    {
        std::ofstream out(trustStorePath(), std::ios::app);
        out << ip << " " << fingerprint << "\n";
    }
}
#endif