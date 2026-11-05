import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgent } from "../src/agentCore.js";
import { formatHelp } from "../src/help.js";

test.beforeEach(t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live network calls are forbidden"); });
});

const tool = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answer = content => ({ role: "assistant", content });
const response = message => ({ choices: [{ message }] });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-reset-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { mode: 0o700 });
  return { root, workspace, trace: path.join(root, "trace.json") };
}

test("Reset core: erase complete tool history, preserve instructions, configuration, and files", async t => {
  const { workspace } = await fixture(t);
  const requests = [];
  const events = [];
  const openai = { chat: { completions: { async create(request, options) {
    requests.push(structuredClone(request));
    assert.equal(options.timeout, 1234, "configuration must survive reset");
    if (requests.length === 1) return response({ role: "assistant", content: null,
      tool_calls: [tool("write", "write_file", { fileName: "keep.txt", content: "PROTECTED" })] });
    if (requests.length === 2) return response(answer("Created."));
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
    assert.deepEqual(request.messages[0], requests[0].messages[0]);
    assert.match(request.messages[0].content, /Never offer overwriting/);
    assert.equal(request.messages[1].content, "fresh question");
    assert.ok(!JSON.stringify(request.messages).includes("PROTECTED"));
    return response(answer("Fresh response."));
  } } } };
  const agent = createAgent({ openai, workspace, apiTimeoutMs: 1234, maxToolCallsPerRequest: 1,
    logger: { toolExecution: event => events.push(event) } });
  assert.equal(await agent.respond("old private question"), "Created.");
  const before = await fs.stat(path.join(workspace, "keep.txt"));
  agent.reset();
  assert.equal(requests.length, 2, "reset must not call the client");
  assert.equal(events.length, 1, "reset must not emit a tool execution log");
  assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "PROTECTED");
  const after = await fs.stat(path.join(workspace, "keep.txt"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal(await agent.respond("fresh question"), "Fresh response.");
});

test("Reset core: repeated resets on empty or populated history are idempotent", async () => {
  const snapshots = [];
  const openai = { chat: { completions: { async create(request) {
    snapshots.push(structuredClone(request.messages));
    return response(answer("ok"));
  } } } };
  const agent = createAgent({ openai });
  agent.reset();
  agent.reset();
  assert.equal(snapshots.length, 0);
  await agent.respond("one");
  agent.reset();
  agent.reset();
  await agent.respond("two");
  assert.deepEqual(snapshots[1].map(message => message.role), ["system", "user"]);
  assert.deepEqual(snapshots[1][0], snapshots[0][0]);
  assert.equal(snapshots[1][1].content, "two");
});

test("Reset core: reject reset during an active request, then allow it after completion", async () => {
  let complete;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const openai = { chat: { completions: { create(request) {
    if (requests++ === 0) {
      started();
      return new Promise(resolve => { complete = resolve; });
    }
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
    return Promise.resolve(response(answer("Recovered.")));
  } } } };
  const agent = createAgent({ openai });
  const pending = agent.respond("pending");
  await ready;
  assert.throws(() => agent.reset(), /Cannot reset while a request is active/);
  complete(response(answer("Done.")));
  assert.equal(await pending, "Done.");
  agent.reset();
  assert.equal(await agent.respond("fresh"), "Recovered.");
});

test("Reset core: explicit reset after API failure remains safe", async () => {
  const failure = new Error("offline mock failure");
  let calls = 0;
  const openai = { chat: { completions: { async create(request) {
    if (calls++ === 0) throw failure;
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
    return response(answer("Recovered."));
  } } } };
  const agent = createAgent({ openai });
  await assert.rejects(agent.respond("fail"), error => error === failure);
  assert.doesNotThrow(() => agent.reset());
  assert.equal(await agent.respond("next"), "Recovered.");
});

async function cli(files, inputs, extraEnv = {}) {
  return promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-loader",
    fileURLToPath(new URL("./helpers/loggingCliLoader.mjs", import.meta.url)),
    fileURLToPath(new URL("../src/agent.js", import.meta.url))], {
    cwd: files.root,
    env: { ...process.env, OPENAI_API_KEY: "sk-FAKE-RESET-KEY", API_TIMEOUT_MS: "30000", WORKER_TIMEOUT_MS: "10000",
      MAX_HISTORY_TURNS: "20", MAX_HISTORY_BYTES: "262144", LOG_TEST_MODE: "help",
      HELP_TEST_TRACE: files.trace, HELP_TEST_INPUTS: JSON.stringify(inputs), HELP_TEST_FAIL_API: "1", ...extraEnv },
  });
}

test("Reset CLI: whitespace/case and repeated resets stay offline and leave workspace files untouched", async t => {
  const files = await fixture(t);
  await fs.writeFile(path.join(files.workspace, "keep.txt"), "PROTECTED");
  await fs.mkdir(path.join(files.workspace, "KeepFolder"));
  const output = await cli(files, [" reset ", "RESET", "\treset\t", "exit"]);
  assert.equal((output.stdout.match(/Conversation history cleared/g) ?? []).length, 3);
  assert.equal(output.stderr, "");
  assert.ok(!output.stdout.includes("sk-FAKE-RESET-KEY"));
  assert.deepEqual(JSON.parse(await fs.readFile(files.trace, "utf8")), { calls: 0, requests: [] });
  assert.equal(await fs.readFile(path.join(files.workspace, "keep.txt"), "utf8"), "PROTECTED");
  assert.deepEqual((await fs.readdir(files.workspace)).sort(), ["KeepFolder", "keep.txt"]);
});

test("Reset CLI: clear old context without adding reset/confirmation, and route longer requests normally", async t => {
  const files = await fixture(t);
  const output = await cli(files, ["old private request", "reset", "reset my plan", "exit"], { HELP_TEST_FAIL_API: "0" });
  const trace = JSON.parse(await fs.readFile(files.trace, "utf8"));
  assert.equal(trace.calls, 2, "only the two natural-language requests call the mocked model");
  const second = trace.requests[1].messages;
  assert.deepEqual(second.map(message => message.role), ["system", "user"]);
  assert.deepEqual(second[0], trace.requests[0].messages[0]);
  assert.equal(second[1].content, "reset my plan");
  assert.ok(!JSON.stringify(second).includes("old private request"));
  assert.ok(!JSON.stringify(second).includes("Conversation history cleared"));
  assert.equal(output.stderr, "");
});

test("Reset help: describe the local command and preservation guarantees", () => {
  assert.match(formatHelp(), /reset\s+Clear conversation history locally; keep system instructions and workspace files\. No API call/);
});
