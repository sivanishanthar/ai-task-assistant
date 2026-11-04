import fs from "node:fs/promises";
import path from "node:path";
import { enterWorkspace } from "./workspaceDirectory.js";
import { fileURLToPath } from "node:url";

// Internal worker: call only from its isolated child process. The optional IO
// adapter lets tests inject replacements at exact boundaries without timers.
export async function writeInWorkspace({ workspace, fileName, content }, io = { fs, process }) {
    // Validate again at the IPC boundary, even though the public wrapper checks.
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    if (typeof content !== "string") throw new Error("Content must be a string.");
    await enterWorkspace(workspace, io, true);

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
