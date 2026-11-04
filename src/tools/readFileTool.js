import path from "node:path";
import { runWorker } from "./workerClient.js";

export async function readFile(fileName, workspace = path.resolve("workspace"), { timeoutMs } = {}) {
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    const response = await runWorker(new URL("./readFileWorker.js", import.meta.url),
        { fileName, workspace: path.resolve(workspace) }, {
            timeoutMs, label: "File reader", accept: message => typeof message.content === "string",
        });
    return response.content;
}
