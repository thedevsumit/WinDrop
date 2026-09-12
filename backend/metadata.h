#ifndef METADATA_H
#define METADATA_H

#include <string>
#include <fstream>

namespace WinDrop
{

    inline void save_metadata(const std::string &filename, long long totalSize, int chunkSize, int lastChunk)
    {
        std::ofstream meta(filename + ".part.meta");
        meta << totalSize << "\n"
             << chunkSize << "\n"
             << lastChunk << "\n";
        meta.close();
    }

    inline int read_metadata(const std::string &filename, long long &totalSize)
    {
        std::ifstream meta(filename + ".part.meta");
        if (!meta)
            return -1;
        int lastChunk;
        int chunkSize;
        if (!(meta >> totalSize >> chunkSize >> lastChunk))
            return -1;
        return lastChunk;
    }

}
#endif