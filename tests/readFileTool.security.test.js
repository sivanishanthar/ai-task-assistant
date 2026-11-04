import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "../src/tools/readFileTool.js";
import { readInWorkspace } from "../src/tools/readFileWorker.js";
import { constants } from "node:fs";

const LIMIT = 100 * 1024;

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-read-security-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    return { root, workspace, outside };
}

// Only tests call the internal worker in-process, serially. Production runs
// it in a child process. Every injection runs at an exact operation boundary.
async function runInternal(workspace, io) {
    const cwd = process.cwd();
    try {
        return await readInWorkspace({ workspace, fileName: "file.txt" }, io);
    } finally {
        process.chdir(cwd);
    }
}
test("Read security: reject traversal and malformed names before filesystem access", async t => {
    const { workspace } = await fixture(t);
    let calls = 0;
    t.mock.method(fs, "lstat", async () => { calls++; throw new Error("unexpected lstat"); });
    t.mock.method(fs, "readFile", async () => { calls++; throw new Error("unexpected read"); });
    for (const name of ["../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:\\escape.txt",
        "nested/file.txt", "nested\\file.txt", "file.txt/../escape.txt", "file.txt\0",
        "file.txt\n", "file.txt\r\n", "", ".", "..", "%2e%2e%2fescape.txt", null, undefined, 42, {}]) {
        await assert.rejects(readFile(name, workspace), /Invalid file name/);
    }
    assert.equal(calls, 0);
});

for (const dangling of [false, true]) {
    test(`Read security: reject an existing ${dangling ? "dangling" : "outside-target"} file symlink`, async t => {
        const { workspace, outside } = await fixture(t);
        const target = path.join(outside, "secret.txt");
        if (!dangling) await fs.writeFile(target, "SECRET");
        await fs.symlink(target, path.join(workspace, "file.txt"));
        await assert.rejects(readFile("file.txt", workspace), /not a regular file/);
    });
}

for (const ancestor of [false, true]) {
    test(`Read security: reject a symlink at the workspace ${ancestor ? "ancestor" : "leaf"}`, async t => {
        const { root, outside } = await fixture(t);
        const linked = path.join(root, "linked");
        await fs.symlink(outside, linked);
        const targetDirectory = ancestor ? path.join(outside, "nested") : outside;
        if (ancestor) await fs.mkdir(targetDirectory);
        await fs.writeFile(path.join(targetDirectory, "file.txt"), "SECRET");
        await assert.rejects(readFile("file.txt", ancestor ? path.join(linked, "nested") : linked),
            /symbolic links/);
    });
}

test("Read security: reject file replacement with an outside symlink after lstat", async t => {
    const { workspace, outside } = await fixture(t);
    const file = path.join(workspace, "file.txt");
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(file, "safe");
    await fs.writeFile(secret, "SECRET");
    const lstat = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", async (...args) => {
        const stats = await lstat(...args);
        if (args[0] === "file.txt") {
            await fs.rename(file, path.join(workspace, "original.txt"));
            await fs.symlink(secret, file);
        }
        return stats;
    });
    await assert.rejects(runInternal(workspace), { code: "ELOOP" });
});

test("Read security: workspace replacement after lstat cannot redirect the pinned read", async t => {
    const { root, workspace, outside } = await fixture(t);
    const file = path.join(workspace, "file.txt");
    await fs.writeFile(file, "safe");
    await fs.writeFile(path.join(outside, "file.txt"), "SECRET");
    const lstat = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", async (...args) => {
        const stats = await lstat(...args);
        if (args[0] === "file.txt") {
            await fs.rename(workspace, path.join(root, "original-workspace"));
            await fs.symlink(outside, workspace);
        }
        return stats;
    });
    assert.equal(await runInternal(workspace), "safe");
});

for (const replacement of [false, true]) {
    test(`Read security: enforce byte limit after ${replacement ? "inode replacement" : "same-inode growth"}`, async t => {
        const { workspace } = await fixture(t);
        const file = path.join(workspace, "file.txt");
        await fs.writeFile(file, "safe");
        const lstat = fs.lstat.bind(fs);
        t.mock.method(fs, "lstat", async (...args) => {
            const stats = await lstat(...args);
            if (args[0] === "file.txt") {
                if (replacement) await fs.rename(file, path.join(workspace, "original.txt"));
                await fs.writeFile(file, "A".repeat(LIMIT + 1));
            }
            return stats;
        });
        await assert.rejects(runInternal(workspace), /100 KB reading limit/);
    });
}

test("Read security: reject a hard link to an outside file", async t => {
    const { workspace, outside } = await fixture(t);
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "SECRET");
    await fs.link(secret, path.join(workspace, "file.txt"));
    await assert.rejects(readFile("file.txt", workspace), /multiple hard links/);
});

test("Read safety: accept exactly 100 KB, measured in UTF-8 bytes", async t => {
    const { workspace } = await fixture(t);
    const file = path.join(workspace, "file.txt");
    const content = "é".repeat(LIMIT / 2);
    assert.equal(Buffer.byteLength(content), LIMIT);
    await fs.writeFile(file, content);
    assert.equal(await readFile("file.txt", workspace), content);
    await fs.appendFile(file, "a");
    await assert.rejects(readFile("file.txt", workspace), /100 KB reading limit/);
});

for (const stage of ["lstat", "open", "stat", "read", "close"]) {
    test(`Read errors: propagate ${stage} failure and close acquired file handle`, async t => {
        const { workspace } = await fixture(t);
        await fs.writeFile(path.join(workspace, "file.txt"), "safe");
        const failure = Object.assign(new Error(`injected ${stage}`), { code: "EIO" });
        let closes = 0;
        if (stage === "lstat") {
            const lstat = fs.lstat.bind(fs);
            t.mock.method(fs, "lstat", async (...args) => {
                if (args[0] === "file.txt") throw failure;
                return lstat(...args);
            });
        }
        const open = fs.open.bind(fs);
        t.mock.method(fs, "open", async (...args) => {
            if (args[0] === "file.txt" && stage === "open") throw failure;
            const handle = await open(...args);
            if (args[0] !== "file.txt") return handle;
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => {
                closes++;
                await close();
                if (stage === "close") throw failure;
            });
            if (stage === "stat" || stage === "read") {
                t.mock.method(handle, stage, async () => { throw failure; });
            }
            return handle;
        });
        await assert.rejects(runInternal(workspace), error => error === failure);
        assert.equal(closes, ["stat", "read", "close"].includes(stage) ? 1 : 0);
    });
}

test("Read security: enforce the byte limit when the opened inode grows after stat", async t => {
    const { workspace } = await fixture(t);
    const file = path.join(workspace, "file.txt");
    await fs.writeFile(file, "safe");
    const open = fs.open.bind(fs);
    let bytesRead = 0;
    let closes = 0;
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] !== "file.txt") return handle;
        const stat = handle.stat.bind(handle);
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        let first = true;
        t.mock.method(handle, "stat", async () => {
            const stats = await stat();
            if (first) {
                first = false;
                await fs.appendFile(file, "a".repeat(LIMIT));
            }
            return stats;
        });
        t.mock.method(handle, "read", async (...readArgs) => {
            const result = await read(...readArgs);
            bytesRead += result.bytesRead;
            return result;
        });
        t.mock.method(handle, "close", async () => { closes++; await close(); });
        return handle;
    });
    await assert.rejects(runInternal(workspace), /100 KB reading limit/);
    assert.equal(bytesRead, LIMIT + 1);
    assert.equal(closes, 1);
});

test("Read security: reject replacement by another small regular file before open", async t => {
    const { workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, "file.txt"), "safe");
    const lstat = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", async (...args) => {
        const stats = await lstat(...args);
        if (args[0] === "file.txt") {
            // Keep the original inode alive so the number cannot be recycled.
            await fs.rename("file.txt", "original.txt");
            await fs.writeFile("file.txt", "replacement");
        }
        return stats;
    });
    await assert.rejects(runInternal(workspace), /changed while opening/);
});

test("Read security: a path symlink replacement after open cannot redirect the handle", async t => {
    const { workspace, outside } = await fixture(t);
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(path.join(workspace, "file.txt"), "safe");
    await fs.writeFile(target, "SECRET");
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] === "file.txt") {
            await fs.rename("file.txt", "original.txt");
            await fs.symlink(target, "file.txt");
        }
        return handle;
    });
    assert.equal(await runInternal(workspace), "safe");
});

test("Read security: refuse a nonregular replacement with nonblocking open flags", async t => {
    const { workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, "file.txt"), "safe");
    const open = fs.open.bind(fs);
    let closes = 0;
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] !== "file.txt") return handle;
        assert.ok((args[1] & constants.O_NOFOLLOW) !== 0);
        assert.ok((args[1] & constants.O_NONBLOCK) !== 0);
        const close = handle.close.bind(handle);
        t.mock.method(handle, "stat", async () => ({ isFile: () => false }));
        t.mock.method(handle, "read", async () => { assert.fail("nonregular file must not be read"); });
        t.mock.method(handle, "close", async () => { closes++; await close(); });
        return handle;
    });
    await assert.rejects(runInternal(workspace), /not a regular file/);
    assert.equal(closes, 1);
});

test("Read safety: short reads preserve UTF-8 sequences across chunk boundaries", async t => {
    const { workspace } = await fixture(t);
    const content = "hello é 🚀 world";
    await fs.writeFile(path.join(workspace, "file.txt"), content);
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] !== "file.txt") return handle;
        const read = handle.read.bind(handle);
        t.mock.method(handle, "read", (buffer, offset, length, position) =>
            read(buffer, offset, Math.min(length, 3), position));
        return handle;
    });
    assert.equal(await runInternal(workspace), content);
});

test("Read security: reject detected same-size content modification during read", async t => {
    const { workspace } = await fixture(t);
    const file = path.join(workspace, "file.txt");
    await fs.writeFile(file, "safe");
    await fs.utimes(file, new Date(0), new Date(0));
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] !== "file.txt") return handle;
        const read = handle.read.bind(handle);
        let first = true;
        t.mock.method(handle, "read", async (...readArgs) => {
            if (first) {
                first = false;
                await fs.writeFile(file, "evil");
            }
            return read(...readArgs);
        });
        return handle;
    });
    await assert.rejects(runInternal(workspace), /changed while reading/);
});

test("Read errors: preserve the primary read error if close also fails", async t => {
    const { workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, "file.txt"), "safe");
    const primary = new Error("read failed");
    const cleanup = new Error("close failed");
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] !== "file.txt") return handle;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "read", async () => { throw primary; });
        t.mock.method(handle, "close", async () => { await close(); throw cleanup; });
        return handle;
    });
    await assert.rejects(runInternal(workspace), error => {
        assert.equal(error, primary);
        assert.deepEqual(error.cleanupErrors, [cleanup]);
        return true;
    });
});

test("Read safety: a missing workspace is not created", async t => {
    const { root } = await fixture(t);
    const missing = path.join(root, "missing");
    await assert.rejects(readFile("file.txt", missing), { code: "ENOENT" });
    await assert.rejects(fs.stat(missing), { code: "ENOENT" });
});

test("Read security: reject a workspace writable by other accounts", async t => {
    const { workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, "file.txt"), "safe");
    await fs.chmod(workspace, 0o777);
    await assert.rejects(readFile("file.txt", workspace), /not writable by group or others/);
});

test("Read security: validate the worker IPC input independently", async t => {
    const { workspace } = await fixture(t);
    await assert.rejects(readInWorkspace({ fileName: "../file.txt", workspace }), /Invalid file name/);
    await assert.rejects(readInWorkspace({ fileName: "file.txt", workspace: "relative" }), /normalized absolute path/);
});

test("Read safety: default workspace and eval callers preserve API and parent cwd", async t => {
    const { root, workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, "file.txt"), "default content");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const moduleURL = new URL("../src/tools/readFileTool.js", import.meta.url).href;
    const script = `import { readFile } from ${JSON.stringify(moduleURL)}; const cwd = process.cwd(); const content = await readFile('file.txt'); if (process.cwd() !== cwd) throw new Error('cwd changed'); process.stdout.write(content);`;
    const { stdout } = await promisify(execFile)(process.execPath,
        ["--input-type", "module", "-e", script], { cwd: root });
    assert.equal(stdout, "default content");
});

for (const outcome of ["spawn-error", "send-error", "unexpected-exit", "worker-error", "invalid-content"]) {
    test(`Read worker transport propagates ${outcome}`, async t => {
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
                if (outcome === "invalid-content") child.emit("message", { ok: true, content: 123 });
                child.emit("exit", outcome === "invalid-content" ? 0 : 1, null);
            });
        };
        t.mock.method(childProcess, "fork", () => child);
        await assert.rejects(readFile("file.txt", "/unused"), error => {
            if (["spawn-error", "send-error"].includes(outcome)) assert.equal(error, failure);
            if (["unexpected-exit", "invalid-content"].includes(outcome)) assert.match(error.message, /exited unexpectedly/);
            if (outcome === "worker-error") {
                assert.equal(error.code, "EIO");
                assert.equal(error.cleanupErrors[0].message, "injected cleanup error");
            }
            return true;
        });
        assert.equal(killed, outcome === "send-error");
    });
}
