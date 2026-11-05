import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_API_TIMEOUT_MS, DEFAULT_WORKER_TIMEOUT_MS, validateTimeout } from "./timeouts.js";
import { DEFAULT_MAX_HISTORY_TURNS, DEFAULT_MAX_HISTORY_BYTES, validateHistoryLimits } from "./history.js";

const REASONS = {
  missing: "Workspace is missing; no directory was created.",
  symlink: "Workspace is a symbolic link; its target was not inspected.",
  ancestor_symlink: "A workspace ancestor is a symbolic link; its target was not inspected.",
  not_directory: "Workspace is not a directory.",
  ancestor_not_directory: "A workspace ancestor is not a directory.",
  unavailable: "Workspace metadata could not be inspected; no raw error details are displayed.",
};

// Read-only metadata snapshot, not a substitute for the workers' pinned checks.
// Stop at any observed symlink/non-directory rather than inspecting its target.
export async function inspectWorkspace(workspace, io = { fs, process }) {
  const directory = path.resolve(workspace);
  const result = {
    exists: null, directory: null, pathSafe: null, ownerMatches: null,
    sharingSafe: null, ownerAccess: null, mode: null, issue: null,
    platformSupported: ["darwin", "linux"].includes(io.process.platform),
  };
  const root = path.parse(directory).root;
  const prefixes = [root];
  let prefix = root;
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, component);
    prefixes.push(prefix);
  }
  try {
    for (let index = 0; index < prefixes.length; index++) {
      const last = index === prefixes.length - 1;
      const stats = await io.fs.lstat(prefixes[index]);
      if (stats.isSymbolicLink()) {
        return { ...result, exists: last ? true : null, directory: last ? false : null,
          pathSafe: false, issue: last ? "symlink" : "ancestor_symlink" };
      }
      if (!stats.isDirectory()) {
        return { ...result, exists: last, directory: false, pathSafe: false,
          issue: last ? "not_directory" : "ancestor_not_directory" };
      }
      if (last) {
        result.exists = true;
        result.directory = true;
        result.pathSafe = true;
        if (result.platformSupported) {
          result.ownerMatches = typeof io.process.geteuid === "function" ? stats.uid === io.process.geteuid() : null;
          result.sharingSafe = (stats.mode & 0o022) === 0;
          result.ownerAccess = (stats.mode & 0o700) === 0o700;
          result.mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
        }
      }
    }
    return result;
  } catch (error) {
    if (error.code === "ENOENT") return { ...result, exists: false, directory: false, issue: "missing" };
    if (error.code === "ENOTDIR") return { ...result, exists: false, directory: false, pathSafe: false, issue: "ancestor_not_directory" };
    return { ...result, issue: "unavailable" };
  }
}

export async function getStatus({
  workspace = path.resolve("workspace"), apiKeyConfigured = false,
  apiTimeoutMs = DEFAULT_API_TIMEOUT_MS, workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  maxHistoryTurns = DEFAULT_MAX_HISTORY_TURNS, maxHistoryBytes = DEFAULT_MAX_HISTORY_BYTES,
} = {}, io) {
  validateTimeout("apiTimeoutMs", apiTimeoutMs);
  validateTimeout("workerTimeoutMs", workerTimeoutMs);
  validateHistoryLimits({ maxHistoryTurns, maxHistoryBytes });
  const directory = path.resolve(workspace);
  return {
    workspace: directory, workspaceCheck: await inspectWorkspace(directory, io),
    apiKeyConfigured: apiKeyConfigured === true,
    apiTimeoutMs, workerTimeoutMs, maxHistoryTurns, maxHistoryBytes,
  };
}

const check = value => value === null ? "not checked" : value ? "PASS" : "FAIL";

export function formatStatus(status) {
  const w = status.workspaceCheck;
  let summary = "PASS (metadata checks only)";
  if (!w.platformSupported) summary = "FAIL (supported platforms are macOS/Linux)";
  else if (w.issue === "missing") summary = "NOT READY (workspace missing)";
  else if (w.issue === "unavailable") summary = "UNKNOWN (inspection unavailable)";
  else if (w.issue || w.ownerMatches === false || w.sharingSafe === false) summary = "FAIL";
  else if (w.ownerMatches === null || w.sharingSafe === null) summary = "UNKNOWN";
  else if (!w.ownerAccess) summary = "WARN (owner read/write/execute bits incomplete)";
  return `AI Task Assistant - Status

Workspace: ${JSON.stringify(status.workspace)}
Workspace exists: ${w.exists === null ? "unknown" : w.exists ? "yes" : "no"}
Path requirement (directories only, no symlinks): ${check(w.pathSafe)}
Ownership requirement (current user): ${check(w.ownerMatches)}
Permissions: ${w.mode ?? "unknown"}; no group/other write: ${check(w.sharingSafe)}
Owner read/write/execute bits: ${w.ownerAccess === null ? "not checked" : w.ownerAccess ? "PASS" : "WARN (some operations may fail)"}
Workspace checks: ${summary}
${w.issue ? REASONS[w.issue] + "\n" : ""}
API key: ${status.apiKeyConfigured ? "configured (value hidden; not validated)" : "not configured"}
OpenAI timeout: ${status.apiTimeoutMs} ms per completion request.
Filesystem worker timeout: ${status.workerTimeoutMs} ms per operation.
History: ${status.maxHistoryTurns} turns (active included); ${status.maxHistoryBytes} serialized UTF-8 message bytes.

Local, read-only check: no API call, tool execution, history entry, or workspace changes.
Metadata is a snapshot; ACLs and races can affect actual access. Tools recheck when executing.
`;
}
