import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createFolder } from "../src/tools/folderTool.js";

const workspace = path.resolve("workspace");

test("TC001 - Create a folder with a valid name", async () => {

    const folderName = "TestFolder001";
    const folderPath = path.join(workspace, folderName);

    try {
        const result = await createFolder(folderName);

        assert.match(result, /created successfully/i);

        const stats = await fs.stat(folderPath);

        assert.equal(stats.isDirectory(), true);

    } finally {
        await fs.rm(folderPath, {
            recursive: true,
            force: true
        });
    }
});

test("TC002 - Reject folder names containing path traversal", async () => {

    await assert.rejects(
        createFolder("../OutsideFolder"),
        /Invalid folder name/
    );
});

test("TC003 - Reject empty folder names", async () => {

    await assert.rejects(
        createFolder(""),
        /Invalid folder name/
    );
});

test("TC004 - Reject folder names containing special characters", async () => {

    await assert.rejects(
        createFolder("Test@Folder"),
        /Invalid folder name/
    );
});