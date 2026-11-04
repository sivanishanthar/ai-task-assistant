import childProcess from "node:child_process";
import timers from "node:timers";
import { DEFAULT_WORKER_TIMEOUT_MS, validateTimeout } from "../timeouts.js";

// Shared transport for all filesystem workers. Keep permission flags while
// removing caller eval/stdin flags that cannot apply to a worker module file.
export function runWorker(url, request, { timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, label, accept }) {
  validateTimeout("timeoutMs", timeoutMs);
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
    const child = childProcess.fork(url, [], { execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let response;
    let settled = false;
    const onMessage = message => { if (!settled) response = message; };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      child.removeListener("message", onMessage);
      if (error) reject(error);
      else resolve(value);
    };
    const kill = signal => {
      try { child.kill(signal); } catch { /* Preserve the original failure. */ }
    };
    const timer = timers.setTimeout(() => {
      if (settled) return;
      finish(Object.assign(new Error(`Filesystem worker timed out after ${timeoutMs} ms; termination was requested. Its outcome is unknown; inspect the workspace before retrying.`),
        { code: "WORKER_TIMEOUT" }));
      kill("SIGKILL");
    }, timeoutMs);
    child.on("message", onMessage);
    // Retain the guarded error handler to consume late IPC/process errors after
    // cancellation. The child and listeners are collectible after process exit.
    child.on("error", error => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code === 0 && response?.ok === true && accept(response)) return finish(null, response);
      const error = new Error(response?.message || `${label} exited unexpectedly (${signal || code}).`);
      if (response?.code) error.code = response.code;
      if (response?.cleanupErrors) error.cleanupErrors = response.cleanupErrors;
      finish(error);
    });
    try {
      child.send(request, error => {
        if (error && !settled) {
          finish(error);
          kill();
        }
      });
    } catch (error) {
      finish(error);
      kill();
    }
  });
}
