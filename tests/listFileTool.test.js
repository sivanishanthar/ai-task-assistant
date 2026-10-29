import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { listFiles } from "../src/tools/listFilesTool.js";

const workspace = path.resolve("workspace");

// Create unique names to avoid conflicts with existing files.
const testId = randomUUID();

test("TC008 - List files and folders in workspace", async () => {

    const folderName = `TestFolder_${testId}`;
    const fileName = `TestFile_${testId}.txt`;

    const folderPath = path.join(workspace, folderName);
    const filePath = path.join(workspace, fileName);

    try {
        await fs.mkdir(workspace, { recursive: true });

        await fs.mkdir(folderPath);
        await fs.writeFile(filePath, "Test content");

        const result = await listFiles();

        assert.ok(
            result.some(
                item =>
                    item.name === folderName &&
                    item.type === "folder"
            )
        );

        assert.ok(
            result.some(
                item =>
                    item.name === fileName &&
                    item.type === "file"
            )
        );

    } finally {

        await fs.rm(folderPath, {
            recursive: true,
            force: true
        });

        await fs.rm(filePath, {
            force: true
        });
    }
});

test("TC009 - Verify listFiles returns an array", async () => {

    const result = await listFiles();

    assert.ok(Array.isArray(result));
});

test("TC010 - Verify file and folder information", async () => {

    const result = await listFiles();

    for (const item of result) {

        assert.equal(typeof item.name, "string");

        assert.ok(
            item.type === "file" ||
            item.type === "folder"
        );
    }
});