import { DEFAULT_API_TIMEOUT_MS, DEFAULT_WORKER_TIMEOUT_MS } from "./timeouts.js";
import { DEFAULT_MAX_HISTORY_TURNS, DEFAULT_MAX_HISTORY_BYTES } from "./history.js";
import { DEFAULT_MAX_TOOL_CALLS_PER_REQUEST, DEFAULT_MAX_TOOL_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, MAX_READ_BYTES } from "./toolLimits.js";

export function formatHelp({
  apiTimeoutMs = DEFAULT_API_TIMEOUT_MS,
  workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  maxHistoryTurns = DEFAULT_MAX_HISTORY_TURNS,
  maxHistoryBytes = DEFAULT_MAX_HISTORY_BYTES,
  maxToolCallsPerRequest = DEFAULT_MAX_TOOL_CALLS_PER_REQUEST,
  maxToolCallsPerRound = DEFAULT_MAX_TOOL_CALLS_PER_ROUND,
} = {}) {
  return `AI Task Assistant - Help

Local commands:
  help   Show this help locally; no API call, tool execution, or history entry.
  status Show workspace, key-presence, timeout, and history checks locally; no API call.
  reset  Clear conversation history locally; keep system instructions and workspace files. No API call.
  exit   Quit the agent.
  You can also run npm start -- --help (or -h), or npm start -- --status, without an API key.

The five tools:
  create_folder  Create a folder; an existing genuine directory is accepted.
  list_files     List regular files and folders; symlinks and special entries are omitted.
  create_file    Create an empty file only.
  write_file     Create a NEW file containing text directly.
  read_file      Read UTF-8 text, up to ${MAX_READ_BYTES} bytes (100 KB).

Supported names:
  Folders: nonempty ASCII letters (A-Z, a-z), digits, underscores, and hyphens.
  Files: the same basename characters, exactly one dot, then letters or digits for the extension.
  Examples: Plans_2026, notes.txt, test-plan_02.md.
  No spaces, path separators, nested paths, or path traversal such as ../notes.txt.
  File extensions do not generate a formatted Word document or PDF.

Create-only files:
  Existing files, INCLUDING EMPTY FILES, can never be overwritten.
  Choose a new filename instead; overwriting is not an available option.
  For a file with content, use write_file directly; do NOT run create_file first.
  Example request: Create notes_02.txt containing Hello from my agent.

Current limits:
  Tool calls: ${maxToolCallsPerRound} per round; ${maxToolCallsPerRequest} per user request; ${MAX_TOOL_ROUNDS} rounds per request.
  Oversized batches are rejected in full; failed attempts still count.
  OpenAI timeout: ${apiTimeoutMs} ms per completion request.
  Filesystem worker timeout: ${workerTimeoutMs} ms per operation.
  History: ${maxHistoryTurns} turns (active turn included); ${maxHistoryBytes} serialized UTF-8 message bytes.
  Old completed turns are forgotten as a whole; system instructions are preserved.
  History bytes are not a token count. Files remain when conversation history is trimmed.
  A timeout is not rollback; inspect the workspace before retrying.

Workspace and configuration:
  All tools operate in the configured workspace on macOS/Linux.
  Workspace symlinks are rejected; it must be owned by you and not group/other-writable.
  Configure API_TIMEOUT_MS, WORKER_TIMEOUT_MS, MAX_HISTORY_TURNS, and MAX_HISTORY_BYTES in .env.
  Restart the agent after changing configuration.
`;
}
