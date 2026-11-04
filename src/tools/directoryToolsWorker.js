import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enterWorkspace } from "./workspaceDirectory.js";

// Internal entry point; production always runs in an isolated child process.
export async function directoryInWorkspace({ action, workspace, folderName, fileName }, io = { fs, process }) {
    if (!["createFolder", "listFiles", "createFile"].includes(action)) throw new Error("Invalid directory operation.");
    if (action === "createFolder" &&
        (typeof folderName !== "string" || !/^[a-zA-Z0-9_-]+$/.test(folderName))) {
        throw new Error("Invalid folder name.");
    }
    if (action === "createFile" &&
        (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName))) {
        throw new Error("Invalid file name.");
    }
    // Preserve the tools' existing ability to create missing workspaces.
    await enterWorkspace(workspace, io, true);
    if (action === "createFile") {
        // Exclusive creation relative to pinned cwd cannot follow an existing
        // destination symlink or overwrite any existing directory entry.
        const handle = await io.fs.open(fileName, "wx", 0o600);
        await handle.close();
        return `File '${fileName}' created successfully.`;
    }
    if (action === "createFolder") {
        try {
            // A single component, relative to pinned cwd. Never follow a final
            // symlink using recursive mkdir, even when it points to a directory.
            await io.fs.mkdir(folderName, { mode: 0o700 });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        // Preserve idempotence only for genuine directories, not symlinks.
        if (!(await io.fs.lstat(folderName)).isDirectory()) {
            throw new Error("The requested folder path is not a directory; symbolic links are not allowed.");
        }
        return `Folder '${folderName}' created successfully.`;
    }
    const entries = await io.fs.readdir(".", { withFileTypes: true });
    // Preserve the existing name/type schema. Omit unsupported entries instead
    // of reporting symlinks, sockets, devices, or FIFOs as ordinary files.
    return entries.filter(item => item.isFile() || item.isDirectory()).map(item => ({
        name: item.name,
        type: item.isDirectory() ? "folder" : "file"
    }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.once("message", async request => {
        let response;
        try {
            response = { ok: true, result: await directoryInWorkspace(request) };
        } catch (error) {
            response = { ok: false, message: error.message, code: error.code };
            process.exitCode = 1;
        }
        process.send(response, () => process.disconnect());
    });
}
