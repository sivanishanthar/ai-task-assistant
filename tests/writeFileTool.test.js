
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFile } from "../src/tools/writeFileTool.js";

// TC011 - Write content to a new file
test("TC011 - Write content to a new file", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        const fileName = "TestNewFile.txt";
        const filePath = path.join(testWorkspace, fileName);

        const result = await writeFile(
            fileName,
            "Hello from automated testing!",
            testWorkspace
        );

        assert.match(result, /successfully written/i);

        const content = await fs.readFile(filePath, "utf8");

        assert.equal(content, "Hello from automated testing!");

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC012 - Write content to an existing empty file
test("TC012 - Write content to an existing empty file", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        const fileName = "TestEmptyFile.txt";
        const filePath = path.join(testWorkspace, fileName);

        await fs.writeFile(filePath, "");

        const result = await writeFile(
            fileName,
            "Playwright Test Plan",
            testWorkspace
        );

        assert.match(result, /successfully written/i);

        const content = await fs.readFile(filePath, "utf8");

        assert.equal(content, "Playwright Test Plan");

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC013 - Reject invalid filename
test("TC013 - Reject invalid filename", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        await assert.rejects(
            writeFile("../secret.txt", "Test content", testWorkspace),
            /Invalid file name/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC014 - Reject invalid content
test("TC014 - Reject invalid content", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        await assert.rejects(
            writeFile("TestInvalidContent.txt", 12345, testWorkspace),
            /Content must be a string/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC015 - Prevent overwriting an existing file
test("TC015 - Prevent overwriting an existing file", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        const fileName = "TestOverwrite.txt";
        const filePath = path.join(testWorkspace, fileName);

        await writeFile(
            fileName,
            "Original content",
            testWorkspace
        );

        await assert.rejects(
            writeFile(
                fileName,
                "Modified content",
                testWorkspace
            ),
            /Overwriting is not allowed/
        );

        const content = await fs.readFile(filePath, "utf8");

        assert.equal(content, "Original content");

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});


//
// TC023 - Reject writing to a directory
//
test("TC023 - Reject writing to a directory", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        // Create a directory with a valid file-like name
        const folderName = "TestDirectory.txt";
        const folderPath = path.join(testWorkspace, folderName);

        await fs.mkdir(folderPath);

        // Writing to a directory must be rejected
        await assert.rejects(
            writeFile(
                folderName,
                "This should not be written",
                testWorkspace
            ),
            /Overwriting is not allowed/
        );

        // Verify that the directory still exists
        const stats = await fs.stat(folderPath);

        assert.equal(stats.isDirectory(), true);

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

//
// TC024 - Reject writing through a symbolic link
//
test("TC024 - Reject writing through a symbolic link", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-write-test-")
    );

    try {
        const targetPath = path.join(
            testWorkspace,
            "OriginalFile.txt"
        );

        const linkPath = path.join(
            testWorkspace,
            "LinkedFile.txt"
        );

        // Create a target file with existing content
        await fs.writeFile(targetPath, "Protected content");

        // Create a symbolic link pointing to the target
        await fs.symlink(targetPath, linkPath);

        // Writing through the symbolic link must be rejected
        await assert.rejects(
            writeFile(
                "LinkedFile.txt",
                "Modified content",
                testWorkspace
            ),
            /Overwriting is not allowed/
        );

        // Ensure the original content remains unchanged
        const content = await fs.readFile(targetPath, "utf8");

        assert.equal(content, "Protected content");

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

