import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFile } from "../src/tools/writeFileTool.js";

async function fixture(t) {
    // macOS exposes /var through a system symlink; use its physical path.
    const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-write-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    return workspace;
}

test("TC011 - Write content to a new file", async t => {
    const workspace = await fixture(t);
    assert.equal(await writeFile("file.txt", "Hello ✓", workspace), "Content successfully written to 'file.txt'.");
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "Hello ✓");
    assert.deepEqual(await fs.readdir(workspace), ["file.txt"]);
});

test("TC012 - Reject an existing empty file (create-only policy)", async t => {
    const workspace = await fixture(t);
    await fs.writeFile(path.join(workspace, "file.txt"), "");
    await assert.rejects(writeFile("file.txt", "unsafe", workspace), /Overwriting is not allowed/);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "");
});

test("TC013 - Reject invalid filename", async t => {
    await assert.rejects(writeFile("../file.txt", "unsafe", await fixture(t)), /Invalid file name/);
});

test("TC014 - Reject invalid content", async t => {
    await assert.rejects(writeFile("file.txt", 123, await fixture(t)), /Content must be a string/);
});

test("TC015 - Prevent overwriting an existing file", async t => {
    const workspace = await fixture(t);
    await writeFile("file.txt", "PROTECTED", workspace);
    await assert.rejects(writeFile("file.txt", "unsafe", workspace), /Overwriting is not allowed/);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "PROTECTED");
});

test("TC023 - Reject writing to a directory", async t => {
    const workspace = await fixture(t);
    await fs.mkdir(path.join(workspace, "file.txt"));
    await assert.rejects(writeFile("file.txt", "unsafe", workspace), /Overwriting is not allowed/);
    assert.equal((await fs.stat(path.join(workspace, "file.txt"))).isDirectory(), true);
});

for (const content of ["PROTECTED", "", null]) {
    test(`TC024 - Reject a symbolic link with ${content === null ? "missing" : "existing"} target (${JSON.stringify(content)})`, async t => {
        const workspace = await fixture(t);
        const target = path.join(workspace, "target.txt");
        if (content !== null) await fs.writeFile(target, content);
        await fs.symlink(target, path.join(workspace, "file.txt"));
        await assert.rejects(writeFile("file.txt", "unsafe", workspace), /Overwriting is not allowed/);
        if (content === null) await assert.rejects(fs.stat(target), { code: "ENOENT" });
        else assert.equal(await fs.readFile(target, "utf8"), content);
    });
}

test("Create a missing workspace and accept empty content", async t => {
    const workspace = path.join(await fixture(t), "nested", "workspace");
    await writeFile("empty.txt", "", workspace);
    assert.equal(await fs.readFile(path.join(workspace, "empty.txt"), "utf8"), "");
    assert.deepEqual(await fs.readdir(workspace), ["empty.txt"]);
});

test("Simultaneous creates have one winner and preserve its complete content", async t => {
    const workspace = await fixture(t);
    const contents = ["a".repeat(200000), "b".repeat(200000), "c".repeat(200000)];
    const results = await Promise.allSettled(contents.map(content => writeFile("file.txt", content, workspace)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), contents[winner]);
    for (const result of results.filter(result => result.status === "rejected")) {
        assert.equal(result.reason.code, "EEXIST");
    }
    assert.deepEqual(await fs.readdir(workspace), ["file.txt"]);
});

test("Worker launch supports a caller using --input-type=module", async t => {
    const workspace = await fixture(t);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const moduleURL = new URL("../src/tools/writeFileTool.js", import.meta.url).href;
    const script = `import { writeFile } from ${JSON.stringify(moduleURL)}; await writeFile('file.txt', 'hello', process.argv[1]);`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, workspace]);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "hello");
});

for (const outcome of ["spawn-error", "send-error", "unexpected-exit", "worker-error"]) {
    test(`Worker transport propagates ${outcome}`, async t => {
        const { default: childProcess } = await import("node:child_process");
        const { EventEmitter } = await import("node:events");
        const failure = Object.assign(new Error("injected transport error"), { code: "EIO" });
        const child = new EventEmitter();
        let killed = false;
        child.kill = () => { killed = true; };
        child.send = (request, callback) => {
            queueMicrotask(() => {
                if (outcome === "spawn-error") return child.emit("error", failure);
                if (outcome === "send-error") return callback(failure);
                callback(null);
                if (outcome === "worker-error") child.emit("message", {
                    ok: false, message: "injected worker error", code: "EIO",
                    cleanupErrors: [{ message: "injected cleanup error" }]
                });
                child.emit("exit", 1, null);
            });
        };
        t.mock.method(childProcess, "fork", () => child);
        await assert.rejects(writeFile("file.txt", "hello", "/unused"), error => {
            if (["spawn-error", "send-error"].includes(outcome)) assert.equal(error, failure);
            if (outcome === "unexpected-exit") assert.match(error.message, /exited unexpectedly/);
            if (outcome === "worker-error") {
                assert.equal(error.code, "EIO");
                assert.equal(error.cleanupErrors[0].message, "injected cleanup error");
            }
            return true;
        });
        assert.equal(killed, outcome === "send-error");
    });
}

test("Default workspace argument still creates workspace in the caller's cwd", async t => {
    const root = await fixture(t);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const moduleURL = new URL("../src/tools/writeFileTool.js", import.meta.url).href;
    const script = `import { writeFile } from ${JSON.stringify(moduleURL)}; await writeFile('file.txt', 'default');`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    assert.equal(await fs.readFile(path.join(root, "workspace", "file.txt"), "utf8"), "default");
});
