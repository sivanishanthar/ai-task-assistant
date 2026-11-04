
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFile } from "../src/tools/readFileTool.js";

// TC016 - Read an existing file
test("TC016 - Read an existing file", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "ai-agent-read-test-")
    );

    try {
        const fileName = "TestExistingFile.txt";
        const filePath = path.join(testWorkspace, fileName);

        await fs.writeFile(
            filePath,
            "Playwright Automation Test Plan"
        );

        const content = await readFile(fileName, testWorkspace);

        assert.equal(
            content,
            "Playwright Automation Test Plan"
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC017 - Read a nonexistent file
test("TC017 - Read a nonexistent file", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "ai-agent-read-test-")
    );

    try {
        await assert.rejects(
            readFile("NonexistentFile.txt", testWorkspace),
            { code: "ENOENT" }
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC018 - Reject invalid filename
test("TC018 - Reject invalid filename", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "ai-agent-read-test-")
    );

    try {
        await assert.rejects(
            readFile("../secret.txt", testWorkspace),
            /Invalid file name/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC019 - Reject reading a directory
test("TC019 - Reject reading a directory", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "ai-agent-read-test-")
    );

    try {
        // Directory has a .txt extension to pass filename validation
        const folderName = "TestDirectory.txt";
        const folderPath = path.join(testWorkspace, folderName);

        await fs.mkdir(folderPath);

        await assert.rejects(
            readFile(folderName, testWorkspace),
            /not a regular file/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC020 - Reject files larger than 100 KB
test("TC020 - Reject files larger than 100 KB", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "ai-agent-read-test-")
    );

    try {
        const fileName = "TestLargeFile.txt";
        const filePath = path.join(testWorkspace, fileName);

        // Create a 101 KB file
        const largeContent = "A".repeat(101 * 1024);

        await fs.writeFile(filePath, largeContent);

        await assert.rejects(
            readFile(fileName, testWorkspace),
            /100 KB reading limit/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC021 - Read an empty file
test("TC021 - Read an empty file", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "ai-agent-read-test-")
    );

    try {
        const fileName = "TestEmptyFile.txt";
        const filePath = path.join(testWorkspace, fileName);

        await fs.writeFile(filePath, "");

        const content = await readFile(fileName, testWorkspace);

        assert.equal(content, "");

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});
