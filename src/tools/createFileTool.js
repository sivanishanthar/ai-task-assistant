import path from "node:path";
import { runDirectoryOperation } from "./directoryToolsClient.js";

export async function createFile(fileName, workspace = path.resolve("workspace"), { timeoutMs } = {}) {
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    return runDirectoryOperation({ action: "createFile", fileName, workspace: path.resolve(workspace) }, { timeoutMs });
}
