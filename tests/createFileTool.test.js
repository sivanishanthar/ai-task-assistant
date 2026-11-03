
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFile } from "../src/tools/createFileTool.js";

// TC005 - Create a file with a valid name
test("TC005 - Create a file with a valid name", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-file-test-")
    );

    try {
        const fileName = "testFile001.txt";
        const filePath = path.join(testWorkspace, fileName);

        const result = await createFile(fileName, testWorkspace);

        assert.match(result, /created successfully/i);

        const stats = await fs.stat(filePath);

        assert.equal(stats.isFile(), true);
        assert.equal(stats.size, 0);

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC006 - Reject invalid file names
test("TC006 - Reject invalid file names", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-file-test-")
    );

    try {
        await assert.rejects(
            createFile("../secret.txt", testWorkspace),
            /Invalid file name/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC007 - Reject duplicate file creation
test("TC007 - Reject duplicate file creation", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-file-test-")
    );

    try {
        const fileName = "duplicateTest001.txt";
        const filePath = path.join(testWorkspace, fileName);

        await createFile(fileName, testWorkspace);

        await assert.rejects(
            createFile(fileName, testWorkspace),
            { code: "EEXIST" }
        );

        const stats = await fs.stat(filePath);
        assert.equal(stats.isFile(), true);

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});
