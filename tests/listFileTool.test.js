import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listFiles } from "../src/tools/listFilesTool.js";

// TC008 - Verify files and folders are listed correctly
test("TC008 - List files and folders in workspace", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-test-")
    );

    try {
        await fs.mkdir(
            path.join(testWorkspace, "TestFolder")
        );

        await fs.writeFile(
            path.join(testWorkspace, "TestFile.txt"),
            "Test content"
        );

        const result = await listFiles(testWorkspace);

        assert.ok(
            result.some(
                item =>
                    item.name === "TestFolder" &&
                    item.type === "folder"
            )
        );

        assert.ok(
            result.some(
                item =>
                    item.name === "TestFile.txt" &&
                    item.type === "file"
            )
        );

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC009 - Verify the return type is an array
test("TC009 - Verify listFiles returns an array", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-test-")
    );

    try {
        const result = await listFiles(testWorkspace);

        assert.ok(Array.isArray(result));

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC010 - Verify file and folder metadata
test("TC010 - Verify file and folder information", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-test-")
    );

    try {
        await fs.mkdir(
            path.join(testWorkspace, "TestFolder")
        );

        await fs.writeFile(
            path.join(testWorkspace, "TestFile.txt"),
            "Test content"
        );

        const result = await listFiles(testWorkspace);

        assert.equal(result.length, 2);

        for (const item of result) {

            assert.equal(typeof item.name, "string");

            assert.ok(
                item.type === "file" ||
                item.type === "folder"
            );
        }

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});

// TC022 - Verify empty workspace behavior
test("TC022 - List files returns an array for an empty workspace", async () => {

    const testWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-agent-test-")
    );

    try {
        const result = await listFiles(testWorkspace);

        assert.deepEqual(result, []);

    } finally {
        await fs.rm(testWorkspace, {
            recursive: true,
            force: true
        });
    }
});