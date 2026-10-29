import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { writeFile } from "../src/tools/writeFileTool.js";

const workspace = path.resolve("workspace");

// Generate a unique filename for each test
function getTestFileName() {
    return `Test_${randomUUID()}.txt`;
}

// TC011 - Write content to a new file
test("TC011 - Write content to a new file", async () => {

    const fileName = getTestFileName();
    const filePath = path.join(workspace, fileName);

    try {
        const result = await writeFile(
            fileName,
            "Hello from automated testing!"
        );

        assert.match(result, /successfully written/i);

        const content = await fs.readFile(filePath, "utf8");

        assert.equal(content, "Hello from automated testing!");

    } finally {
        await fs.rm(filePath, { force: true });
    }
});

// TC012 - Write content to an existing empty file
test("TC012 - Write content to an existing empty file", async () => {

    const fileName = getTestFileName();
    const filePath = path.join(workspace, fileName);

    try {
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(filePath, "");

        await writeFile(fileName, "Playwright Test Plan");

        const content = await fs.readFile(filePath, "utf8");

        assert.equal(content, "Playwright Test Plan");

    } finally {
        await fs.rm(filePath, { force: true });
    }
});

// TC013 - Reject invalid filename
test("TC013 - Reject invalid filename", async () => {

    await assert.rejects(
        writeFile("../secret.txt", "Test content"),
        /Invalid file name/
    );
});

// TC014 - Reject invalid content
test("TC014 - Reject invalid content", async () => {

    await assert.rejects(
        writeFile(getTestFileName(), 12345),
        /Content must be a string/
    );
});

// TC015 - Prevent overwriting an existing file
test("TC015 - Prevent overwriting an existing file", async () => {

    const fileName = getTestFileName();
    const filePath = path.join(workspace, fileName);

    try {
        await writeFile(fileName, "Original content");

        await assert.rejects(
            writeFile(fileName, "Modified content"),
            /Overwriting is not allowed/
        );

        const content = await fs.readFile(filePath, "utf8");

        assert.equal(content, "Original content");

    } finally {
        await fs.rm(filePath, { force: true });
    }
});