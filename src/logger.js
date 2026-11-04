const TOOL_NAMES = new Set(["create_folder", "list_files", "create_file", "write_file", "read_file"]);
const FAILURE_STAGES = new Set(["startup", "request", "fatal"]);

// Build records from an allowlist, never by spreading arguments, results, or
// Error objects. Logging is best-effort and cannot undo a completed tool action.
export function createLogger({ write = line => process.stderr.write(line), now = () => new Date() } = {}) {
  function emit(record) {
    try {
      const pending = write(JSON.stringify({ timestamp: now().toISOString(), ...record }) + "\n");
      // Also handle a custom asynchronous sink without an unhandled rejection.
      Promise.resolve(pending).catch(() => {});
    } catch {
      // Do not print a fallback error that could expose data from the sink.
    }
  }
  return {
    toolExecution({ tool, durationMs, success }) {
      emit({
        event: "tool_execution",
        tool: TOOL_NAMES.has(tool) ? tool : "unknown",
        duration_ms: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
        status: success === true ? "success" : "failure",
      });
    },
    agentFailure(stage) {
      emit({ event: "agent_failure", stage: FAILURE_STAGES.has(stage) ? stage : "unknown", status: "failure" });
    },
  };
}
