import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFile } from "../src/tools/createFileTool.js";
import { directoryInWorkspace } from "../src/tools/directoryToolsWorker.js";

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-create-security-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    return { root, workspace, outside };
}

// Production always uses a child process. These serial unit tests restore cwd
// and inject changes at exact boundaries; no timers or race-dependent winners.
async function runInternal(workspace) {
    const cwd = process.cwd();
    try {
        return await directoryInWorkspace({ action: "createFile", fileName: "file.txt", workspace });
    } finally {
        process.chdir(cwd);
    }
}

test("Create security: reject traversal and malformed names before worker launch", async t => {
    const { default: childProcess } = await import("node:child_process");
    let launches = 0;
    t.mock.method(childProcess, "fork", () => { launches++; throw new Error("unexpected launch"); });
    for (const name of ["../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:\\escape.txt",
        "nested/file.txt", "nested\\file.txt", "file.txt\0", "file.txt\n", "", ".", "..", null, undefined, 42, {}]) {
        await assert.rejects(createFile(name, "/unused"), /Invalid file name/);
    }
    assert.equal(launches, 0);
});

for (const ancestor of [false, true]) {
    test(`Create security: reject workspace symlink at ${ancestor ? "ancestor" : "leaf"}`, async t => {
        const { root, outside } = await fixture(t);
        const linked = path.join(root, "linked");
        await fs.symlink(outside, linked);
        await assert.rejects(createFile("file.txt", ancestor ? path.join(linked, "nested") : linked), /symbolic links/);
        assert.deepEqual(await fs.readdir(outside), []);
    });
}

test("Create security: reject workspace replacement after creating a component", async t => {
    const { root, outside } = await fixture(t);
    const workspace = path.join(root, "missing");
    const mkdir = fs.mkdir.bind(fs);
    t.mock.method(fs, "mkdir", async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === "missing") {
            await fs.rename("missing", "original-missing");
            await fs.symlink(outside, "missing");
        }
        return result;
    });
    await assert.rejects(runInternal(workspace), /symbolic links/);
    assert.deepEqual(await fs.readdir(outside), []);
});

test("Create security: reject replacement between workspace open and chdir", async t => {
    const { workspace, outside } = await fixture(t);
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        if (args[0] === "workspace") {
            const stat = handle.stat.bind(handle);
            t.mock.method(handle, "stat", async () => {
                const stats = await stat();
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

test("Create security: pathname replacement cannot redirect creation after workspace selection", async t => {
    const { root, workspace, outside } = await fixture(t);
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
        if (args[0] === "file.txt") {
            await fs.rename(workspace, path.join(root, "original-workspace"));
            await fs.symlink(outside, workspace);
        }
        return open(...args);
    });
    assert.equal(await runInternal(workspace), "File 'file.txt' created successfully.");
    assert.equal((await fs.stat(path.join(root, "original-workspace", "file.txt"))).size, 0);
    assert.deepEqual(await fs.readdir(outside), []);
});

test("Create security: mode is owner-only even with umask 000", async t => {
    const { workspace } = await fixture(t);
    const originalMask = process.umask(0);
    try {
        await createFile("file.txt", workspace);
    } finally {
        process.umask(originalMask);
    }
    assert.equal((await fs.stat(path.join(workspace, "file.txt"))).mode & 0o777, 0o600);
});

for (const kind of ["empty-file", "nonempty-file", "directory", "symlink", "dangling-symlink", "hardlink"]) {
    test(`Create safety: reject an existing ${kind} without altering targets`, async t => {
        const { workspace, outside } = await fixture(t);
        const file = path.join(workspace, "file.txt");
        const target = path.join(outside, "protected.txt");
        if (kind !== "dangling-symlink") await fs.writeFile(target, "PROTECTED");
        if (kind === "empty-file") await fs.writeFile(file, "");
        if (kind === "nonempty-file") await fs.writeFile(file, "PROTECTED");
        if (kind === "directory") await fs.mkdir(file);
        if (kind.includes("symlink")) await fs.symlink(target, file);
        if (kind === "hardlink") await fs.link(target, file);
        await assert.rejects(createFile("file.txt", workspace), { code: "EEXIST" });
        if (kind === "dangling-symlink") await assert.rejects(fs.stat(target), { code: "ENOENT" });
        else assert.equal(await fs.readFile(target, "utf8"), "PROTECTED");
        if (kind === "empty-file") assert.equal(await fs.readFile(file, "utf8"), "");
        if (kind === "nonempty-file") assert.equal(await fs.readFile(file, "utf8"), "PROTECTED");
        if (kind === "directory") assert.equal((await fs.lstat(file)).isDirectory(), true);
        if (kind.includes("symlink")) assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
    });
}

test("Create safety: concurrent calls have exactly one exclusive winner", async t => {
    const { workspace } = await fixture(t);
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => createFile("file.txt", workspace)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    for (const result of results.filter(result => result.status === "rejected")) assert.equal(result.reason.code, "EEXIST");
    const stats = await fs.stat(path.join(workspace, "file.txt"));
    assert.equal(stats.size, 0);
    assert.equal(stats.mode & 0o777, 0o600);
});

test("Create safety: create missing nested workspace components privately", async t => {
    const { root } = await fixture(t);
    const workspace = path.join(root, "missing", "nested");
    await createFile("file.txt", workspace);
    assert.equal((await fs.stat(path.join(workspace, "file.txt"))).size, 0);
    assert.equal((await fs.stat(workspace)).mode & 0o777, 0o700);
});

test("Create security: reject shared writable workspace", async t => {
    const { workspace } = await fixture(t);
    await fs.chmod(workspace, 0o777);
    await assert.rejects(createFile("file.txt", workspace), /not writable by group or others/);
    assert.deepEqual(await fs.readdir(workspace), []);
});

for (const stage of ["open", "close"]) {
    test(`Create errors: propagate ${stage} failure without unsafe cleanup`, async t => {
        const { workspace } = await fixture(t);
        const failure = Object.assign(new Error(`injected ${stage}`), { code: "EIO" });
        const open = fs.open.bind(fs);
        let closes = 0;
        t.mock.method(fs, "open", async (...args) => {
            if (args[0] === "file.txt" && stage === "open") throw failure;
            const handle = await open(...args);
            if (args[0] === "file.txt") {
                const close = handle.close.bind(handle);
                t.mock.method(handle, "close", async () => { closes++; await close(); throw failure; });
            }
            return handle;
        });
        await assert.rejects(runInternal(workspace), error => error === failure);
        assert.equal(closes, stage === "close" ? 1 : 0);
        if (stage === "open") assert.deepEqual(await fs.readdir(workspace), []);
        else assert.equal((await fs.stat(path.join(workspace, "file.txt"))).size, 0);
    });
}

test("Create security: validate the filename independently at the IPC boundary", async () => {
    await assert.rejects(directoryInWorkspace({ action: "createFile", fileName: "../escape.txt" }), /Invalid file name/);
});

test("Create API: default workspace, eval callers, and parent cwd are preserved", async t => {
    const { root } = await fixture(t);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const moduleURL = new URL("../src/tools/createFileTool.js", import.meta.url).href;
    const script = `import { createFile } from ${JSON.stringify(moduleURL)}; const cwd = process.cwd(); const result = await createFile('file.txt'); if (process.cwd() !== cwd) throw new Error('cwd changed'); process.stdout.write(result);`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    assert.equal(stdout, "File 'file.txt' created successfully.");
    assert.equal((await fs.stat(path.join(root, "workspace", "file.txt"))).size, 0);
});
