# Changelog

## [1.0.0] - 2026-11-04

First source release of AI Task Assistant. Package version: `1.0.0`.

### Features

- Five model-dispatched tools: create folders, create empty files, create new
  text files, list regular workspace entries, and read UTF-8 files.
- In-memory conversation context and multiple correlated tool calls, with
  scripted OpenAI workflow tests exercising the real filesystem tools.
- Offline local `help`, `status`, and `reset` commands. `--help`/`-h` and
  `--status` work without an API key; reset preserves instructions and files.
- Privacy-safe JSON stderr diagnostics containing tool name, duration, and
  outcome. Raw tool results, keys, prompts, paths, content, and raw errors are
  excluded; local generated logs are ignored by Git.

### Filesystem Safety and Behavior

- Verified, pinned workspace traversal in isolated Node child processes.
  Symlink workspace components are rejected; effective-user ownership and
  no group/other write permission are required.
- Create-only files, including rejection of existing empty files. Writes use
  private staging and atomic no-replace hard-link publication. New directories
  use `0700` and files `0600`, subject to umask.
- File reads use verified `O_NOFOLLOW | O_NONBLOCK` handles and a bounded
  102400-byte read limit. Multiply linked and nonregular files are rejected.
- Folder creation rejects destination symlinks; listing omits symlinks and
  special entries while retaining the `{ name, type }` result format.
- Agent instructions never offer unsupported overwriting and request a new
  filename instead. A file with content must be created by `write_file`
  directly, without calling `create_file` first.

### Limits and Recovery

- Defaults: 5 tool calls per round, 10 per user request, and 5 rounds. Excess
  batches do not execute and leave no unresolved tool-call IDs in history.
- Configurable 30000 ms OpenAI completion and 10000 ms worker timeouts.
  Requests are aborted; stalled workers receive `SIGKILL`. Remaining calls
  are skipped explicitly, and late results cannot resume the old request.
- Configurable history retention: 20 whole turns and 262144 UTF-8 serialized
  message bytes by default. System instructions and tool/result groups remain
  intact; oversized active turns fail before another API call.
- Recovery tests cover timeouts, API failures, malformed arguments, limit
  rejection, and reset without deleting workspace files.

### Supported Environment and Known Limits

- macOS/Linux, Node.js 22 or 24, permitted child processes, and filesystem
  support for POSIX permissions and hard links. Native Windows is unsupported.
- Flat ASCII names and create-only UTF-8 text operations; no editing, deletion,
  renaming, nested file paths, or formatted-document generation.
- Timeout/termination is not rollback or proof that an operation never changed
  files. Reads/status/listing are not immutable snapshots; writes are not a
  crash-durability guarantee. Private staging can remain after forced exit.
- This is not isolation against another malicious process running as the same
  OS user, and no independent security audit is claimed.
- History bytes are not tokens or a spending cap. Live requests can incur
  OpenAI usage charges, and live model choices are not verified by mocks.
- Stdout/terminal transcripts may contain requested content; only structured
  diagnostic logs follow the metadata-only privacy policy.

### Validation

- 251 automated tests, runnable without an OpenAI API key or live API calls.
- GitHub Actions baseline: Node.js 22 on Ubuntu 24.04.
- Local validation baseline: Node.js 24 on macOS; live manual smoke tests were
  completed during development.
- See [README](README.md) for setup, configuration, detailed limitations, and
  commands to reproduce tests and coverage.

[1.0.0]: https://github.com/sivanishanthar/ai-task-assistant/releases/tag/v1.0.0
