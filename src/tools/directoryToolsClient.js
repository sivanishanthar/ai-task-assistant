import childProcess from "node:child_process";

// Keep cwd changes confined to the worker and preserve Node permission flags.
export function runDirectoryOperation(request) {
    const execArgv = [];
    for (let i = 0; i < process.execArgv.length; i++) {
        const argument = process.execArgv[i];
        if (["--input-type", "--eval", "--print", "-e", "-p"].includes(argument)) {
            i++;
            continue;
        }
        if (!/^(--input-type=|--eval=|--print=|-e.|-p.)/.test(argument)) execArgv.push(argument);
    }
    return new Promise((resolve, reject) => {
        const child = childProcess.fork(new URL("./directoryToolsWorker.js", import.meta.url), [], {
            execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"]
        });
        let response;
        child.on("message", message => { response = message; });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            const validResult = ["createFolder", "createFile"].includes(request.action)
                ? typeof response?.result === "string"
                : Array.isArray(response?.result) && response.result.every(item =>
                    item && typeof item.name === "string" && ["file", "folder"].includes(item.type));
            if (code === 0 && response?.ok === true && validResult) return resolve(response.result);
            const error = new Error(response?.message || `Directory worker exited unexpectedly (${signal || code}).`);
            if (response?.code) error.code = response.code;
            reject(error);
        });
        child.send(request, error => {
            if (error) {
                child.kill();
                reject(error);
            }
        });
    });
}
