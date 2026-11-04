import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

function sameDirectory(a, b) {
    return b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
}

// Run only in an isolated worker: this deliberately changes its cwd.
export async function enterWorkspace(workspace, io = { fs, process }, create = false) {
    if (typeof workspace !== "string" || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace) {
        throw new Error("Workspace must be a normalized absolute path.");
    }
    if (io.process.platform === "win32") {
        throw new Error("Secure workspace operations currently require macOS or Linux.");
    }
    const root = path.parse(workspace).root;
    io.process.chdir(root);
    for (const component of workspace.slice(root.length).split(path.sep).filter(Boolean)) {
        let before;
        try {
            before = await io.fs.lstat(component);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            if (!create) throw error;
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

    // Require a trusted final directory for both readers and writers. Other
    // accounts must not be able to replace its entries between operations.
    const directoryStats = await io.fs.lstat(".");
    if (directoryStats.uid !== io.process.geteuid() || (directoryStats.mode & 0o022) !== 0) {
        throw new Error("Workspace must be owned by the current user and not writable by group or others.");
    }
}
