# AI Task Assistant

[![Automated Tests](https://github.com/sivanishanthar/ai-task-assistant/actions/workflows/nodejs-tests.yml/badge.svg)](https://github.com/sivanishanthar/ai-task-assistant/actions/workflows/nodejs-tests.yml)

A simple AI-powered task assistant built with **Node.js, JavaScript, and the OpenAI API**.

I started this project to get hands-on experience building AI agents and understanding how they can interact with real tools. Instead of just answering questions, this assistant can carry out basic file and folder operations based on instructions entered in natural language.

The project also gave me an opportunity to apply my experience in QA automation by building automated tests, measuring code coverage, and setting up a CI/CD pipeline using GitHub Actions.

## What Can It Do?

The assistant currently supports five operations:

- **Create folders** — Create a new folder inside the application's workspace.
- **Create files** — Create a new empty file without replacing an existing one.
- **List files and folders** — See what is currently stored in the workspace.
- **Write to files** — Create a new file containing text. All existing files, including empty files, are protected.
- **Read files** — Read the contents of a text file, with a 100 KB size limit.

The assistant also remembers the conversation while it's running, so users can continue interacting with it without starting a new session for every request.

## How It Works

The application runs in the terminal. When a user enters a request, it sends the message to the OpenAI API along with a list of available tools.

The AI decides whether it needs to use one of those tools. If a tool is needed, the application executes the appropriate JavaScript function and sends the result back to the AI.

The assistant then displays the response in the terminal.

```text
       User enters a request
                 |
                 v
          AI Task Assistant
                 |
                 v
             OpenAI API
                 |
                 v
        Selects a tool to use
                 |
                 v
       JavaScript tool executes
                 |
                 v
         Local workspace/
                 |
                 v
        Result returned to AI
                 |
                 v
       Response shown to user
```

For example, if I ask the assistant to create a file called `notes.txt`, it can use the `create_file` tool to create the file inside the workspace.

## Technologies Used

| Technology | How It's Used |
| --- | --- |
| JavaScript | Application and tool development |
| Node.js | Running the application |
| OpenAI API | Understanding requests and selecting tools |
| GPT-4o mini | AI model used by the assistant |
| dotenv | Managing environment variables |
| Node.js Test Runner | Automated unit testing |
| GitHub Actions | Running tests automatically |
| Git and GitHub | Version control and source code management |

## Project Structure

```text
ai-task-assistant/
│
├── .github/
│   └── workflows/
│       └── nodejs-tests.yml
│
├── src/
│   ├── agent.js
│   └── tools/
│       ├── folderTool.js
│       ├── createFileTool.js
│       ├── listFilesTool.js
│       ├── writeFileTool.js
│       └── readFileTool.js
│
├── tests/
│   ├── folderTool.test.js
│   ├── createFileTool.test.js
│   ├── listFileTool.test.js
│   ├── writeFileTool.test.js
│   └── readFileTool.test.js
│
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

Files and folders created by the assistant are stored in a local `workspace/` directory. This directory is excluded from Git.

## Getting Started

You'll need Node.js, npm, and an OpenAI API key to run the assistant. I use Node.js 22 for the automated CI tests.

### 1. Clone the Repository

```bash
git clone https://github.com/sivanishanthar/ai-task-assistant.git
cd ai-task-assistant
```

### 2. Install Dependencies

```bash
npm ci
```

### 3. Set Up Your API Key

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and add your OpenAI API key:

```env
OPENAI_API_KEY=your_actual_api_key
```

Make sure you don't commit your API key to GitHub. The `.env` file is already included in `.gitignore`.

### 4. Run the Assistant

```bash
npm start
```

Once the assistant starts, you can enter requests directly in the terminal.

Type `exit` when you're finished.

## Example Requests

Here are a few things you can ask the assistant to do:

```text
Create a folder called Reports

Create a file called notes.txt

Write "My first AI agent project" into notes.txt

Read notes.txt

Show me all the files and folders in the workspace
```

The assistant uses the available tools to complete these tasks.

## Automated Testing

Since my background is in QA automation, I wanted automated testing to be part of the project from the beginning rather than something added at the end.

I used the built-in Node.js Test Runner to test each of the five tools.

The test cases cover both successful operations and error scenarios, including invalid filenames, duplicate file creation, attempts to overwrite existing content, missing files, and file-size restrictions.

### Run the Tests

```bash
npm test
```

To run the tests with code coverage:

```bash
node --test --experimental-test-coverage tests/*.test.js
```

### Write Safety

`writeFile(fileName, content, workspace?)` now creates files only. Existing empty
files are rejected too: use `write_file` directly to create a file with content,
instead of creating an empty file first. The arguments and success response are
unchanged.

The writer runs in an isolated Node child process, selects each directory
relative to its pinned working directory, and checks directory identity after
selection. Symbolic links anywhere in the workspace path are rejected. On macOS,
use physical paths such as `/private/tmp` rather than the `/tmp` symlink when
supplying a custom workspace. The final workspace must belong to the current
user and must not be writable by group or others. Newly created directories use
mode `0700` and output files use mode `0600` (subject to the process umask).

Content is written in a private staging directory, then published using an atomic
hard link that fails if the destination already exists. Existing files, hard
links, symbolic links, and directories are never opened for writing. Staging is
cleaned on ordinary success and failure. An abrupt process or machine termination
may leave a `.ai-write-*` staging directory; no incomplete destination is
published. This is atomic publication, not a crash-durability guarantee.

This implementation supports macOS and Linux on filesystems supporting hard
links. Windows and filesystems that cannot perform the required operations fail
closed. The child process adds startup overhead per write and requires Node child
process execution to be permitted. This is not an isolation boundary against a
malicious process running as the same OS user, which can access the agent's files
and private staging directories. All five filesystem tools now use
the shared pinned-workspace boundary.

### Read Safety

`readFile(fileName, workspace?)` still returns a UTF-8 string, including an empty
string for an empty file, and retains the optional workspace argument. Missing
workspaces are rejected without creating directories.

Reads use the same verified directory traversal as writes, in an isolated child
process. They require a physical workspace path without symlinks and a final
directory owned by the current user that is not writable by group or others.
This requires macOS or Linux; Windows fails closed.

The reader rejects symlinks, nonregular files, and files with multiple hard links
(including links entirely within the workspace, because their origin cannot be
reliably determined). It opens the file with `O_NOFOLLOW | O_NONBLOCK`, verifies
its device/inode identity, and reads only from that handle. Renaming the pathname
after it is opened cannot redirect the read to a different file.

The read buffer is capped at 100 KB plus one probe byte; files over 100 KB are
rejected even if they grow after the initial size check. UTF-8 decoding happens
after reading so multibyte characters survive short reads. File handles close on
success and failure; primary read errors are preserved if closing also fails.
Detected size or timestamp changes cause rejection, but reads are not immutable
snapshots of files concurrently modified by another process. As with writes,
this is not a security boundary against malicious processes running as the same
OS user. Each read has child-process startup overhead.

### Folder Creation and Listing Safety

`createFolder(folderName, workspace?)` and `listFiles(workspace?)` retain their
arguments, success message, and listing schema. Missing workspaces are created
with mode `0700` (subject to umask), as with writes. Both operations use the shared
pinned-directory traversal in an isolated Node child process, with the same
macOS/Linux, physical-path, workspace-ownership, and permission requirements as
reads and writes. Child-process startup adds overhead per call.

Folder creation uses nonrecursive `mkdir` for the destination relative to the
pinned workspace, with mode `0700`. Repeated creation succeeds only when the
existing destination is a genuine directory. Existing symlinks, dangling links,
and nondirectory entries are rejected; no symlink target is modified.

Listing reads relative to the pinned directory. It returns only regular files
and directories as `{ name, type: "file" | "folder" }`. Symlinks (including links
to directories and dangling links), sockets, FIFOs, devices, and unknown entry
types are omitted instead of being mislabeled as regular files. The agent's tool
description reflects this behavior. Results describe entries observed during
listing, not a guaranteed immutable snapshot or proof that a later operation on
the same name is safe. Each later operation must apply its own checks.

Renaming or replacing the workspace pathname after selection cannot redirect
these operations to the replacement. The same limitation against malicious
processes running as the current OS user still applies.

### Empty File Creation Safety

`createFile(fileName, workspace?)` retains its arguments, success message, and
`EEXIST` behavior for duplicate destinations. It now uses the shared isolated
worker and verified workspace traversal. It requires the same physical workspace
path, current-user ownership, and permissions as the other hardened tools; only
macOS and Linux are supported. Missing workspace components are created with mode
`0700` (subject to umask).

The empty file is created relative to the pinned directory using `wx` and mode
`0600` (subject to umask), then its handle is closed. Existing files, hard links,
directories, and symbolic links (including dangling ones) cause rejection without
following or overwriting them. Replacing the workspace pathname cannot redirect
creation to the replacement. A close failure is reported; the newly created
empty file can remain, so a later retry may return `EEXIST`. No destination is
removed on error because another caller could have replaced it.

Like the other tools, this has child-process startup overhead and does not
isolate against malicious processes running as the same OS user. Files created
by `create_file` remain empty: use `write_file` directly when creating a file
with content, since it rejects existing empty files too.

### Offline Agent Workflow Tests

The terminal application uses `createAgent` from `src/agentCore.js`. That module
accepts an OpenAI-compatible client and an optional test workspace, and does not
import the SDK, load `.env`, create a terminal interface, or require an API key.
`src/agent.js` remains the real CLI and still requires `OPENAI_API_KEY` for live
requests. Tool definitions are shared through `src/agentTools.js`.

Run the mocked workflow tests alone:

```bash
npm run test:agent
```

The tests script `chat.completions.create` responses while executing the real
filesystem tools in isolated temporary workspaces. They cover folder creation,
writing directly to a new file, listing and reading, overwrite rejection, empty
file protection, invalid paths, workspace isolation, conversation memory,
malformed arguments, unknown tools, API failures, and tool execution limits.
They also verify that every tool result is matched to the correct call ID and
that subsequent requests contain valid message history. Network fetch calls are
blocked in these tests; an additional subprocess test runs with an empty API key.
No live OpenAI client is constructed and there is no fallback to a real service.

`npm test` and the existing full coverage command include these tests. GitHub
Actions runs the full suite with `OPENAI_API_KEY` explicitly empty; no repository
secret or OpenAI API spend is needed. Normal dependency installation still uses
the npm registry. These tests verify application orchestration and tool behavior;
scripted model responses do not prove a live model will choose the right tools.

### Per-Request Tool Limits

The CLI accepts at most **5 tool calls in one round** and **10 tool calls in a
single user request**, while retaining the existing maximum of **5 rounds**.
Failed calls, malformed arguments, and unsupported tool attempts count toward
the total just like successful calls.

A batch exceeding either the per-round cap or the remaining request budget is
rejected in full before any call in that batch executes. It is not partially
executed. Work completed in earlier accepted rounds remains in place. The agent
returns a clear limit message without making another completion request for
that rejected batch. A normal final text response is still allowed after exactly
using the call budget.

Rejected assistant tool requests are not stored in history and receive no fake
tool results. Instead, the limit notice is saved as a plain assistant message,
so later turns have valid history with no unresolved tool-call IDs. Each new
user request starts with fresh budgets, including after a previous API error.
Rejected calls do not invoke execution hooks or emit tool-execution log records.

Programmatic callers can configure both call caps when creating an agent:

```js
const agent = createAgent({
  openai,
  maxToolCallsPerRequest: 10,
  maxToolCallsPerRound: 5,
});
```

Both options must be positive safe integers. The CLI uses these defaults;
mocked tests verify exact boundaries, batch rejection, failed-attempt accounting,
and valid history on subsequent requests without live API calls.

### Configurable Timeouts

The defaults are **30 seconds per OpenAI completion request** and **10 seconds
per filesystem worker**, including startup, IPC, and waiting for worker exit.
These are per operation, not a single deadline for the entire conversation turn.
Configure the CLI through `.env` or environment variables:

```env
API_TIMEOUT_MS=30000
WORKER_TIMEOUT_MS=10000
```

Both values must be integer milliseconds between `1` and `2147483647`. Zero,
negative, fractional, invalid, or overflowing values are rejected before work
starts. Programmatic callers can pass `apiTimeoutMs` and `workerTimeoutMs` to
`createAgent`. Direct tools accept a trailing `{ timeoutMs }` option without
changing their existing argument order or success responses:

```js
const agent = createAgent({ openai, apiTimeoutMs: 30000, workerTimeoutMs: 10000 });
await readFile("notes.txt", workspace, { timeoutMs: 10000 });
await writeFile("notes.txt", "text", workspace, { timeoutMs: 10000 });
```

OpenAI calls receive an `AbortSignal`, SDK timeout, and `maxRetries: 0`. The
application deadline also rejects clients that ignore cancellation, and consumes
late resolutions/rejections without executing late tool calls. Request messages
are snapshotted before sending. This follows the SDK's documented
[cancellation, timeout, and retry options](https://developers.openai.com/api/reference/typescript).
On timeout, the core throws `OPENAI_TIMEOUT`; the CLI displays a clear safe error,
resets conversation history, and accepts another request. Any already completed
filesystem work remains in place.

Worker deadlines send `SIGKILL` and reject with `WORKER_TIMEOUT`. The agent stops
that turn instead of automatically retrying or executing more tools. Remaining
calls from the same batch get explicit skipped results, matching every pending
call ID and leaving valid history for the next turn. Only attempted tools are
logged, with timeout attempts recorded as failures. Timers are cleared when work
settles; late messages, errors, callbacks, and responses cannot change the result.

**Termination is not rollback.** Files or directories may already exist, a write
may already have been published, and private staging directories can remain after
a worker is killed. No parent-side deletion is attempted. Inspect the workspace
before retrying. `SIGKILL` is requested immediately, but the parent does not wait
indefinitely for an OS that cannot reap the process promptly or refuses the kill.
The error therefore reports an unknown outcome, not proof of cancellation before
side effects. Logs continue to exclude prompts, keys, paths, content, and raw SDK
or transport errors.

Offline tests trigger deadlines with a controlled clock, verify abort signals and
late-result handling, terminate an actual stalled Node worker after its startup
acknowledgment, and verify recovery/history without live OpenAI calls or sleeps.

### Bounded Conversation History

The defaults retain at most **20 turns** and **256 KiB (262144 bytes)** of
serialized message history. A turn starts at a user message and includes all its
assistant tool calls, matching tool results, and final assistant response. The
turn cap includes the active turn when making an API request. Configure the CLI
through `.env` or environment variables:

```env
MAX_HISTORY_TURNS=20
MAX_HISTORY_BYTES=262144
```

Programmatic callers can pass `maxHistoryTurns` and `maxHistoryBytes` to
`createAgent`. Both must be positive safe integers; zero does not disable limits.
The byte budget measures UTF-8 bytes of the serialized `messages` array,
including system instructions, call arguments, IDs, and results. It is **not a
token limit** and does not include the separate tool schemas or request metadata.

Before every completion request, the agent evicts the oldest completed turns
until both limits fit. It never removes system instructions, splits a turn,
or separates tool calls from results. The current active turn is protected.
Incoming tool requests that cannot fit are rejected before their tools execute.
If the active input or tool results still exceed the budget after removing older
turns, `HISTORY_LIMIT` is returned instead of sending an oversized API request.
The CLI explains the limit and resets history for recovery. Completed filesystem
changes remain; history eviction never deletes files or rolls back tools.

After a final answer or limit/timeout notice, retention is checked again. A final
answer too large to retain is returned normally, but its entire completed turn
is evicted if necessary. Older context may therefore be forgotten, including a
large most-recent response. No text is silently truncated or summarized, and
trimming makes no additional API calls. Tool results can temporarily occupy the
active working history while a batch runs, but are checked before the next API
request and are not retained beyond the completed-turn budget. A byte budget too
small even for system instructions causes requests to fail; increase it rather
than removing the instructions.

Offline regression tests verify whole-turn eviction, active multi-round tool
integrity, exact UTF-8 boundaries, oversized tool input/output, large final
responses, API-error recovery, and trimming of complete limit/timeout turns.

### Structured Diagnostic Logging

The CLI emits one JSON line to **stderr** for every executed tool call:

```json
{"timestamp":"2026-11-04T12:00:00.000Z","event":"tool_execution","tool":"write_file","duration_ms":34.2,"status":"success"}
```

Duration uses a monotonic clock and includes the tool's filesystem worker time.
Status comes from the actual execution outcome, not from matching text in the
result. Rejected overwrites, invalid arguments, malformed JSON, unsupported
tools, and filesystem failures are recorded as failures. Only the five known
tool names are allowed; unknown names are logged as `unknown`.

The logger constructs records from an allowlist. It excludes API keys, prompts,
file contents, filenames, workspace paths, arguments, tool results, call IDs,
raw errors, and stack traces. Request/startup/fatal errors generate a coarse
`agent_failure` event with a fixed stage and no raw error message. The previous
raw `[Tool result: ...]` console output has been removed. Synchronous and
asynchronous logging-sink failures are best-effort and do not change tool results.

The ordinary conversation remains on **stdout** and can intentionally contain
file contents when the user asks to read them. A complete terminal transcript is
therefore not a redacted diagnostic log. To capture application diagnostics
separately, use:

```bash
npm start 2> tool-events.jsonl
```

No log files are written automatically, and no new dependencies or external
logging service are required. Programmatic callers can pass a `logger` to
`createAgent`; the CLI supplies `createLogger()` by default. Existing custom
`onToolCall`/`onToolResult` hooks remain available and receive their original raw
values, so custom hook implementations must apply their own privacy policy.
Offline tests exercise metadata redaction, outcome classification, sink failures,
and the actual CLI with fake SDK/terminal modules, including raw-error redaction.

### Local Help Command

In a running session, type `help` to see the five tools, folder/file name rules,
create-only file behavior, workspace requirements, and configured tool, read,
timeout, and history limits. The command is case-insensitive and ignores leading
or trailing whitespace. It is handled locally before model dispatch: no OpenAI
request, filesystem tool, tool-execution log, conversation-history entry, or tool
budget is used. Normal requests such as `help me write notes` still go to the
model.

For help without an API key or starting a model session:

```bash
npm start -- --help
# Short alias:
npm start -- -h
```

These flags return before constructing the OpenAI client or terminal interface.
Help reads the same validated startup settings as the CLI and shows active
`API_TIMEOUT_MS`, `WORKER_TIMEOUT_MS`, `MAX_HISTORY_TURNS`, and
`MAX_HISTORY_BYTES` values. Invalid settings produce a local configuration error.
Restart after changing `.env`. No API key value, workspace path, or other private
configuration is included in the help text. Execution and help share constants
for tool caps, maximum rounds, and the file-read byte limit.

Offline tests exercise the real CLI with fake SDK/terminal modules. They verify
zero API calls for local help, no client construction for `--help`/`-h`, unchanged
conversation history across help, whitespace/case handling, and custom limits.

### Test Isolation

One improvement I made during development was separating the test environment from the application's actual workspace.

Each test now creates its own temporary directory using `fs.mkdtemp()`. Once the test finishes, that directory is removed.

This means tests can create, read, and delete files without affecting the files created by the AI assistant.

## CI/CD with GitHub Actions

I also set up a GitHub Actions workflow to automatically run the tests whenever I push changes to the `main` branch or create a pull request targeting it.

The pipeline:

1. Checks out the latest code.
2. Sets up Node.js 22.
3. Installs dependencies using `npm ci`.
4. Runs all automated tests.
5. Generates a code coverage report.

This helps me catch issues early and confirm that changes work in a clean environment, not just on my local machine.

You can see the latest results here:

[View GitHub Actions](https://github.com/sivanishanthar/ai-task-assistant/actions)

## A Few Things I've Focused On

While building this project, I tried to keep the tools simple and predictable.

For example, the assistant checks filenames before using them and rejects writes to all existing files, including empty files. The file-reading tool also checks that the requested path is a regular file and rejects files over 100 KB.

These checks reduce the risk of unexpected file operations, although the project is still a learning application and hasn't been security-audited. Some filesystem operations can also be affected by race conditions.

## What I've Learned

This project has helped me better understand:

- How OpenAI function calling works in a real Node.js application.
- How to connect AI-generated tool requests to JavaScript functions.
- How to structure an application into smaller, reusable modules.
- How to validate inputs and handle errors.
- How to write and organize automated unit tests.
- Why test isolation matters.
- How to measure code coverage.
- How to use GitHub Actions to run tests automatically.

It has also been a useful way to combine my QA automation experience with AI development.

## What's Next?

There are a few areas I'd like to explore as I continue improving the project:

- Add more tests for error-handling scenarios.
- Improve filesystem safety and error handling.
- Add additional tools to make the assistant more useful.
- Extend diagnostic logging with optional local analysis tools.
- Add automated tests for the agent's tool-calling logic.
- Explore storing conversation history between sessions.

For now, the focus is on keeping the assistant simple, reliable, and easy to extend.

## About This Project

I built AI Task Assistant as a personal learning project to explore AI agents while applying software testing and automation practices.

The source code is available here:

[GitHub — AI Task Assistant](https://github.com/sivanishanthar/ai-task-assistant)

**Developed by [Siva Ramachandran](https://github.com/sivanishanthar)**