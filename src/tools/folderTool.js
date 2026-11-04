import path from "node:path";
import { runDirectoryOperation } from "./directoryToolsClient.js";

export async function createFolder(folderName, workspace = path.resolve("workspace"), { timeoutMs } = {}) {
    if (typeof folderName !== "string" || !/^[a-zA-Z0-9_-]+$/.test(folderName)) {
        throw new Error("Invalid folder name.");
    }
    return runDirectoryOperation({ action: "createFolder", folderName, workspace: path.resolve(workspace) }, { timeoutMs });
}
