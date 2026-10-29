import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createFile } from "../src/tools/createFileTool.js";

const workspace = path.resolve("workspace");

test("TC005 - Create a file with a valid name", async () => {

    const fileName = "testFile001.txt";
    const filePath = path.join(workspace, fileName);

    try {
        const result = await createFile(fileName);

        assert.match(result, /created successfully/i);

        const stats = await fs.stat(filePath);

        assert.equal(stats.isFile(), true);

    } finally {
        await fs.rm(filePath, { force: true });
    }
});

test("TC006 - Reject invalid file names", async () => {

    await assert.rejects(
        createFile("../secret.txt"),
        /Invalid file name/
    );
});

test("TC007 - Reject duplicate file creation", async () => {

    const fileName = "duplicateTest001.txt";
    const filePath = path.join(workspace, fileName);

    try {
        await createFile(fileName);

        await assert.rejects(
            createFile(fileName),
            { code: "EEXIST" }
        );

    } finally {
        await fs.rm(filePath, { force: true });
    }
});