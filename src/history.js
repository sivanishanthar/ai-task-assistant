import { Buffer } from "node:buffer";

export const DEFAULT_MAX_HISTORY_TURNS = 20;
export const DEFAULT_MAX_HISTORY_BYTES = 256 * 1024;

export function validateHistoryLimits({ maxHistoryTurns, maxHistoryBytes }) {
  for (const [name, value] of Object.entries({ maxHistoryTurns, maxHistoryBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
}

export function historyConfigFromEnv(env = process.env) {
  const limits = {
    maxHistoryTurns: env.MAX_HISTORY_TURNS === undefined ? DEFAULT_MAX_HISTORY_TURNS : Number(env.MAX_HISTORY_TURNS),
    maxHistoryBytes: env.MAX_HISTORY_BYTES === undefined ? DEFAULT_MAX_HISTORY_BYTES : Number(env.MAX_HISTORY_BYTES),
  };
  validateHistoryLimits(limits);
  return limits;
}

export function historyBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

// Turn boundaries are top-level user messages, never text inside content.
// During an active turn, its start index is protected. Once completed, null
// permits eviction of that turn too if its final response cannot fit.
export function trimHistory(messages, { maxHistoryTurns, maxHistoryBytes }, activeTurnStart = null) {
  let turns = messages.filter(message => message.role === "user").length;
  while (turns > maxHistoryTurns || historyBytes(messages) > maxHistoryBytes) {
    if (activeTurnStart === 1 || messages.length === 1) {
      throw Object.assign(new Error("Conversation history exceeds the configured limit. Use a shorter request or smaller tool input/output. Previously completed tools are not rolled back."),
        { code: "HISTORY_LIMIT" });
    }
    const nextUser = messages.findIndex((message, index) => index > 1 && message.role === "user");
    const count = nextUser === -1 ? messages.length - 1 : nextUser - 1;
    messages.splice(1, count);
    turns--;
    if (activeTurnStart !== null) activeTurnStart -= count;
  }
  return activeTurnStart;
}
