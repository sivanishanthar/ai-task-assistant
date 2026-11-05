import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { formatHelp } from "../src/help.js";

const PRIVATE_KEY = "sk-FAKE-HELP-KEY-DO-NOT-PRINT";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-help-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, trace: path.join(root, "mock-api-trace.json") };
}

async function runCli({ root, trace }, { args = [], inputs = ["exit"], env = {} } = {}) {
  const cli = fileURLToPath(new URL("../src/agent.js", import.meta.url));
  const loader = fileURLToPath(new URL("./helpers/loggingCliLoader.mjs", import.meta.url));
  return promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-loader", loader, cli, ...args], {
    cwd: root,
    env: { ...process.env, OPENAI_API_KEY: PRIVATE_KEY,
      API_TIMEOUT_MS: "30000", WORKER_TIMEOUT_MS: "10000", MAX_HISTORY_TURNS: "20", MAX_HISTORY_BYTES: "262144",
      LOG_TEST_MODE: "help", HELP_TEST_TRACE: trace, HELP_TEST_INPUTS: JSON.stringify(inputs), HELP_TEST_FAIL_API: "1", ...env },
  });
}

function assertNoSecrets(output) {
  assert.ok(!output.stdout.includes(PRIVATE_KEY));
  assert.ok(!output.stderr.includes(PRIVATE_KEY));
}

test("Help content: five tools, supported names, create-only files, workspace rules, and default limits", () => {
  const text = formatHelp();
  for (const name of ["create_folder", "list_files", "create_file", "write_file", "read_file"]) assert.ok(text.includes(name));
  assert.match(text, /nonempty ASCII letters/);
  assert.match(text, /exactly one dot/);
  assert.match(text, /No spaces, path separators, nested paths, or path traversal/);
  assert.match(text, /INCLUDING EMPTY FILES/);
  assert.match(text, /can never be overwritten/);
  assert.match(text, /do NOT run create_file first/);
  assert.match(text, /102400 bytes \(100 KB\)/);
  assert.match(text, /5 per round; 10 per user request; 5 rounds/);
  assert.match(text, /30000 ms per completion request/);
  assert.match(text, /10000 ms per operation/);
  assert.match(text, /20 turns \(active turn included\); 262144 serialized UTF-8 message bytes/);
  assert.match(text, /symlinks are rejected/);
  assert.match(text, /no API call, tool execution, or history entry/);
});

test("Help content: reflect supplied active limits without serializing unrelated configuration", () => {
  const text = formatHelp({ apiTimeoutMs: 1234, workerTimeoutMs: 5678, maxHistoryTurns: 3,
    maxHistoryBytes: 8192, maxToolCallsPerRequest: 4, maxToolCallsPerRound: 2,
    apiKey: PRIVATE_KEY, prompt: "PRIVATE_PROMPT", workspace: "/PRIVATE_WORKSPACE" });
  assert.match(text, /2 per round; 4 per user request; 5 rounds/);
  assert.match(text, /1234 ms per completion request/);
  assert.match(text, /5678 ms per operation/);
  assert.match(text, /3 turns \(active turn included\); 8192 serialized UTF-8 message bytes/);
  for (const value of [PRIVATE_KEY, "PRIVATE_PROMPT", "/PRIVATE_WORKSPACE"]) assert.ok(!text.includes(value));
});

for (const flag of ["--help", "-h"]) {
  test(`CLI ${flag}: show active limits without an API key, client construction, or filesystem tools`, async t => {
    const files = await fixture(t);
    const output = await runCli(files, { args: [flag], env: {
      OPENAI_API_KEY: "", LOG_TEST_MODE: "constructor",
      API_TIMEOUT_MS: "4567", WORKER_TIMEOUT_MS: "8901", MAX_HISTORY_TURNS: "3", MAX_HISTORY_BYTES: "8192",
    } });
    assert.match(output.stdout, /AI Task Assistant - Help/);
    assert.match(output.stdout, /4567 ms per completion request/);
    assert.match(output.stdout, /8901 ms per operation/);
    assert.match(output.stdout, /3 turns \(active turn included\); 8192 serialized UTF-8 message bytes/);
    assert.equal(output.stderr, "");
    // The mock SDK constructor would throw if reached. No trace or workspace
    // is created, so neither SDK construction nor filesystem tools ran.
    assert.deepEqual(await fs.readdir(files.root), []);
    assertNoSecrets(output);
  });
}

test("CLI interactive help: trim whitespace, ignore case, and make zero API calls or tool logs", async t => {
  const files = await fixture(t);
  const output = await runCli(files, { inputs: ["", " help ", "HELP", "\thelp\t", "exit"] });
  assert.equal((output.stdout.match(/AI Task Assistant - Help/g) ?? []).length, 3);
  assert.match(output.stdout, /Goodbye/);
  assert.equal(output.stderr, "");
  assert.deepEqual(JSON.parse(await fs.readFile(files.trace, "utf8")), { calls: 0, requests: [] });
  await assert.rejects(fs.stat(path.join(files.root, "workspace")), { code: "ENOENT" });
  assertNoSecrets(output);
});

test("CLI interactive help: preserve conversation and route longer help requests normally", async t => {
  const files = await fixture(t);
  const output = await runCli(files, { inputs: ["first real request", "help", "help me write notes", "exit"],
    env: { HELP_TEST_FAIL_API: "0" } });
  const trace = JSON.parse(await fs.readFile(files.trace, "utf8"));
  assert.equal(trace.calls, 2);
  assert.deepEqual(trace.requests[0].messages.map(message => message.role), ["system", "user"]);
  const second = trace.requests[1].messages;
  assert.deepEqual(second.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(second[1].content, "first real request");
  assert.equal(second[2].content, "Mock reply.");
  assert.equal(second[3].content, "help me write notes");
  assert.ok(!JSON.stringify(second).includes("AI Task Assistant - Help"));
  assert.equal((output.stdout.match(/AI Task Assistant - Help/g) ?? []).length, 1);
  assert.equal(output.stderr, "");
  assertNoSecrets(output);
});

test("CLI help: invalid configuration gives a safe local error without an API key or client", async t => {
  const files = await fixture(t);
  await assert.rejects(runCli(files, { args: ["--help"], env: {
    OPENAI_API_KEY: "", LOG_TEST_MODE: "constructor", MAX_HISTORY_TURNS: "0",
  } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /MAX_HISTORY_TURNS and MAX_HISTORY_BYTES/);
    assert.ok(!error.stdout.includes("AI Task Assistant - Help"));
    assert.equal(JSON.parse(error.stderr).stage, "startup");
    assertNoSecrets(error);
    return true;
  });
  assert.deepEqual(await fs.readdir(files.root), []);
});
