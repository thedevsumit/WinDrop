#include <iostream>
#include "path_utils.h"

static int failures = 0;

void expect(const std::string &label, bool condition)
{
    if (condition) { std::cout << "PASS: " << label << std::endl; }
    else { std::cout << "FAIL: " << label << std::endl; failures++; }
}

int main()
{
    using WinDrop::sanitizeFilename;

    // The exact payload we used to verify the live fix
    expect("basic traversal is stripped to basename",
           sanitizeFilename("../../../../tmp/pwned.txt") == "pwned.txt");

    expect("Windows-style traversal is stripped",
           sanitizeFilename("..\\..\\Windows\\System32\\evil.dll") == "evil.dll");

    expect("bare '..' is rejected, not passed through",
           sanitizeFilename("..") == "unnamed_file");

    expect("bare '.' is rejected",
           sanitizeFilename(".") == "unnamed_file");

    expect("empty string is rejected",
           sanitizeFilename("") == "unnamed_file");

    expect("absolute path is reduced to basename only",
           sanitizeFilename("/etc/passwd") == "passwd");

    expect("normal filename passes through unchanged",
           sanitizeFilename("photo.jpg") == "photo.jpg");

    expect("filename containing '..' mid-string (not just as a path segment) is still rejected",
           sanitizeFilename("my..file.txt") == "unnamed_file");
    // NOTE: this is a real, known tradeoff — a legitimate filename with
    // literal ".." in it gets rejected too. That's the correct conservative
    // choice for a security boundary: reject anything ambiguous rather than
    // try to be clever about which ".." usages are "safe."

    expect("mixed separators still resolve to basename",
           sanitizeFilename("a/b\\../../c.txt") == "c.txt");

    std::cout << "\n" << (failures == 0 ? "ALL TESTS PASSED" : std::to_string(failures) + " TEST(S) FAILED") << std::endl;
    return failures == 0 ? 0 : 1;
}