#ifndef SHA256_H
#define SHA256_H

#include <string>
#include <vector>
#include <iostream>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace WinDrop {
    std::string computeSHA256(const std::string& filePath);
}

#endif
