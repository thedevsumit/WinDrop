
#include <iostream>
#include <fstream>
#include <cstdio>
#include "sha256.h"

static int failures = 0;

void check(const std::string &label, const std::string &actual, const std::string &expected)
{
    if (actual == expected)
    {
        std::cout << "PASS: " << label << std::endl;
    }
    else
    {
        std::cout << "FAIL: " << label << "\n  expected: " << expected
                   << "\n  actual:   " << actual << std::endl;
        failures++;
    }
}

// Writes `content` to a temp file and returns its SHA-256 hash.
std::string hashOfContent(const std::string &path, const std::string &content)
{
    std::ofstream out(path, std::ios::binary);
    out << content;
    out.close();
    return WinDrop::computeSHA256(path);
}

int main()
{
    // Known SHA-256 test vectors (standard, widely published values).
    check(
        "empty file",
        hashOfContent("test_empty.tmp", ""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    check(
        "'abc'",
        hashOfContent("test_abc.tmp", "abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    check(
        "'The quick brown fox jumps over the lazy dog'",
        hashOfContent("test_fox.tmp", "The quick brown fox jumps over the lazy dog"),
        "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");

    // A one-byte change anywhere in the file must change the hash — this is
    // the property your checksum-mismatch detection actually depends on.
    std::string h1 = hashOfContent("test_diff1.tmp", "windrop transfer test data");
    std::string h2 = hashOfContent("test_diff2.tmp", "windrop transfer test datb"); // last char changed
    if (h1 != h2)
    {
        std::cout << "PASS: single-byte change produces a different hash" << std::endl;
    }
    else
    {
        std::cout << "FAIL: single-byte change produced the SAME hash — checksum verification is broken" << std::endl;
        failures++;
    }

    // Clean up temp files
    std::remove("test_empty.tmp");
    std::remove("test_abc.tmp");
    std::remove("test_fox.tmp");
    std::remove("test_diff1.tmp");
    std::remove("test_diff2.tmp");

    if (failures == 0)
    {
        std::cout << "\nAll SHA-256 tests passed." << std::endl;
        return 0;
    }
    else
    {
        std::cout << "\n" << failures << " SHA-256 test(s) failed." << std::endl;
        return 1;
    }
}