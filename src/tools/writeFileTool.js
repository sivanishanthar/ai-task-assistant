import path from "node:path";
import { runWorker } from "./workerClient.js";

export async function writeFile(fileName, content, workspace = path.resolve("workspace"), { timeoutMs } = {}) {
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    if (typeof content !== "string") throw new Error("Content must be a string.");
    await runWorker(new URL("./writeFileWorker.js", import.meta.url),
        { fileName, content, workspace: path.resolve(workspace) }, {
            timeoutMs, label: "File writer", accept: () => true,
        });
    return `Content successfully written to '${fileName}'.`;
}
