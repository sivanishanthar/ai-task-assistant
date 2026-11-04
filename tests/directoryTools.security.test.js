import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFolder } from "../src/tools/folderTool.js";
import { listFiles } from "../src/tools/listFilesTool.js";
import { directoryInWorkspace } from "../src/tools/directoryToolsWorker.js";

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-dir-security-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private-name.txt"), "SECRET");
    return { root, workspace, outside };
}

function call(action, workspace) {
    return action === "createFolder" ? createFolder("NewFolder", workspace) : listFiles(workspace);
}

// Only unit tests run the worker in-process, serially, with exact injected
// operation boundaries. Production always pins cwd in a separate child.
async function runInternal(action, workspace) {
    const cwd = process.cwd();
    try {
        return await directoryInWorkspace({ action, workspace, folderName: "NewFolder" });
    } finally {
        process.chdir(cwd);
    }
}

test("Folder security: reject traversal and malformed names before launching a worker", async t => {
    const { default: childProcess } = await import("node:child_process");
    let launches = 0;
    t.mock.method(childProcess, "fork", () => { launches++; throw new Error("unexpected launch"); });
    for (const name of ["../escape", "..\\escape", "/tmp/escape", "C:\\escape", "nested/child",
        "nested\\child", "", ".", "..", "folder\0", "folder\n", "%2e%2e", null, undefined, 42, {}]) {
        await assert.rejects(createFolder(name, "/unused"), /Invalid folder name/);
    }
    assert.equal(launches, 0);
});

for (const action of ["createFolder", "listFiles"]) {
    for (const ancestor of [false, true]) {
        test(`${action}: reject a workspace symlink at ${ancestor ? "ancestor" : "leaf"}`, async t => {
            const { root, outside } = await fixture(t);
            const linked = path.join(root, "linked");
            await fs.symlink(outside, linked);
            const workspace = ancestor ? path.join(linked, "nested") : linked;
            await assert.rejects(call(action, workspace), /symbolic links/);
            assert.deepEqual(await fs.readdir(outside), ["private-name.txt"]);
        });
    }

    test(`${action}: reject workspace replacement after creating a path component`, async t => {
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
        await assert.rejects(runInternal(action, workspace), /symbolic links/);
        assert.deepEqual(await fs.readdir(outside), ["private-name.txt"]);
    });

    test(`${action}: reject replacement between directory open and chdir`, async t => {
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
        await assert.rejects(runInternal(action, workspace), /directory changed/);
        assert.deepEqual(await fs.readdir(outside), ["private-name.txt"]);
    });

    test(`${action}: operations remain pinned after the workspace pathname is replaced`, async t => {
        const { root, workspace, outside } = await fixture(t);
        await fs.writeFile(path.join(workspace, "safe.txt"), "safe");
        const method = action === "createFolder" ? "mkdir" : "readdir";
        const original = fs[method].bind(fs);
        t.mock.method(fs, method, async (...args) => {
            if (args[0] === (action === "createFolder" ? "NewFolder" : ".")) {
                await fs.rename(workspace, path.join(root, "original-workspace"));
                await fs.symlink(outside, workspace);
            }
            return original(...args);
        });
        const result = await runInternal(action, workspace);
        if (action === "createFolder") {
            assert.equal((await fs.stat(path.join(root, "original-workspace", "NewFolder"))).isDirectory(), true);
        } else {
            assert.deepEqual(result, [{ name: "safe.txt", type: "file" }]);
        }
        assert.deepEqual(await fs.readdir(outside), ["private-name.txt"]);
    });

    test(`${action}: reject a shared writable workspace`, async t => {
        const { workspace } = await fixture(t);
        await fs.chmod(workspace, 0o777);
        await assert.rejects(call(action, workspace), /not writable by group or others/);
    });

    test(`${action}: preserve creation of missing nested workspaces`, async t => {
        const { root } = await fixture(t);
        const workspace = path.join(root, "missing", "nested");
        const result = await call(action, workspace);
        if (action === "createFolder") {
            assert.equal(result, "Folder 'NewFolder' created successfully.");
            assert.equal((await fs.stat(path.join(workspace, "NewFolder"))).isDirectory(), true);
        } else assert.deepEqual(result, []);
        assert.equal((await fs.stat(workspace)).mode & 0o777, 0o700);
    });
}

for (const dangling of [false, true]) {
    test(`Folder security: reject an existing ${dangling ? "dangling" : "directory-target"} symlink`, async t => {
        const { workspace, outside } = await fixture(t);
        await fs.symlink(dangling ? path.join(outside, "missing") : outside, path.join(workspace, "NewFolder"));
        await assert.rejects(createFolder("NewFolder", workspace), /symbolic links are not allowed/);
        assert.equal((await fs.lstat(path.join(workspace, "NewFolder"))).isSymbolicLink(), true);
        assert.deepEqual(await fs.readdir(outside), ["private-name.txt"]);
    });
}

test("Folder security: reject an existing regular file without modifying it", async t => {
    const { workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, "NewFolder"), "PROTECTED");
    await assert.rejects(createFolder("NewFolder", workspace), /not a directory/);
    assert.equal(await fs.readFile(path.join(workspace, "NewFolder"), "utf8"), "PROTECTED");
});

test("Folder behavior: genuine directory creation is private and idempotent", async t => {
    const { workspace } = await fixture(t);
    const result = await createFolder("NewFolder", workspace);
    await fs.writeFile(path.join(workspace, "NewFolder", "keep.txt"), "keep");
    assert.equal(await createFolder("NewFolder", workspace), result);
    assert.equal(await fs.readFile(path.join(workspace, "NewFolder", "keep.txt"), "utf8"), "keep");
    assert.equal((await fs.stat(path.join(workspace, "NewFolder"))).mode & 0o777, 0o700);
});

test("Folder security: reject destination replacement with a symlink after mkdir", async t => {
    const { workspace, outside } = await fixture(t);
    const mkdir = fs.mkdir.bind(fs);
    t.mock.method(fs, "mkdir", async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === "NewFolder") {
            await fs.rename("NewFolder", "original-folder");
            await fs.symlink(outside, "NewFolder");
        }
        return result;
    });
    await assert.rejects(runInternal("createFolder", workspace), /symbolic links are not allowed/);
    assert.deepEqual(await fs.readdir(outside), ["private-name.txt"]);
});

test("List security: omit real symlinks without following their targets", async t => {
    const { workspace, outside } = await fixture(t);
    await fs.writeFile(path.join(workspace, "safe.txt"), "safe");
    await fs.mkdir(path.join(workspace, "Folder"));
    await fs.symlink(outside, path.join(workspace, "directory-link"));
    await fs.symlink(path.join(outside, "private-name.txt"), path.join(workspace, "file-link"));
    await fs.symlink(path.join(outside, "missing"), path.join(workspace, "dangling-link"));
    const result = await listFiles(workspace);
    assert.deepEqual(result.sort((a, b) => a.name.localeCompare(b.name)),
        [{ name: "Folder", type: "folder" }, { name: "safe.txt", type: "file" }]);
});

test("List metadata: omit every unsupported entry type while preserving the result schema", async t => {
    const { workspace } = await fixture(t);
    const entry = (name, kind) => ({ name, isFile: () => kind === "file", isDirectory: () => kind === "folder" });
    t.mock.method(fs, "readdir", async (directory, options) => {
        assert.equal(directory, ".");
        assert.deepEqual(options, { withFileTypes: true });
        return [entry("safe.txt", "file"), entry("Folder", "folder"),
            ...["symlink", "fifo", "socket", "character-device", "block-device", "unknown"].map(kind => entry(kind, kind))];
    });
    assert.deepEqual(await runInternal("listFiles", workspace),
        [{ name: "safe.txt", type: "file" }, { name: "Folder", type: "folder" }]);
});

for (const stage of ["mkdir", "lstat", "readdir"]) {
    test(`Directory errors: propagate ${stage} failure`, async t => {
        const { workspace } = await fixture(t);
        const failure = Object.assign(new Error(`injected ${stage}`), { code: "EIO" });
        const original = fs[stage].bind(fs);
        t.mock.method(fs, stage, async (...args) => {
            if (args[0] === (stage === "readdir" ? "." : "NewFolder")) throw failure;
            return original(...args);
        });
        await assert.rejects(runInternal(stage === "readdir" ? "listFiles" : "createFolder", workspace),
            error => error === failure);
    });
}

test("Directory worker: validate action, names, and workspace at the IPC boundary", async () => {
    await assert.rejects(directoryInWorkspace({ action: "unknown" }), /Invalid directory operation/);
    await assert.rejects(directoryInWorkspace({ action: "createFolder", folderName: "../escape" }), /Invalid folder name/);
    await assert.rejects(directoryInWorkspace({ action: "listFiles", workspace: "relative" }), /normalized absolute path/);
});

test("Directory API: default workspace, eval callers, and parent cwd are preserved", async t => {
    const { root } = await fixture(t);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const folderURL = new URL("../src/tools/folderTool.js", import.meta.url).href;
    const listURL = new URL("../src/tools/listFilesTool.js", import.meta.url).href;
    const script = `import { createFolder } from ${JSON.stringify(folderURL)}; import { listFiles } from ${JSON.stringify(listURL)}; const cwd = process.cwd(); await createFolder('DefaultFolder'); const result = await listFiles(); if (process.cwd() !== cwd) throw new Error('cwd changed'); process.stdout.write(JSON.stringify(result));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    assert.deepEqual(JSON.parse(stdout), [{ name: "DefaultFolder", type: "folder" }]);
});

for (const outcome of ["spawn-error", "send-error", "unexpected-exit", "worker-error", "invalid-folder", "invalid-list", "invalid-list-item"]) {
    test(`Directory worker transport: reject ${outcome}`, async t => {
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
                if (outcome === "worker-error") child.emit("message", { ok: false, message: "worker failed", code: "EIO" });
                if (outcome === "invalid-folder") child.emit("message", { ok: true, result: 123 });
                if (outcome === "invalid-list") child.emit("message", { ok: true, result: {} });
                if (outcome === "invalid-list-item") child.emit("message", { ok: true, result: [{ name: "link", type: "symlink" }] });
                child.emit("exit", outcome.startsWith("invalid") ? 0 : 1, null);
            });
        };
        t.mock.method(childProcess, "fork", () => child);
        const promise = outcome === "invalid-folder" ? createFolder("Folder", "/unused") : listFiles("/unused");
        await assert.rejects(promise, error => {
            if (["spawn-error", "send-error"].includes(outcome)) assert.equal(error, failure);
            else if (outcome === "worker-error") assert.equal(error.code, "EIO");
            else assert.match(error.message, /exited unexpectedly/);
            return true;
        });
        assert.equal(killed, outcome === "send-error");
    });
}
