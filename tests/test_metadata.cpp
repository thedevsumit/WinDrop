
#include <iostream>
#include <fstream>
#include <cstdio>
#include "metadata.h"

static int failures = 0;

void expect(const std::string &label, bool condition)
{
    if (condition)
    {
        std::cout << "PASS: " << label << std::endl;
    }
    else
    {
        std::cout << "FAIL: " << label << std::endl;
        failures++;
    }
}

int main()
{
    const std::string testFile = "test_resume_file";
    std::remove((testFile + ".part.meta").c_str());

    // 1. No metadata file exists yet -> should report -1, not crash or
    //    return a stale/garbage value.
    long long size = 0;
    int result = WinDrop::read_metadata(testFile, size);
    expect("read_metadata returns -1 when no checkpoint exists", result == -1);

    // 2. Round-trip: what we save should be exactly what we read back.
    WinDrop::save_metadata(testFile, 5000000, 1024, 42);
    long long readSize = 0;
    int readChunk = WinDrop::read_metadata(testFile, readSize);
    expect("read_metadata returns the chunk count that was saved", readChunk == 42);
    expect("read_metadata returns the total size that was saved", readSize == 5000000);

    // 3. A later save overwrites the earlier checkpoint (this is what your
    //    periodic buffer-flush relies on — each flush must fully replace the
    //    previous checkpoint, not append to it).
    WinDrop::save_metadata(testFile, 5000000, 1024, 100);
    long long readSize2 = 0;
    int readChunk2 = WinDrop::read_metadata(testFile, readSize2);
    expect("a second save_metadata overwrites (not appends) the checkpoint", readChunk2 == 100);

    // 4. Corrupted/incomplete checkpoint file -> should report -1, not throw
    //    or return an uninitialized value. This is the scenario your
    //    RESUME_STATE_INVALID error path depends on catching correctly.
    std::ofstream corrupt(testFile + ".part.meta");
    corrupt << "not-a-number\n";
    corrupt.close();
    long long readSize3 = 0;
    int readChunk3 = WinDrop::read_metadata(testFile, readSize3);
    expect("read_metadata returns -1 on a corrupted checkpoint file", readChunk3 == -1);

    std::remove((testFile + ".part.meta").c_str());

    if (failures == 0)
    {
        std::cout << "\nAll metadata tests passed." << std::endl;
        return 0;
    }
    else
    {
        std::cout << "\n" << failures << " metadata test(s) failed." << std::endl;
        return 1;
    }
}