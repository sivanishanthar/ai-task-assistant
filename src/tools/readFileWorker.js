import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterWorkspace } from "./workspaceDirectory.js";

const LIMIT = 100 * 1024;
const limitError = () => new Error("File exceeds the 100 KB reading limit.");

function checkFile(stats) {
    if (!stats.isFile()) throw new Error("The requested path is not a regular file.");
    if (stats.nlink !== 1) throw new Error("Files with multiple hard links cannot be read.");
    if (stats.size > LIMIT) throw limitError();
}

// Internal entry point. Production always executes it in an isolated process.
export async function readInWorkspace({ workspace, fileName }, io = { fs, process }) {
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    await enterWorkspace(workspace, io);
    const before = await io.fs.lstat(fileName);
    checkFile(before);

    // NOFOLLOW closes the file-symlink race; NONBLOCK prevents a replacement
    // FIFO from blocking before we can reject its type with handle.stat().
    const handle = await io.fs.open(fileName,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let readError;
    try {
        const opened = await handle.stat();
        checkFile(opened);
        if (opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error("The requested file changed while opening it.");
        }
        // One extra byte distinguishes an exactly-at-limit file from an
        // oversized file. Never allocate/read an unbounded amount after stat.
        const buffer = Buffer.alloc(LIMIT + 1);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > LIMIT) throw limitError();
        }
        const after = await handle.stat();
        checkFile(after);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
            throw new Error("The requested file changed while reading it.");
        }
        return buffer.subarray(0, total).toString("utf8");
    } catch (error) {
        readError = error;
        throw error;
    } finally {
        try {
            await handle.close();
        } catch (error) {
            if (!readError) throw error;
            readError.cleanupErrors = [error];
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.once("message", async request => {
        let response;
        try {
            response = { ok: true, content: await readInWorkspace(request) };
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
