import childProcess from "node:child_process";
import path from "node:path";

// Run directory-relative operations in a child so pinning its cwd cannot affect
// the agent or other simultaneous calls. Never pass content on the command line.
export async function writeFile(fileName, content, workspace = path.resolve("workspace")) {
    if (typeof fileName !== "string" || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)) {
        throw new Error("Invalid file name.");
    }
    if (typeof content !== "string") {
        throw new Error("Content must be a string.");
    }
    const directory = path.resolve(workspace);
    // Eval/stdin flags apply to the caller, not the worker module. Keep other
    // flags, including any runtime permission restrictions.
    const execArgv = [];
    for (let i = 0; i < process.execArgv.length; i++) {
        const argument = process.execArgv[i];
        if (["--input-type", "--eval", "--print", "-e", "-p"].includes(argument)) {
            i++;
            continue;
        }
        if (!/^(--input-type=|--eval=|--print=|-e.|-p.)/.test(argument)) execArgv.push(argument);
    }
    await new Promise((resolve, reject) => {
        const child = childProcess.fork(new URL("./writeFileWorker.js", import.meta.url), [], {
            execArgv,
            stdio: ["ignore", "ignore", "ignore", "ipc"]
        });
        let response;
        child.on("message", message => { response = message; });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0 && response?.ok === true) return resolve();
            const error = new Error(response?.message || `File writer exited unexpectedly (${signal || code}).`);
            if (response?.code) error.code = response.code;
            if (response?.cleanupErrors) error.cleanupErrors = response.cleanupErrors;
            reject(error);
        });
        child.send({ fileName, content, workspace: directory }, error => {
            if (error) {
                child.kill();
                reject(error);
            }
        });
    });
    return `Content successfully written to '${fileName}'.`;
}
