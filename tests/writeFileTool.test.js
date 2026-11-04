
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


// Each hook runs at a precise operation boundary; no timer-based races.
async function safetyWorkspace(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ai-agent-safety-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    return workspace;
}

for (const dangling of [false, true]) {
    test(`Reject a symlink to an ${dangling ? "absent" : "empty"} target`, async (t) => {
        const workspace = await safetyWorkspace(t);
        const target = path.join(workspace, "target.txt");
        if (!dangling) await fs.writeFile(target, "");
        await fs.symlink(target, path.join(workspace, "link.txt"));
        await assert.rejects(writeFile("link.txt", "unsafe", workspace), /Overwriting is not allowed/);
        if (dangling) await assert.rejects(fs.stat(target), { code: "ENOENT" });
        else assert.equal(await fs.readFile(target, "utf8"), "");
    });
}

for (const replacement of ["symlink", "file", "removed", "grown"]) {
    test(`Reject entry ${replacement} after lstat`, async (t) => {
        const workspace = await safetyWorkspace(t);
        const file = path.join(workspace, "file.txt");
        const target = path.join(workspace, "target.txt");
        await fs.writeFile(file, "");
        await fs.writeFile(target, "");
        const originalLstat = fs.lstat.bind(fs);
        t.mock.method(fs, "lstat", async (...args) => {
            const stats = await originalLstat(...args);
            if (args[0] === file) {
                if (replacement === "grown") await fs.writeFile(file, "protected");
                else {
                    // Keep the original inode alive so identity cannot be recycled.
                    await fs.rename(file, path.join(workspace, "original.txt"));
                    if (replacement === "symlink") await fs.symlink(target, file);
                    if (replacement === "file") await fs.writeFile(file, "");
                }
            }
            return stats;
        });
        await assert.rejects(writeFile("file.txt", "unsafe", workspace), (error) => {
            if (replacement === "symlink") return error.code === "ELOOP";
            if (replacement === "removed") return error.code === "ENOENT";
            return /same empty regular file/.test(error.message);
        });
        assert.equal(await fs.readFile(target, "utf8"), "");
        if (replacement === "file") assert.equal(await fs.readFile(file, "utf8"), "");
        if (replacement === "grown") assert.equal(await fs.readFile(file, "utf8"), "protected");
    });
}

for (const stage of ["mkdir", "open", "lstat", "existingOpen", "stat", "writeFile", "close"]) {
    test(`Propagate ${stage} failure and close acquired handles`, async (t) => {
        const workspace = await safetyWorkspace(t);
        const failure = Object.assign(new Error(`injected ${stage}`), {
            // EEXIST from a write/close must never trigger the open fallback.
            code: ["writeFile", "close"].includes(stage) ? "EEXIST" : "EIO"
        });
        let closes = 0;
        let opens = 0;
        const stats = { isFile: () => true, size: 0, dev: 1, ino: 2 };
        const existing = ["lstat", "existingOpen", "stat"].includes(stage);
        const handle = {
            async stat() { if (stage === "stat") throw failure; return stats; },
            async writeFile() { if (stage === "writeFile") throw failure; },
            async close() { closes++; if (stage === "close") throw failure; }
        };
        if (stage === "mkdir") t.mock.method(fs, "mkdir", async () => { throw failure; });
        t.mock.method(fs, "open", async () => {
            opens++;
            if (stage === "open" || (stage === "existingOpen" && opens === 2)) throw failure;
            if (existing && opens === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
            return handle;
        });
        t.mock.method(fs, "lstat", async () => {
            if (stage === "lstat") throw failure;
            return stats;
        });
        await assert.rejects(writeFile("file.txt", "content", workspace), error => error === failure);
        assert.equal(closes, ["stat", "writeFile", "close"].includes(stage) ? 1 : 0);
        if (["writeFile", "close"].includes(stage)) assert.equal(opens, 1);
    });
}

test("Create a missing workspace and accept empty content", async (t) => {
    const workspace = path.join(await safetyWorkspace(t), "nested", "workspace");
    await writeFile("empty.txt", "", workspace);
    assert.equal(await fs.readFile(path.join(workspace, "empty.txt"), "utf8"), "");
});
