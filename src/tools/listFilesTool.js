import path from "node:path";
import { runDirectoryOperation } from "./directoryToolsClient.js";

export async function listFiles(workspace = path.resolve("workspace"), { timeoutMs } = {}) {
    return runDirectoryOperation({ action: "listFiles", workspace: path.resolve(workspace) }, { timeoutMs });
}
