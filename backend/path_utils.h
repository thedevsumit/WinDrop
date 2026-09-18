#ifndef PATH_UTILS_H
#define PATH_UTILS_H

#include <string>
#include <vector>

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

    // Sanitizes a RELATIVE path within a folder transfer (e.g.
    // "photos/vacation/img1.jpg"), preserving subdirectory structure while
    // rejecting absolute paths, Windows drive letters, and any ".."
    // segment anywhere in the path — not just at the start, since a
    // traversal segment buried in the middle ("photos/../../etc/passwd")
    // is just as dangerous as a leading one.
    inline std::string sanitizeRelativePath(const std::string &raw)
    {
        if (raw.empty()) return "unnamed_file";
        if (raw[0] == '/' || raw[0] == '\\') return "unnamed_file";
        if (raw.size() >= 2 && raw[1] == ':') return "unnamed_file"; // e.g. "C:\..."

        std::string normalized = raw;
        for (auto &c : normalized) if (c == '\\') c = '/';

        std::vector<std::string> segments;
        size_t start = 0;
        while (start <= normalized.size())
        {
            size_t pos = normalized.find('/', start);
            std::string seg = (pos == std::string::npos) ? normalized.substr(start) : normalized.substr(start, pos - start);
            if (seg == ".." || seg == "." || seg.empty())
                return "unnamed_file";
            segments.push_back(seg);
            if (pos == std::string::npos) break;
            start = pos + 1;
        }
        if (segments.empty()) return "unnamed_file";

        std::string result;
        for (size_t i = 0; i < segments.size(); i++)
        {
            if (i > 0) result += "/";
            result += segments[i];
        }
        return result;
    }
}

#endif