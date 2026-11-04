import { runWorker } from "./workerClient.js";

export async function runDirectoryOperation(request, { timeoutMs } = {}) {
    const response = await runWorker(new URL("./directoryToolsWorker.js", import.meta.url), request, {
        timeoutMs, label: "Directory worker",
        accept: message => ["createFolder", "createFile"].includes(request.action)
            ? typeof message.result === "string"
            : Array.isArray(message.result) && message.result.every(item =>
                item && typeof item.name === "string" && ["file", "folder"].includes(item.type)),
    });
    return response.result;
}
