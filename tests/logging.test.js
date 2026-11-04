import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logger.js";
import { createAgent } from "../src/agentCore.js";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");
const PRIVATE_KEY = "sk-FAKE-KEY-DO-NOT-LOG";
const PRIVATE_PROMPT = "PRIVATE_PROMPT_DO_NOT_LOG";
const PRIVATE_CONTENT = "Tool execution error: PRIVATE_CONTENT_DO_NOT_LOG";
const PRIVATE_FILENAME = "private_filename.txt";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-log-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  return { root, workspace };
}

function recorder() {
  const lines = [];
  return { lines, logger: createLogger({ write: line => lines.push(line), now: () => FIXED_DATE }) };
}

function assertPrivate(text) {
  for (const value of [PRIVATE_KEY, PRIVATE_PROMPT, PRIVATE_CONTENT, PRIVATE_FILENAME]) {
    assert.ok(!text.includes(value), `diagnostic output exposed ${value}`);
  }
}

test("Logging: serialize only the tool metadata allowlist", () => {
  const { lines, logger } = recorder();
  logger.toolExecution({ tool: "read_file", durationMs: 12.5, success: true,
    apiKey: PRIVATE_KEY, prompt: PRIVATE_PROMPT, content: PRIVATE_CONTENT, fileName: PRIVATE_FILENAME,
    error: new Error(PRIVATE_KEY) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("\n"));
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: FIXED_DATE.toISOString(), event: "tool_execution", tool: "read_file", duration_ms: 12.5, status: "success",
  });
  assertPrivate(lines[0]);
});

test("Logging: tool and failure-stage names cannot inject untrusted content or log lines", () => {
  const { lines, logger } = recorder();
  logger.toolExecution({ tool: PRIVATE_KEY + "\n" + PRIVATE_PROMPT, durationMs: 1, success: false });
  logger.agentFailure(PRIVATE_KEY + "\n" + PRIVATE_CONTENT);
  assert.equal(lines.length, 2);
  assert.equal(lines.join("").split("\n").filter(Boolean).length, 2);
  assert.equal(JSON.parse(lines[0]).tool, "unknown");
  assert.deepEqual(JSON.parse(lines[1]), {
    timestamp: FIXED_DATE.toISOString(), event: "agent_failure", stage: "unknown", status: "failure",
  });
  assertPrivate(lines.join(""));
});

test("Logging: preserve all supported tool names and normalize invalid durations", () => {
  const { lines, logger } = recorder();
  for (const name of ["create_folder", "list_files", "create_file", "write_file", "read_file"]) {
    logger.toolExecution({ tool: name, durationMs: 0, success: true });
    assert.equal(JSON.parse(lines.at(-1)).tool, name);
  }
  for (const durationMs of [-5, NaN, Infinity, "secret", undefined]) {
    logger.toolExecution({ tool: "write_file", durationMs, success: false });
    assert.equal(JSON.parse(lines.at(-1)).duration_ms, 0);
    assert.equal(JSON.parse(lines.at(-1)).status, "failure");
  }
});

test("Logging: synchronous and asynchronous sink failures are best-effort", async () => {
  for (const write of [() => { throw new Error(PRIVATE_CONTENT); }, async () => { throw new Error(PRIVATE_KEY); }]) {
    const logger = createLogger({ write });
    assert.doesNotThrow(() => logger.toolExecution({ tool: "read_file", durationMs: 1, success: true }));
    assert.doesNotThrow(() => logger.agentFailure("request"));
  }
  // Drain promise handlers, without a timer or timing-based assertion.
  await Promise.resolve();
});

function tool(id, name, args) {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

function mockClient(messages) {
  let index = 0;
  return { chat: { completions: { async create() {
    assert.ok(index < messages.length, "unexpected completion call; no live fallback");
    return { choices: [{ message: messages[index++] }] };
  } } } };
}

test("Logging integration: actual tool outcomes determine status without leaking input or output", async t => {
  const { workspace } = await fixture(t);
  const { lines, logger } = recorder();
  const openai = mockClient([
    { role: "assistant", tool_calls: [tool("write", "write_file", { fileName: PRIVATE_FILENAME, content: PRIVATE_CONTENT })] },
    { role: "assistant", tool_calls: [
      tool("read", "read_file", { fileName: PRIVATE_FILENAME }),
      tool("overwrite", "write_file", { fileName: PRIVATE_FILENAME, content: PRIVATE_KEY }),
      tool("bad-folder", "create_folder", { folderName: "../" + PRIVATE_PROMPT }),
      tool("unknown", PRIVATE_KEY + "\n" + PRIVATE_PROMPT, {}),
      tool("bad-json", "create_file", "{" + PRIVATE_KEY),
    ] },
    { role: "assistant", content: "Done." },
  ]);
  const observedResults = [];
  const agent = createAgent({ openai, workspace, logger, onToolResult: value => observedResults.push(value) });
  assert.equal(await agent.respond(PRIVATE_PROMPT + " " + PRIVATE_KEY), "Done.");
  const records = lines.map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.tool),
    ["write_file", "read_file", "write_file", "create_folder", "unknown", "create_file"]);
  assert.deepEqual(records.map(record => record.status), ["success", "success", "failure", "failure", "failure", "failure"]);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ["duration_ms", "event", "status", "timestamp", "tool"]);
    assert.ok(Number.isFinite(record.duration_ms) && record.duration_ms >= 0);
  }
  // A valid read beginning with "Tool execution error:" is still successful.
  assert.equal(observedResults[1], PRIVATE_CONTENT);
  assert.equal(await fs.readFile(path.join(workspace, PRIVATE_FILENAME), "utf8"), PRIVATE_CONTENT);
  assertPrivate(lines.join(""));
  assert.ok(!lines.join("").includes(workspace));
});

for (const asynchronous of [false, true]) {
  test(`Logging integration: ${asynchronous ? "async" : "sync"} custom logger failure cannot alter tool results`, async t => {
    const { workspace } = await fixture(t);
    const log = () => { throw new Error(PRIVATE_KEY); };
    const logger = { toolExecution: asynchronous ? async () => log() : log };
    const openai = mockClient([
      { role: "assistant", tool_calls: [tool("write", "write_file", { fileName: "safe.txt", content: "safe" })] },
      { role: "assistant", content: "Created." },
    ]);
    assert.equal(await createAgent({ openai, workspace, logger }).respond("Create a file."), "Created.");
    assert.equal(await fs.readFile(path.join(workspace, "safe.txt"), "utf8"), "safe");
  });
}

for (const mode of ["success", "request", "fatal", "startup", "constructor", "request_timeout", "invalid_timeout"]) {
  test(`CLI logging: ${mode} path excludes private prompts, content, key, filenames, and raw errors`, async t => {
    const { root, workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, PRIVATE_FILENAME), PRIVATE_CONTENT);
    const cli = fileURLToPath(new URL("../src/agent.js", import.meta.url));
    const loader = fileURLToPath(new URL("./helpers/loggingCliLoader.mjs", import.meta.url));
    let output;
    try {
      output = await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-loader", loader, cli], {
        cwd: root,
        env: { ...process.env,
          OPENAI_API_KEY: mode === "startup" ? "" : PRIVATE_KEY,
          API_TIMEOUT_MS: mode === "invalid_timeout" ? "0" : "30000", WORKER_TIMEOUT_MS: "10000",
          LOG_TEST_MODE: mode, LOG_TEST_PROMPT: PRIVATE_PROMPT,
          LOG_TEST_FILENAME: PRIVATE_FILENAME,
          LOG_TEST_PRIVATE_ERROR: [PRIVATE_KEY, PRIVATE_PROMPT, PRIVATE_CONTENT, PRIVATE_FILENAME].join(" "),
        },
      });
      assert.ok(["success", "request", "request_timeout"].includes(mode), "fatal/startup must exit with a failure code");
    } catch (error) {
      assert.ok(["fatal", "startup", "constructor", "invalid_timeout"].includes(mode), `unexpected CLI failure: ${error.message}`);
      assert.equal(error.code, 1);
      output = error;
    }
    assertPrivate(output.stderr);
    assertPrivate(output.stdout);
    const records = output.stderr.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    if (mode === "success") {
      assert.equal(records[0].event, "tool_execution");
      assert.equal(records[0].tool, "read_file");
      assert.equal(records[0].status, "success");
      assert.match(output.stdout, /Read completed/);
    } else {
      assert.deepEqual({ ...records[0], timestamp: undefined },
        { timestamp: undefined, event: "agent_failure", stage: mode === "constructor" ? "fatal" : mode === "request_timeout" ? "request" : mode === "invalid_timeout" ? "startup" : mode, status: "failure" });
    }
    if (mode === "request_timeout") assert.match(output.stdout, /OpenAI request timed out/);
    if (mode === "invalid_timeout") assert.match(output.stdout, /API_TIMEOUT_MS and WORKER_TIMEOUT_MS/);
    assert.ok(!output.stderr.includes("Tool result"));
  });
}
