import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createAgent } from "../src/agentCore.js";
import { historyConfigFromEnv, trimHistory } from "../src/history.js";
import { WORKER_TIMEOUT_NOTICE } from "../src/timeouts.js";

test.beforeEach(t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live network calls are forbidden"); });
});

const tool = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const calls = (...items) => ({ role: "assistant", content: null, tool_calls: items });
const answer = content => ({ role: "assistant", content });
const user = content => ({ role: "user", content });
const bytes = messages => Buffer.byteLength(JSON.stringify(messages), "utf8");

function validHistory(messages) {
  assert.equal(messages[0].role, "system");
  assert.equal(messages.filter(message => message.role === "system").length, 1);
  assert.match(messages[0].content, /Never offer overwriting/);
  const pending = new Set();
  for (const message of messages) {
    if (message.role === "tool") assert.ok(pending.delete(message.tool_call_id), "orphaned tool result");
    else {
      assert.equal(pending.size, 0, "tool request lost one or more results");
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

function client(script, maxBytes = Infinity) {
  const requests = [];
  let index = 0;
  return {
    requests,
    assertConsumed() { assert.equal(index, script.length); },
    chat: { completions: { async create(request) {
      const snapshot = structuredClone(request);
      validHistory(snapshot.messages);
      assert.ok(bytes(snapshot.messages) <= maxBytes, "request exceeded serialized-byte cap");
      requests.push(snapshot);
      assert.ok(index < script.length, "unexpected request; no live fallback");
      const step = script[index++];
      if (step instanceof Error) throw step;
      return { choices: [{ message: typeof step === "function" ? step(snapshot) : step }] };
    } } },
  };
}

async function systemMessage() {
  const openai = client([answer("probe")]);
  await createAgent({ openai }).respond("probe");
  return openai.requests[0].messages[0];
}

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-history-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("History turns: default keeps the newest 20 turns including the active request", async () => {
  const openai = client(Array.from({ length: 22 }, (_, index) => answer(`answer ${index + 1}`)));
  const agent = createAgent({ openai });
  for (let index = 1; index <= 22; index++) await agent.respond(`turn ${index}`);
  assert.equal(openai.requests[19].messages.filter(message => message.role === "user").length, 20);
  assert.deepEqual(openai.requests[20].messages.filter(message => message.role === "user").map(message => message.content),
    Array.from({ length: 20 }, (_, index) => `turn ${index + 2}`));
  assert.equal(openai.requests[21].messages[1].content, "turn 3");
  assert.deepEqual(openai.requests[21].messages[0], openai.requests[0].messages[0]);
  openai.assertConsumed();
});

test("History turns: active multi-round tool calls stay paired; eviction removes the entire completed turn", async t => {
  const workspace = await fixture(t);
  await fs.writeFile(path.join(workspace, "seed.txt"), "safe");
  const openai = client([
    answer("old answer"),
    request => {
      assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
      return calls(tool("folder", "create_folder", { folderName: "Plans" }), tool("list", "list_files"));
    },
    request => {
      assert.equal(request.messages.filter(message => message.role === "user").length, 1);
      assert.deepEqual(request.messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["folder", "list"]);
      return calls(tool("read", "read_file", { fileName: "seed.txt" }));
    },
    request => {
      assert.deepEqual(request.messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["folder", "list", "read"]);
      assert.equal(request.messages.at(-1).content, "safe");
      return answer("Completed.");
    },
    request => {
      assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
      assert.equal(request.messages[1].content, "new turn");
      return answer("Ready.");
    },
  ]);
  const agent = createAgent({ openai, workspace, maxHistoryTurns: 1 });
  await agent.respond("old turn");
  assert.equal(await agent.respond("current tool turn"), "Completed.");
  assert.equal(await agent.respond("new turn"), "Ready.");
  assert.equal(await fs.readFile(path.join(workspace, "seed.txt"), "utf8"), "safe");
  assert.equal((await fs.stat(path.join(workspace, "Plans"))).isDirectory(), true);
  openai.assertConsumed();
});

test("History bytes: evict oldest whole turn while retaining the newer completed turn", async () => {
  const system = await systemMessage();
  const largePrompt = "é".repeat(200);
  const maxHistoryBytes = bytes([system, user("turn2"), answer("reply"), user(largePrompt)]);
  const openai = client([answer("reply"), answer("reply"), answer("done")], maxHistoryBytes);
  const agent = createAgent({ openai, maxHistoryBytes });
  await agent.respond("turn1");
  await agent.respond("turn2");
  await agent.respond(largePrompt);
  assert.deepEqual(openai.requests[2].messages.filter(message => message.role === "user").map(message => message.content),
    ["turn2", largePrompt]);
  assert.deepEqual(openai.requests[2].messages[0], system);
  openai.assertConsumed();
});

test("History bytes: exact UTF-8 byte boundary is accepted and one byte less rejects before the API", async () => {
  const system = await systemMessage();
  const prompt = "🧪é".repeat(10);
  const exact = bytes([system, user(prompt)]);
  assert.ok(exact > JSON.stringify([system, user(prompt)]).length, "must count encoded bytes, not JS characters");
  const atBoundary = client([answer("ok")], exact);
  assert.equal(await createAgent({ openai: atBoundary, maxHistoryBytes: exact }).respond(prompt), "ok");
  atBoundary.assertConsumed();
  const recovery = client([request => {
    assert.deepEqual(request.messages, [system, user("recover")]);
    return answer("Recovered.");
  }], exact - 1);
  const agent = createAgent({ openai: recovery, maxHistoryBytes: exact - 1 });
  await assert.rejects(agent.respond(prompt), error => error.code === "HISTORY_LIMIT" && !error.message.includes(prompt));
  assert.equal(recovery.requests.length, 0);
  assert.equal(await agent.respond("recover"), "Recovered.");
  recovery.assertConsumed();
});

test("History bytes: return a large final answer but evict its completed turn if it cannot be retained", async () => {
  const system = await systemMessage();
  const maxHistoryBytes = bytes([system]) + 1000;
  const output = "large response ".repeat(1000);
  const openai = client([answer(output), request => {
    assert.deepEqual(request.messages, [system, user("next")]);
    return answer("Ready.");
  }], maxHistoryBytes);
  const agent = createAgent({ openai, maxHistoryBytes });
  assert.equal(await agent.respond("first"), output);
  assert.equal(await agent.respond("next"), "Ready.");
  openai.assertConsumed();
});

test("History bytes: oversized tool input is rejected before tools execute", async t => {
  const system = await systemMessage();
  const maxHistoryBytes = bytes([system]) + 1000;
  const workspace = await fixture(t);
  const openai = client([
    calls(tool("oversized", "write_file", { fileName: "never.txt", content: "private".repeat(1000) })),
    answer("Recovered."),
  ], maxHistoryBytes);
  let executed = 0;
  const agent = createAgent({ openai, workspace, maxHistoryBytes, onToolCall: () => executed++ });
  await assert.rejects(agent.respond("Create a file."), { code: "HISTORY_LIMIT" });
  assert.equal(executed, 0);
  assert.deepEqual(await fs.readdir(workspace), []);
  assert.equal(await agent.respond("recover"), "Recovered.");
  assert.deepEqual(openai.requests[1].messages, [system, user("recover")]);
  openai.assertConsumed();
});

test("History bytes: oversized tool output is never sent, then recovery starts with only system and new input", async t => {
  const system = await systemMessage();
  const maxHistoryBytes = bytes([system]) + 1000;
  const workspace = await fixture(t);
  const data = "PRIVATE_CONTENT".repeat(500);
  await fs.writeFile(path.join(workspace, "large.txt"), data);
  const openai = client([
    answer("Old context."),
    calls(tool("read-large", "read_file", { fileName: "large.txt" })),
    request => {
      assert.deepEqual(request.messages, [system, user("recover")]);
      return answer("Recovered.");
    },
  ], maxHistoryBytes);
  const agent = createAgent({ openai, workspace, maxHistoryBytes });
  await agent.respond("old");
  await assert.rejects(agent.respond("Read the file."), { code: "HISTORY_LIMIT" });
  assert.equal(openai.requests.length, 2, "no follow-up API call with oversized content");
  assert.ok(!JSON.stringify(openai.requests).includes(data));
  assert.equal(await agent.respond("recover"), "Recovered.");
  assert.equal(await fs.readFile(path.join(workspace, "large.txt"), "utf8"), data);
  openai.assertConsumed();
});

test("History recovery: API failures reset retained turns and preserve system instructions", async () => {
  const failure = new Error("mock API failure");
  const openai = client([answer("first answer"), failure, request => {
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
    assert.equal(request.messages[1].content, "recover");
    return answer("Recovered.");
  }]);
  const agent = createAgent({ openai, maxHistoryTurns: 2 });
  await agent.respond("old turn");
  await assert.rejects(agent.respond("failed turn"), error => error === failure);
  assert.equal(await agent.respond("recover"), "Recovered.");
  assert.deepEqual(openai.requests[2].messages[0], openai.requests[0].messages[0]);
  openai.assertConsumed();
});

test("History recovery: trim a completed limit notice without introducing rejected call IDs", async () => {
  const openai = client([
    calls(tool("blocked1", "list_files"), tool("blocked2", "list_files")),
    request => {
      assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
      return answer("Ready.");
    },
  ]);
  const agent = createAgent({ openai, maxHistoryTurns: 1, maxToolCallsPerRound: 1 });
  assert.match(await agent.respond("too many"), /maximum 1/);
  assert.equal(await agent.respond("next"), "Ready.");
  openai.assertConsumed();
});

test("History recovery: trim the whole worker-timeout turn, including skipped results", async t => {
  const child = new EventEmitter();
  child.send = (request, callback) => queueMicrotask(() => {
    callback(null);
    child.emit("message", { ok: false, code: "WORKER_TIMEOUT", message: "Filesystem worker timed out." });
    child.emit("exit", 1, null);
  });
  t.mock.method(childProcess, "fork", () => child);
  const openai = client([
    calls(tool("stalled", "write_file", { fileName: "file.txt", content: "safe" }), tool("skipped", "list_files")),
    request => {
      assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
      return answer("Recovered.");
    },
  ]);
  const agent = createAgent({ openai, maxHistoryTurns: 1 });
  assert.equal(await agent.respond("timeout"), WORKER_TIMEOUT_NOTICE);
  assert.equal(await agent.respond("next"), "Recovered.");
  openai.assertConsumed();
});

test("History configuration: defaults and environment overrides, with invalid values rejected", () => {
  assert.deepEqual(historyConfigFromEnv({}), { maxHistoryTurns: 20, maxHistoryBytes: 262144 });
  assert.deepEqual(historyConfigFromEnv({ MAX_HISTORY_TURNS: "2", MAX_HISTORY_BYTES: "4096" }),
    { maxHistoryTurns: 2, maxHistoryBytes: 4096 });
  for (const name of ["maxHistoryTurns", "maxHistoryBytes"]) {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5", null]) {
      assert.throws(() => createAgent({ openai: {}, [name]: value }),
        error => error instanceof RangeError && error.message === `${name} must be a positive safe integer.`);
    }
  }
  for (const name of ["MAX_HISTORY_TURNS", "MAX_HISTORY_BYTES"]) {
    for (const value of ["", "0", "-1", "0.5", "NaN", "9007199254740992"]) {
      assert.throws(() => historyConfigFromEnv({ [name]: value }), RangeError);
    }
  }
});

test("History safety: never evict system instructions to fit an impossible byte limit", async () => {
  const system = await systemMessage();
  const messages = [system];
  assert.throws(() => trimHistory(messages, { maxHistoryTurns: 1, maxHistoryBytes: 1 }), { code: "HISTORY_LIMIT" });
  assert.deepEqual(messages, [system]);
});
