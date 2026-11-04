import timers from "node:timers";

export const DEFAULT_API_TIMEOUT_MS = 30_000;
export const DEFAULT_WORKER_TIMEOUT_MS = 10_000;
export const WORKER_TIMEOUT_NOTICE = "A filesystem worker timed out. Termination was requested; its outcome is unknown. Inspect the workspace before retrying. No further tools were executed.";

export function validateTimeout(name, value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer between 1 and 2147483647 milliseconds.`);
  }
  return value;
}

export function timeoutConfigFromEnv(env = process.env) {
  return {
    apiTimeoutMs: validateTimeout("API_TIMEOUT_MS", env.API_TIMEOUT_MS === undefined ? DEFAULT_API_TIMEOUT_MS : Number(env.API_TIMEOUT_MS)),
    workerTimeoutMs: validateTimeout("WORKER_TIMEOUT_MS", env.WORKER_TIMEOUT_MS === undefined ? DEFAULT_WORKER_TIMEOUT_MS : Number(env.WORKER_TIMEOUT_MS)),
  };
}

export function apiTimeoutError(ms) {
  return Object.assign(new Error(`OpenAI request timed out after ${ms} ms. The conversation was reset; previously completed tools are not rolled back.`),
    { code: "OPENAI_TIMEOUT" });
}

// The signal cancels the real SDK request. The deadline also bounds custom/mock
// clients that ignore cancellation; their late resolution/rejection is consumed.
export function withApiTimeout(create, timeoutMs) {
  validateTimeout("apiTimeoutMs", timeoutMs);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = timers.setTimeout(() => {
      if (settled) return;
      const error = apiTimeoutError(timeoutMs);
      finish(error);
      controller.abort(error);
    }, timeoutMs);
    Promise.resolve().then(() => create(controller.signal)).then(
      value => finish(null, value),
      error => finish(error?.name === "APIConnectionTimeoutError" ? apiTimeoutError(timeoutMs) : error),
    );
  });
}
