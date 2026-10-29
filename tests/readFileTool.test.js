import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readFile } from "../src/tools/readFileTool.js";

const workspace = path.resolve("workspace");

// Generate a unique filename for each test
function getTestFileName() {
    return `Test_${randomUUID()}.txt`;
}

// TC016 - Read an existing file
test("TC016 - Read an existing file", async () => {

    const fileName = getTestFileName();
    const filePath = path.join(workspace, fileName);

    try {
        await fs.mkdir(workspace, { recursive: true });

        await fs.writeFile(
            filePath,
            "Playwright Automation Test Plan"
        );

        const content = await readFile(fileName);

        assert.equal(
            content,
            "Playwright Automation Test Plan"
        );

    } finally {
        await fs.rm(filePath, { force: true });
    }
});

// TC017 - Read a nonexistent file
test("TC017 - Read a nonexistent file", async () => {

    const fileName = getTestFileName();

    await assert.rejects(
        readFile(fileName),
        { code: "ENOENT" }
    );
});

// TC018 - Reject invalid filename
test("TC018 - Reject invalid filename", async () => {

    await assert.rejects(
        readFile("../secret.txt"),
        /Invalid file name/
    );
});

// TC019 - Reject reading a directory
test("TC019 - Reject reading a directory", async () => {

    const folderName = `TestFolder_${randomUUID()}.txt`;
    const folderPath = path.join(workspace, folderName);

    try {
        await fs.mkdir(folderPath, { recursive: true });

        await assert.rejects(
            readFile(folderName),
            /not a regular file/
        );

    } finally {
        await fs.rm(folderPath, {
            recursive: true,
            force: true
        });
    }
});

// TC020 - Reject files larger than 100 KB
test("TC020 - Reject files larger than 100 KB", async () => {

    const fileName = getTestFileName();
    const filePath = path.join(workspace, fileName);

    try {
        await fs.mkdir(workspace, { recursive: true });

        // Create a 101 KB file
        const largeContent = "A".repeat(101 * 1024);

        await fs.writeFile(filePath, largeContent);

        await assert.rejects(
            readFile(fileName),
            /100 KB reading limit/
        );

    } finally {
        await fs.rm(filePath, { force: true });
    }
});

// TC021 - Read an empty file
test("TC021 - Read an empty file", async () => {

    const fileName = getTestFileName();
    const filePath = path.join(workspace, fileName);

    try {
        await fs.mkdir(workspace, { recursive: true });

        await fs.writeFile(filePath, "");

        const content = await readFile(fileName);

        assert.equal(content, "");

    } finally {
        await fs.rm(filePath, { force: true });
    }
});