#ifndef PATH_UTILS_H
#define PATH_UTILS_H

#include <string>

namespace WinDrop
{
    // Strips any directory component from an untrusted, peer-supplied filename
    // and rejects anything that would resolve outside the current working
    // directory. See core.cpp's RESUME_QUERY and REQUEST handlers for callers.
    inline std::string sanitizeFilename(const std::string &raw)
    {
        size_t pos = raw.find_last_of("/\\");
        std::string base = (pos == std::string::npos) ? raw : raw.substr(pos + 1);

        if (base.empty() || base == "." || base == "..")
            return "unnamed_file";

        if (base.find("..") != std::string::npos)
            return "unnamed_file";

        return base;
    }
}

#endif