import test from "node:test";
import assert from "node:assert/strict";
import timers from "node:timers";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAgent } from "../src/agentCore.js";
import { withApiTimeout, validateTimeout, timeoutConfigFromEnv, WORKER_TIMEOUT_NOTICE } from "../src/timeouts.js";
import { runWorker } from "../src/tools/workerClient.js";
import { createFolder } from "../src/tools/folderTool.js";
import { createFile } from "../src/tools/createFileTool.js";
import { listFiles } from "../src/tools/listFilesTool.js";
import { readFile } from "../src/tools/readFileTool.js";
import { writeFile } from "../src/tools/writeFileTool.js";

test.beforeEach(t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live network calls are forbidden"); });
});

// Fire deadlines explicitly; no sleeps or elapsed-wall-time assertions.
function clock(t) {
  const tasks = [];
  t.mock.method(timers, "setTimeout", (callback, ms) => {
    const task = { callback, ms, active: true };
    tasks.push(task);
    return task;
  });
  t.mock.method(timers, "clearTimeout", task => { task.active = false; });
  return {
    tasks,
    active: () => tasks.filter(task => task.active),
    fire(ms) {
      const task = tasks.find(task => task.active && task.ms === ms);
      assert.ok(task, `expected active deadline of ${ms} ms`);
      task.active = false;
      task.callback();
    },
  };
}

const tool = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const calls = (...toolCalls) => ({ role: "assistant", tool_calls: toolCalls, content: null });
const answer = content => ({ role: "assistant", content });
const response = message => ({ choices: [{ message }] });

function assertHistory(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === "tool") assert.ok(pending.delete(message.tool_call_id), "unmatched result");
    else {
      assert.equal(pending.size, 0, "unresolved tools before next message");
      for (const item of message.tool_calls ?? []) pending.add(item.id);
    }
  }
  assert.equal(pending.size, 0);
}

function fakeChild(reply) {
  const child = new EventEmitter();
  child.signals = [];
  child.send = (request, callback) => {
    child.request = request;
    child.sendCallback = callback;
    callback(null);
    if (reply) queueMicrotask(() => { child.emit("message", reply); child.emit("exit", 0, null); });
  };
  child.kill = signal => { child.signals.push(signal); child.emit("exit", null, signal); return true; };
  return child;
}

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-deadline-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

for (const late of ["resolve", "reject"]) {
  test(`API deadline: abort, reset history, recover, and ignore late ${late}`, async t => {
    const time = clock(t);
    const workspace = await fixture(t);
    let settleLate;
    let firstOptions;
    let requests = 0;
    let executed = 0;
    const openai = { chat: { completions: { create(request, options) {
      assertHistory(request.messages);
      assert.equal(options.maxRetries, 0);
      assert.equal(options.timeout, 100);
      if (requests++ === 0) {
        firstOptions = options;
        return new Promise((resolve, reject) => { settleLate = late === "resolve" ? resolve : reject; });
      }
      assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
      assert.equal(request.messages[1].content, "Recover.");
      return Promise.resolve(response(answer("Recovered.")));
    } } } };
    const agent = createAgent({ openai, workspace, apiTimeoutMs: 100, onToolCall: () => executed++ });
    const first = agent.respond("Private prompt.");
    await Promise.resolve();
    const rejected = assert.rejects(first, error => error.code === "OPENAI_TIMEOUT" && /timed out after 100 ms/.test(error.message));
    time.fire(100);
    await rejected;
    assert.equal(firstOptions.signal.aborted, true);
    assert.equal(time.active().length, 0);
    assert.equal(await agent.respond("Recover."), "Recovered.");
    settleLate(late === "resolve"
      ? response(calls(tool("late", "write_file", { fileName: "never.txt", content: "unsafe" })))
      : new Error("PRIVATE_LATE_ERROR"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(executed, 0);
    assert.deepEqual(await fs.readdir(workspace), []);
    assert.equal(time.active().length, 0);
  });
}

test("API deadline: signal cancellation reaches an abort-aware client", async t => {
  const time = clock(t);
  let aborted = false;
  const pending = withApiTimeout(signal => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("SDK abort error")); }, { once: true });
  }), 50);
  await Promise.resolve();
  const rejected = assert.rejects(pending, { code: "OPENAI_TIMEOUT" });
  time.fire(50);
  await rejected;
  assert.equal(aborted, true);
  assert.equal(time.active().length, 0);
});

test("API deadline: success, synchronous errors, and SDK timeouts all clear timers", async t => {
  const time = clock(t);
  let signal;
  assert.equal(await withApiTimeout(value => { signal = value; return "ok"; }, 100), "ok");
  assert.equal(time.active().length, 0);
  time.tasks[0].callback(); // A stale queued callback must not abort success.
  assert.equal(signal.aborted, false);
  const original = new Error("original");
  await assert.rejects(withApiTimeout(() => { throw original; }, 100), error => error === original);
  const sdkError = Object.assign(new Error("PRIVATE_SDK_ERROR"), { name: "APIConnectionTimeoutError" });
  await assert.rejects(withApiTimeout(() => Promise.reject(sdkError), 100), error => {
    assert.equal(error.code, "OPENAI_TIMEOUT");
    assert.ok(!error.message.includes("PRIVATE_SDK_ERROR"));
    return true;
  });
  assert.equal(time.active().length, 0);
});

const tools = [
  ["create_folder", options => createFolder("Folder", "/unused", options), { ok: true, result: "created" }],
  ["create_file", options => createFile("file.txt", "/unused", options), { ok: true, result: "created" }],
  ["list_files", options => listFiles("/unused", options), { ok: true, result: [] }],
  ["read_file", options => readFile("file.txt", "/unused", options), { ok: true, content: "safe" }],
  ["write_file", options => writeFile("file.txt", "safe", "/unused", options), { ok: true }],
];

for (const [name, invoke, reply] of tools) {
  test(`Worker deadline: ${name} sends SIGKILL, ignores late events, and permits recovery`, async t => {
    const time = clock(t);
    const stalled = fakeChild();
    const next = fakeChild(reply);
    let forks = 0;
    t.mock.method(childProcess, "fork", () => forks++ === 0 ? stalled : next);
    const pending = invoke({ timeoutMs: 25 });
    const rejected = assert.rejects(pending, error => error.code === "WORKER_TIMEOUT" && /outcome is unknown/.test(error.message));
    time.fire(25);
    await rejected;
    assert.deepEqual(stalled.signals, ["SIGKILL"]);
    assert.equal(time.active().length, 0);
    stalled.emit("message", reply);
    stalled.emit("error", new Error("late private IPC error"));
    stalled.sendCallback(new Error("late send error"));
    time.tasks[0].callback();
    assert.deepEqual(stalled.signals, ["SIGKILL"]);
    await invoke({ timeoutMs: 25 });
    assert.equal(forks, 2);
    assert.deepEqual(next.signals, []);
    assert.equal(time.active().length, 0);
  });
}

test("Worker deadline: a real stalled child exits from SIGKILL after deterministic deadline firing", async t => {
  const time = clock(t);
  const fork = childProcess.fork.bind(childProcess);
  let child;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  t.mock.method(childProcess, "fork", (...args) => {
    child = fork(...args);
    child.once("message", () => readyResolve());
    child.once("error", readyReject);
    child.once("exit", () => readyReject(new Error("worker exited before acknowledgment")));
    return child;
  });
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const pending = runWorker(new URL("./helpers/stalledWorker.mjs", import.meta.url), {}, {
    timeoutMs: 100, label: "Test worker", accept: () => true,
  });
  const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
  await ready; // Start deadline only after an IPC acknowledgment, not a sleep.
  const exited = once(child, "exit");
  time.fire(100);
  await rejected;
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(time.active().length, 0);
});

test("Worker timeout: stop remaining batch, report skipped IDs, and recover with valid history", async t => {
  const time = clock(t);
  const workspace = await fixture(t);
  const stalled = fakeChild();
  let forks = 0;
  t.mock.method(childProcess, "fork", () => { forks++; return stalled; });
  const histories = [];
  let completions = 0;
  const openai = { chat: { completions: { async create(request) {
    histories.push(structuredClone(request.messages));
    assertHistory(request.messages);
    return response(completions++ === 0
      ? calls(tool("stalled", "write_file", { fileName: "first.txt", content: "private" }),
          tool("skipped", "create_file", { fileName: "never.txt" }))
      : answer("Recovered."));
  } } } };
  const logs = [];
  const agent = createAgent({ openai, workspace, apiTimeoutMs: 200, workerTimeoutMs: 50,
    logger: { toolExecution: event => logs.push(event) } });
  const pending = agent.respond("Create files.");
  for (let i = 0; i < 20 && !time.active().some(task => task.ms === 50); i++) await Promise.resolve();
  time.fire(50);
  assert.equal(await pending, WORKER_TIMEOUT_NOTICE);
  assert.equal(forks, 1);
  assert.equal(completions, 1, "do not ask the model to retry after a worker timeout");
  assert.deepEqual(logs.map(item => [item.tool, item.success]), [["write_file", false]]);
  assert.equal(await agent.respond("Recover."), "Recovered.");
  const results = histories[1].filter(message => message.role === "tool");
  assert.deepEqual(results.map(message => message.tool_call_id), ["stalled", "skipped"]);
  assert.match(results[0].content, /worker timed out/);
  assert.match(results[1].content, /not executed/);
  assert.deepEqual(await fs.readdir(workspace), []);
  assert.equal(time.active().length, 0);
});

test("Timeout configuration: defaults, overrides, environment, and invalid timer ranges", () => {
  assert.deepEqual(timeoutConfigFromEnv({}), { apiTimeoutMs: 30000, workerTimeoutMs: 10000 });
  assert.deepEqual(timeoutConfigFromEnv({ API_TIMEOUT_MS: "100", WORKER_TIMEOUT_MS: "50" }),
    { apiTimeoutMs: 100, workerTimeoutMs: 50 });
  assert.equal(validateTimeout("test", 2147483647), 2147483647);
  for (const value of [0, -1, 0.5, NaN, Infinity, 2147483648, "5", null]) {
    assert.throws(() => validateTimeout("test", value), RangeError);
    for (const name of ["apiTimeoutMs", "workerTimeoutMs"]) {
      assert.throws(() => createAgent({ openai: {}, [name]: value }), RangeError);
    }
  }
  for (const name of ["API_TIMEOUT_MS", "WORKER_TIMEOUT_MS"]) {
    for (const value of ["", "abc", "0", "-1", "2147483648"]) {
      assert.throws(() => timeoutConfigFromEnv({ [name]: value }), RangeError);
    }
  }
});

test("Worker deadline: receiving a success message does not exempt a worker that never exits", async t => {
  const time = clock(t);
  const child = fakeChild();
  t.mock.method(childProcess, "fork", () => child);
  const pending = readFile("file.txt", "/unused", { timeoutMs: 25 });
  child.emit("message", { ok: true, content: "not-yet-accepted" });
  const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
  time.fire(25);
  await rejected;
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(time.active().length, 0);
});

test("Worker failures: synchronous send and kill errors preserve the original failure and clear deadlines", async t => {
  const time = clock(t);
  const child = fakeChild();
  const original = new Error("original send error");
  child.send = () => { throw original; };
  child.kill = () => { throw new Error("private kill failure"); };
  t.mock.method(childProcess, "fork", () => child);
  await assert.rejects(readFile("file.txt", "/unused", { timeoutMs: 25 }), error => error === original);
  assert.equal(time.active().length, 0);
});

test("Worker deadline: failed kill still returns a clear timeout without exposing the kill error", async t => {
  const time = clock(t);
  const child = fakeChild();
  child.kill = () => { throw new Error("PRIVATE_KILL_FAILURE"); };
  t.mock.method(childProcess, "fork", () => child);
  const pending = listFiles("/unused", { timeoutMs: 25 });
  const rejected = assert.rejects(pending, error => error.code === "WORKER_TIMEOUT" && !error.message.includes("PRIVATE_KILL_FAILURE"));
  time.fire(25);
  await rejected;
  assert.equal(time.active().length, 0);
});

test("Worker timeout configuration: all direct tool APIs reject invalid values before spawning", async t => {
  let forks = 0;
  t.mock.method(childProcess, "fork", () => { forks++; throw new Error("unexpected spawn"); });
  for (const [, invoke] of tools) await assert.rejects(invoke({ timeoutMs: 0 }), RangeError);
  assert.equal(forks, 0);
});

for (const [name, , reply] of tools) {
  test(`Agent configuration: ${name} receives the configured worker deadline`, async t => {
    const time = clock(t);
    t.mock.method(childProcess, "fork", () => fakeChild(reply));
    let requests = 0;
    const openai = { chat: { completions: { create(request, options) {
      assert.equal(options.timeout, 1000);
      assert.equal(options.maxRetries, 0);
      return Promise.resolve(response(requests++ === 0
        ? calls(tool("call", name, { fileName: "file.txt", folderName: "Folder", content: "safe", timeoutMs: 1 }))
        : answer("Done.")));
    } } } };
    const agent = createAgent({ openai, apiTimeoutMs: 1000, workerTimeoutMs: 77 });
    assert.equal(await agent.respond("Run the tool."), "Done.");
    assert.deepEqual(time.tasks.map(task => task.ms), [1000, 77, 1000]);
    assert.equal(time.active().length, 0);
  });
}

test("API timeout after a real completed tool preserves its file and resets conversation for recovery", async t => {
  const time = clock(t);
  const workspace = await fixture(t);
  let followUpStarted;
  const followUp = new Promise(resolve => { followUpStarted = resolve; });
  let requests = 0;
  const openai = { chat: { completions: { create(request) {
    assertHistory(request.messages);
    if (requests++ === 0) return Promise.resolve(response(calls(tool("created", "create_file", { fileName: "keep.txt" }))));
    if (requests === 2) { followUpStarted(); return new Promise(() => {}); }
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
    return Promise.resolve(response(answer("Recovered.")));
  } } } };
  const agent = createAgent({ openai, workspace, apiTimeoutMs: 100, workerTimeoutMs: 500 });
  const pending = agent.respond("Create a file.");
  const rejected = assert.rejects(pending, { code: "OPENAI_TIMEOUT" });
  await followUp;
  time.fire(100);
  await rejected;
  assert.equal((await fs.stat(path.join(workspace, "keep.txt"))).size, 0);
  assert.equal(await agent.respond("Recover."), "Recovered.");
  assert.equal(time.active().length, 0);
});
