import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFolder } from "../src/tools/folderTool.js";

// TC001 - Create a folder with a valid name
test("TC001 - Create a folder with a valid name", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-folder-test-")
    );

    try {
        const folderName = "TestFolder001";
        const folderPath = path.join(testWorkspace, folderName);

        const result = await createFolder(folderName, testWorkspace);

        assert.match(result, /created successfully/i);

        const stats = await fs.stat(folderPath);

        assert.equal(stats.isDirectory(), true);

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC002 - Reject folder names containing path traversal
test("TC002 - Reject folder names containing path traversal", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-folder-test-")
    );

    try {
        await assert.rejects(
            createFolder("../OutsideFolder", testWorkspace),
            /Invalid folder name/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC003 - Reject empty folder names
test("TC003 - Reject empty folder names", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-folder-test-")
    );

    try {
        await assert.rejects(
            createFolder("", testWorkspace),
            /Invalid folder name/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC004 - Reject folder names containing special characters
test("TC004 - Reject folder names containing special characters", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-folder-test-")
    );

    try {
        await assert.rejects(
            createFolder("Test@Folder", testWorkspace),
            /Invalid folder name/
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});