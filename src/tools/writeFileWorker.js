import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";

function sameDirectory(a, b) {
    return b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
}

// Internal worker: call only from its isolated child process. The optional IO
// adapter lets tests inject replacements at exact boundaries without timers.
export async function writeInWorkspace({ workspace, fileName, content }, io = { fs, process }) {
    // Validate again at the IPC boundary, even though the public wrapper checks.
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    if (typeof content !== "string") throw new Error("Content must be a string.");
    if (typeof workspace !== "string" || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace) {
        throw new Error("Workspace must be a normalized absolute path.");
    }
    if (io.process.platform === "win32") {
        throw new Error("Secure workspace writes currently require macOS or Linux.");
    }
    const root = path.parse(workspace).root;
    io.process.chdir(root);
    for (const component of workspace.slice(root.length).split(path.sep).filter(Boolean)) {
        let before;
        try {
            before = await io.fs.lstat(component);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            try {
                await io.fs.mkdir(component, { mode: 0o700 });
            } catch (mkdirError) {
                if (mkdirError.code !== "EEXIST") throw mkdirError;
            }
            before = await io.fs.lstat(component);
        }
        if (!before.isDirectory()) {
            throw new Error("Workspace path must contain only directories, without symbolic links.");
        }
        // cwd holds the directory itself. Once selected, renaming its pathname
        // cannot redirect later relative operations. Check a raced chdir before
        // creating anything inside the selected directory.
        const directory = await io.fs.open(component,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            const opened = await directory.stat();
            if (!sameDirectory(before, opened)) {
                throw new Error("Workspace directory changed while opening it.");
            }
            io.process.chdir(component);
            if (!sameDirectory(opened, await io.fs.lstat("."))) {
                throw new Error("Workspace directory changed while opening it.");
            }
        } finally {
            // Holding this descriptor until after chdir also prevents inode
            // reuse from defeating the directory identity comparison.
            await directory.close();
        }
    }

    // A writable shared directory would let another account replace private
    // staging entries. Refuse it instead of relying on pathname rechecks.
    const directoryStats = await io.fs.lstat(".");
    if (directoryStats.uid !== io.process.geteuid() || (directoryStats.mode & 0o022) !== 0) {
        throw new Error("Workspace must be owned by the current user and not writable by group or others.");
    }

    // Write privately, then atomically publish with link()'s no-replace semantics.
    // No existing destination is ever opened, including hard links/empty files.
    // This also avoids exposing a partly written destination to another caller.
    const staging = await io.fs.mkdtemp(".ai-write-");
    const payload = path.join(staging, "content");
    let operationError;
    try {
        const handle = await io.fs.open(payload, "wx", 0o600);
        let writeError;
        try {
            await handle.writeFile(content, "utf8");
        } catch (error) {
            writeError = error;
            throw error;
        } finally {
            try {
                await handle.close();
            } catch (error) {
                if (!writeError) throw error;
                writeError.cleanupErrors = [error];
            }
        }
        try {
            await io.fs.link(payload, fileName);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            throw Object.assign(new Error(
                `File '${fileName}' already exists. Overwriting is not allowed, including empty files.`
            ), { code: "EEXIST" });
        }
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        // Never remove the destination on failure: it may belong to another call.
        try {
            await io.fs.rm(staging, { recursive: true, force: true });
        } catch (error) {
            if (!operationError) throw error;
            (operationError.cleanupErrors ??= []).push(error);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.once("message", async request => {
        let response;
        try {
            await writeInWorkspace(request);
            response = { ok: true };
        } catch (error) {
            response = {
                ok: false, message: error.message, code: error.code,
                cleanupErrors: error.cleanupErrors?.map(item => ({ message: item.message, code: item.code }))
            };
            process.exitCode = 1;
        }
        process.send(response, () => process.disconnect());
    });
}
