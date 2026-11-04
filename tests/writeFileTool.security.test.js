import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFile } from "../src/tools/writeFileTool.js";
import { writeInWorkspace } from "../src/tools/writeFileWorker.js";

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-security-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    return { root, workspace, outside };
}

// Only tests call the internal worker in-process, serially. Production always
// uses a separate process. Restore cwd even when injected operations fail.
async function runInternal(workspace, content = "unsafe", io) {
    const cwd = process.cwd();
    try {
        return await writeInWorkspace({ workspace, fileName: "file.txt", content }, io);
    } finally {
        process.chdir(cwd);
    }
}

test("Security: reject traversal and malformed names before filesystem access", async t => {
    const { workspace } = await fixture(t);
    for (const name of ["../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:\\escape.txt",
        "nested/file.txt", "nested\\file.txt", "file.txt/../escape.txt", "file.txt\0",
        "file.txt\n", "file.txt\r\n", "", ".", "..", "%2e%2e%2fescape.txt", null, undefined, 42, {}]) {
        await assert.rejects(writeFile(name, "unsafe", workspace), /Invalid file name/);
    }
    assert.deepEqual(await fs.readdir(workspace), []);
});

for (const suffix of ["", "/nested"]) {
    test(`Security: reject symlink in workspace path (${suffix || "leaf"})`, async t => {
        const { root, outside } = await fixture(t);
        const linked = path.join(root, "linked");
        await fs.symlink(outside, linked);
        await assert.rejects(writeFile("file.txt", "unsafe", linked + suffix), /symbolic links/);
        assert.deepEqual(await fs.readdir(outside), []);
    });
}

test("Security: workspace replacement after mkdir must not redirect writes", async t => {
    const { root, outside } = await fixture(t);
    const workspace = path.join(root, "new-workspace");
    const mkdir = fs.mkdir.bind(fs);
    t.mock.method(fs, "mkdir", async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === "new-workspace") {
            await fs.rename("new-workspace", "original-workspace");
            await fs.symlink(outside, "new-workspace");
        }
        return result;
    });
    await assert.rejects(runInternal(workspace), /symbolic links/);
    assert.deepEqual(await fs.readdir(outside), []);
});

test("Security: reject replacement between directory open and chdir", async t => {
    const { workspace, outside } = await fixture(t);
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] === "workspace") {
            const stat = handle.stat.bind(handle);
            t.mock.method(handle, "stat", async (...statArgs) => {
                const stats = await stat(...statArgs);
                await fs.rename("workspace", "original-workspace");
                await fs.symlink(outside, "workspace");
                return stats;
            });
        }
        return handle;
    });
    await assert.rejects(runInternal(workspace), /directory changed/);
    assert.deepEqual(await fs.readdir(outside), []);
});

test("Security: cwd remains pinned after workspace pathname replacement", async t => {
    const { root, workspace, outside } = await fixture(t);
    const mkdtemp = fs.mkdtemp.bind(fs);
    t.mock.method(fs, "mkdtemp", async (...args) => {
        await fs.rename(workspace, path.join(root, "original-workspace"));
        await fs.symlink(outside, workspace);
        return mkdtemp(...args);
    });
    await runInternal(workspace);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(await fs.readFile(path.join(root, "original-workspace", "file.txt"), "utf8"), "unsafe");
});

test("Security: reject an empty hard link to a file outside workspace", async t => {
    const { workspace, outside } = await fixture(t);
    const target = path.join(outside, "protected.txt");
    await fs.writeFile(target, "");
    await fs.link(target, path.join(workspace, "file.txt"));
    await assert.rejects(writeFile("file.txt", "unsafe", workspace), /Overwriting is not allowed/);
    assert.equal(await fs.readFile(target, "utf8"), "");
});

for (const kind of ["data", "empty", "symlink", "directory"]) {
    test(`Security: atomic publication rejects a concurrently created ${kind} destination`, async t => {
        const { workspace, outside } = await fixture(t);
        const target = path.join(outside, "protected.txt");
        await fs.writeFile(target, "PROTECTED");
        const link = fs.link.bind(fs);
        t.mock.method(fs, "link", async (...args) => {
            if (kind === "data") await fs.writeFile("file.txt", "PROTECTED");
            if (kind === "empty") await fs.writeFile("file.txt", "");
            if (kind === "symlink") await fs.symlink(target, "file.txt");
            if (kind === "directory") await fs.mkdir("file.txt");
            return link(...args);
        });
        await assert.rejects(runInternal(workspace), /Overwriting is not allowed/);
        assert.equal(await fs.readFile(target, "utf8"), "PROTECTED");
        if (kind === "data" || kind === "empty") {
            assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), kind === "data" ? "PROTECTED" : "");
        }
        assert.deepEqual(await fs.readdir(workspace), ["file.txt"]);
    });
}

test("Security: existing empty destination is never opened or statted", async t => {
    const { workspace } = await fixture(t);
    const file = path.join(workspace, "file.txt");
    await fs.writeFile(file, "");
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        assert.notEqual(path.basename(args[0]), "file.txt");
        return open(...args);
    });
    const lstat = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", async (...args) => {
        assert.notEqual(args[0], "file.txt");
        return lstat(...args);
    });
    await assert.rejects(runInternal(workspace), /Overwriting is not allowed/);
    assert.equal(await fs.readFile(file, "utf8"), "");
});

for (const stage of ["lstat", "mkdir", "mkdtemp", "open", "writeFile", "close", "link"]) {
    test(`Error: propagate ${stage} failure, close handles, clean staging`, async t => {
        const { workspace } = await fixture(t);
        const failure = Object.assign(new Error(`injected ${stage}`), { code: "EIO" });
        let closes = 0;
        if (["lstat", "mkdir", "mkdtemp", "link"].includes(stage)) {
            t.mock.method(fs, stage, async () => { throw failure; });
        }
        const open = fs.open.bind(fs);
        t.mock.method(fs, "open", async (...args) => {
            const isPayload = args[0].endsWith("/content");
            if (stage === "open" && isPayload) throw failure;
            const handle = await open(...args);
            if (!isPayload) return handle;
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => {
                closes++;
                await close();
                if (stage === "close") throw failure;
            });
            if (stage === "writeFile") t.mock.method(handle, "writeFile", async () => { throw failure; });
            return handle;
        });
        const directory = stage === "mkdir" ? path.join(workspace, "missing") : workspace;
        await assert.rejects(runInternal(directory), error => error === failure);
        if (["writeFile", "close", "link"].includes(stage)) assert.equal(closes, 1);
        assert.deepEqual(await fs.readdir(workspace), []);
    });
}

test("Security: fail closed on unsupported Windows directory semantics", async t => {
    const { workspace } = await fixture(t);
    await assert.rejects(runInternal(workspace, "unsafe", { fs, process: { platform: "win32" } }), /macOS or Linux/);
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("Security: reject a workspace writable by other accounts", async t => {
    const { workspace } = await fixture(t);
    await fs.chmod(workspace, 0o777);
    await assert.rejects(writeFile("file.txt", "unsafe", workspace), /not writable by group or others/);
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("Security: published content has owner-only permissions", async t => {
    const { workspace } = await fixture(t);
    await writeFile("file.txt", "private", workspace);
    assert.equal((await fs.stat(path.join(workspace, "file.txt"))).mode & 0o777, 0o600);
});

test("Error: keep the primary write error when close and staging cleanup also fail", async t => {
    const { workspace } = await fixture(t);
    const primary = new Error("primary write failure");
    const closeFailure = new Error("close failure");
    const cleanupFailure = new Error("cleanup failure");
    const open = fs.open.bind(fs);
    const rm = fs.rm.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (!args[0].endsWith("/content")) return handle;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "writeFile", async () => { throw primary; });
        t.mock.method(handle, "close", async () => { await close(); throw closeFailure; });
        return handle;
    });
    t.mock.method(fs, "rm", async (...args) => {
        if (args[0].startsWith(".ai-write-")) {
            await rm(...args);
            throw cleanupFailure;
        }
        return rm(...args);
    });
    await assert.rejects(runInternal(workspace), error => {
        assert.equal(error, primary);
        assert.deepEqual(error.cleanupErrors, [closeFailure, cleanupFailure]);
        return true;
    });
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("Security: worker validates its IPC input independently", async t => {
    const { workspace } = await fixture(t);
    const valid = { workspace, fileName: "file.txt", content: "safe" };
    for (const [changes, message] of [
        [{ fileName: "../escape.txt" }, /Invalid file name/],
        [{ content: 123 }, /Content must be a string/],
        [{ workspace: "relative" }, /normalized absolute path/],
        [{ workspace: null }, /normalized absolute path/],
        [{ workspace: workspace + "/../workspace" }, /normalized absolute path/]
    ]) {
        await assert.rejects(writeInWorkspace({ ...valid, ...changes }), message);
    }
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("Security: reject a directory identity mismatch before chdir and close its handle", async t => {
    const { workspace } = await fixture(t);
    const open = fs.open.bind(fs);
    let closes = 0;
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] === "workspace") {
            const stat = handle.stat.bind(handle);
            const close = handle.close.bind(handle);
            t.mock.method(handle, "stat", async () => {
                const stats = await stat();
                return { ...stats, dev: stats.dev + 1, isDirectory: () => true };
            });
            t.mock.method(handle, "close", async () => { closes++; await close(); });
        }
        return handle;
    });
    await assert.rejects(runInternal(workspace), /directory changed/);
    assert.equal(closes, 1);
    assert.deepEqual(await fs.readdir(workspace), []);
});
