import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agentCore.js";

test.beforeEach(t => {
  // A future accidental real SDK call must fail rather than spend API credits.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Real network calls are forbidden in mocked agent tests.");
  });
});

const tool = (id, name, args = {}) => ({
  id, type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const calls = (...toolCalls) => ({ role: "assistant", content: null, tool_calls: toolCalls });
const answer = content => ({ role: "assistant", content });

function assertValidHistory(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === "tool") {
      assert.ok(pending.delete(message.tool_call_id), `unmatched tool result ${message.tool_call_id}`);
      assert.equal(typeof message.content, "string");
      continue;
    }
    assert.equal(pending.size, 0, "every assistant tool request needs its results before another message");
    for (const call of message.tool_calls ?? []) pending.add(call.id);
  }
  assert.equal(pending.size, 0, "requests must not end with unresolved tool calls");
}

function scriptedOpenAI(script) {
  const requests = [];
  let index = 0;
  return {
    requests,
    assertConsumed() { assert.equal(index, script.length, "all scripted responses must be consumed"); },
    chat: { completions: { async create(request) {
      // Snapshot at the transport boundary: later conversation updates must not
      // change the evidence of what was sent on an earlier request.
      const snapshot = structuredClone(request);
      assertValidHistory(snapshot.messages);
      assert.equal(snapshot.model, "gpt-4o-mini");
      assert.equal(snapshot.tool_choice, "auto");
      assert.deepEqual(snapshot.tools.map(item => item.function.name).sort(),
        ["create_file", "create_folder", "list_files", "read_file", "write_file"]);
      requests.push(snapshot);
      assert.ok(index < script.length, "unexpected completion request; no live fallback exists");
      const step = script[index++];
      if (step instanceof Error) throw step;
      const message = typeof step === "function" ? await step(snapshot) : step;
      return { choices: [{ message }] };
    } } },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-agent-flow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  return { root, workspace, outside };
}

function results(request) {
  return request.messages.filter(message => message.role === "tool");
}

test("Agent workflow: create folder, write directly, list, read, and remember follow-up context", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("folder-1", "create_folder", { folderName: "Plans" })),
    calls(tool("write-1", "write_file", { fileName: "notes.txt", content: "Hello é 🚀" })),
    calls(tool("list-1", "list_files"), tool("read-1", "read_file", { fileName: "notes.txt" })),
    request => {
      const outputs = results(request);
      assert.deepEqual(outputs.map(item => item.tool_call_id), ["folder-1", "write-1", "list-1", "read-1"]);
      assert.match(outputs[0].content, /created successfully/);
      assert.match(outputs[1].content, /successfully written/);
      assert.deepEqual(JSON.parse(outputs[2].content).sort((a, b) => a.name.localeCompare(b.name)),
        [{ name: "notes.txt", type: "file" }, { name: "Plans", type: "folder" }]);
      assert.equal(outputs[3].content, "Hello é 🚀");
      return answer("Created the folder and notes, then listed and read them.");
    },
    request => {
      assert.ok(request.messages.some(item => item.role === "user" && item.content === "Prepare my notes."));
      assert.ok(request.messages.some(item => item.role === "assistant" && item.content?.startsWith("Created the folder")));
      return calls(tool("read-2", "read_file", { fileName: "notes.txt" }));
    },
    request => {
      assert.equal(results(request).at(-1).content, "Hello é 🚀");
      return answer("Your notes say Hello é 🚀.");
    },
  ]);
  const executed = [];
  const observedResults = [];
  const agent = createAgent({ openai, workspace,
    onToolCall: name => executed.push(name), onToolResult: result => observedResults.push(result) });
  assert.equal(await agent.respond("Prepare my notes."), "Created the folder and notes, then listed and read them.");
  assert.equal(await agent.respond("Read them again."), "Your notes say Hello é 🚀.");
  assert.deepEqual(executed, ["create_folder", "write_file", "list_files", "read_file", "read_file"]);
  assert.equal(observedResults.length, executed.length);
  assert.equal(await fs.readFile(path.join(workspace, "notes.txt"), "utf8"), "Hello é 🚀");
  assert.equal((await fs.stat(path.join(workspace, "Plans"))).isDirectory(), true);
  assert.match(openai.requests[0].tools.find(item => item.function.name === "write_file").function.description,
    /do not call create_file first/);
  openai.assertConsumed();
});

test("Agent workflow: overwrite rejection reaches the model and preserves original content", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("write-original", "write_file", { fileName: "notes.txt", content: "PROTECTED" })),
    answer("Created."),
    calls(tool("overwrite", "write_file", { fileName: "notes.txt", content: "unsafe" })),
    request => {
      const result = results(request).at(-1);
      assert.equal(result.tool_call_id, "overwrite");
      assert.match(result.content, /^Tool execution error: .*Overwriting is not allowed/);
      return answer("The existing file cannot be overwritten.");
    },
  ]);
  const agent = createAgent({ openai, workspace });
  await agent.respond("Create notes.");
  assert.equal(await agent.respond("Replace notes."), "The existing file cannot be overwritten.");
  assert.equal(await fs.readFile(path.join(workspace, "notes.txt"), "utf8"), "PROTECTED");
  openai.assertConsumed();
});

test("Agent workflow: create an empty file, then reject writing to that existing file", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("create-empty", "create_file", { fileName: "empty.txt" }),
      tool("write-empty", "write_file", { fileName: "empty.txt", content: "unsafe" })),
    request => {
      const outputs = results(request);
      assert.deepEqual(outputs.map(item => item.tool_call_id), ["create-empty", "write-empty"]);
      assert.match(outputs[0].content, /created successfully/);
      assert.match(outputs[1].content, /Overwriting is not allowed/);
      return answer("The empty file exists and is protected.");
    },
  ]);
  assert.equal(await createAgent({ openai, workspace }).respond("Create an empty file, then write into it."),
    "The empty file exists and is protected.");
  assert.equal(await fs.readFile(path.join(workspace, "empty.txt"), "utf8"), "");
  openai.assertConsumed();
});

test("Agent security: invalid paths are returned as tool errors with no outside changes", async t => {
  const { root, workspace, outside } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("bad-folder", "create_folder", { folderName: "../escape" }),
      tool("bad-create", "create_file", { fileName: "../escape.txt" }),
      tool("bad-write", "write_file", { fileName: "../escape.txt", content: "unsafe" }),
      tool("bad-read", "read_file", { fileName: "../escape.txt" })),
    request => {
      const outputs = results(request);
      assert.equal(outputs.length, 4);
      for (const output of outputs) assert.match(output.content, /^Tool execution error: Invalid (folder|file) name/);
      return answer("Those paths are invalid.");
    },
  ]);
  await createAgent({ openai, workspace }).respond("Use parent-directory paths.");
  assert.deepEqual(await fs.readdir(workspace), []);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual((await fs.readdir(root)).sort(), ["outside", "workspace"]);
  openai.assertConsumed();
});

test("Agent security: model-supplied workspace overrides cannot escape the configured workspace", async t => {
  const { workspace, outside } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("folder", "create_folder", { folderName: "Plans", workspace: outside }),
      tool("write", "write_file", { fileName: "notes.txt", content: "safe", workspace: outside }),
      tool("read", "read_file", { fileName: "notes.txt", workspace: outside }),
      tool("list", "list_files", { workspace: outside })),
    request => {
      assert.equal(results(request).find(item => item.tool_call_id === "read").content, "safe");
      assert.equal(JSON.parse(results(request).at(-1).content).length, 2);
      return answer("Done inside the configured workspace.");
    },
  ]);
  await createAgent({ openai, workspace }).respond("Use another workspace.");
  assert.equal(await fs.readFile(path.join(workspace, "notes.txt"), "utf8"), "safe");
  assert.deepEqual(await fs.readdir(outside), []);
  openai.assertConsumed();
});

test("Agent resilience: malformed JSON, null arguments, and unsupported tools return correlated errors", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("malformed", "write_file", "{bad"), tool("null-args", "read_file", "null"), tool("unsupported", "delete_file")),
    request => {
      const outputs = results(request);
      assert.deepEqual(outputs.map(item => item.tool_call_id), ["malformed", "null-args", "unsupported"]);
      assert.match(outputs[0].content, /^Tool execution error:/);
      assert.match(outputs[1].content, /^Tool execution error:/);
      assert.equal(outputs[2].content, "Error: Unsupported tool 'delete_file'.");
      return answer("The requested tools could not run.");
    },
  ]);
  await createAgent({ openai, workspace }).respond("Run invalid requests.");
  assert.deepEqual(await fs.readdir(workspace), []);
  openai.assertConsumed();
});

for (const afterTool of [false, true]) {
  test(`Agent resilience: API failure ${afterTool ? "after tool execution" : "before tools"} resets conversation`, async t => {
    const { workspace } = await fixture(t);
    const failure = new Error("Mocked completion service failure");
    const script = afterTool
      ? [calls(tool("write", "write_file", { fileName: "saved.txt", content: "saved" })), failure]
      : [failure];
    script.push(request => {
      assert.deepEqual(request.messages.map(item => item.role), ["system", "user"]);
      assert.equal(request.messages[1].content, "Start again.");
      return answer("Recovered.");
    });
    const openai = scriptedOpenAI(script);
    const agent = createAgent({ openai, workspace });
    await assert.rejects(agent.respond("First attempt."), error => error === failure);
    assert.equal(await agent.respond("Start again."), "Recovered.");
    if (afterTool) assert.equal(await fs.readFile(path.join(workspace, "saved.txt"), "utf8"), "saved");
    else assert.deepEqual(await fs.readdir(workspace), []);
    openai.assertConsumed();
  });
}

test("Agent resilience: tool round limit stops execution and leaves valid history for the next turn", async t => {
  const { workspace } = await fixture(t);
  const script = Array.from({ length: 5 }, (_, index) => calls(tool(`list-${index}`, "list_files")));
  script.push(calls(tool("never-executed", "write_file", { fileName: "never.txt", content: "unsafe" })));
  script.push(request => {
    assert.ok(!request.messages.some(item => item.tool_calls?.some(call => call.id === "never-executed")));
    assert.equal(results(request).length, 5);
    return answer("Ready for the next request.");
  });
  const openai = scriptedOpenAI(script);
  const executed = [];
  const agent = createAgent({ openai, workspace, onToolCall: name => executed.push(name) });
  assert.equal(await agent.respond("Keep listing."), "Tool execution limit reached. Please try a simpler request.");
  assert.equal(openai.requests.length, 6);
  assert.deepEqual(executed, Array(5).fill("list_files"));
  assert.deepEqual(await fs.readdir(workspace), []);
  assert.equal(await agent.respond("Continue."), "Ready for the next request.");
  openai.assertConsumed();
});

test("Agent responses: null content uses the fallback and preserves it in history", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    answer(null),
    request => {
      assert.deepEqual(request.messages.at(-2), { role: "assistant", content: "No response received." });
      return answer("A normal response.");
    },
  ]);
  const agent = createAgent({ openai, workspace });
  assert.equal(await agent.respond("First."), "No response received.");
  assert.equal(await agent.respond("Second."), "A normal response.");
  openai.assertConsumed();
});

test("Agent defaults: run in a subprocess without an API key, SDK, dotenv, or network", async t => {
  const { root, workspace } = await fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const coreURL = new URL("../src/agentCore.js", import.meta.url).href;
  const script = `
    import { createAgent } from ${JSON.stringify(coreURL)};
    if (process.env.OPENAI_API_KEY) throw new Error('Test must not have an API key');
    globalThis.fetch = async () => { throw new Error('Network forbidden'); };
    let count = 0;
    const openai = { chat: { completions: { async create() {
      const message = count++ === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'offline-write', type: 'function', function: {
            name: 'write_file', arguments: JSON.stringify({ fileName: 'default.txt', content: 'offline' })
          } }] }
        : { role: 'assistant', content: 'Done offline.' };
      return { choices: [{ message }] };
    } } } };
    process.stdout.write(await createAgent({ openai }).respond('Create a file.'));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, env: { ...process.env, OPENAI_API_KEY: "" },
  });
  assert.equal(stdout, "Done offline.");
  assert.equal(await fs.readFile(path.join(workspace, "default.txt"), "utf8"), "offline");
});


for (const name of ["create_file", "write_file"]) {
  test(`Agent policy: ${name} collision requests a new filename without offering overwrite`, async t => {
    const { workspace } = await fixture(t);
    const file = path.join(workspace, "notes.txt");
    await fs.writeFile(file, "PROTECTED");
    let collisionChecked = false;
    const openai = scriptedOpenAI([
      calls(tool("collision", name, { fileName: "notes.txt", content: "unsafe" })),
      request => {
        const policy = request.messages[0];
        assert.equal(policy.role, "system");
        assert.match(policy.content, /Never offer overwriting, ask permission to overwrite/);
        assert.match(policy.content, /even if the user requests it/);
        assert.match(policy.content, /suggest a new filename instead/);
        assert.match(policy.content, /choose or confirm the new filename before creating/);
        assert.match(policy.content, /Do not suggest deleting, renaming, or truncating/);
        for (const toolName of ["create_file", "write_file"]) {
          const description = request.tools.find(item => item.function.name === toolName).function.description;
          assert.match(description, /Never offer overwriting; suggest a new filename instead/);
        }
        const output = results(request).at(-1);
        assert.equal(output.tool_call_id, "collision");
        assert.match(output.content, /^Tool execution error: .*already exists/);
        collisionChecked = true;
        return answer("notes.txt already exists and is protected. Would you like to use notes_02.txt instead?");
      },
      request => {
        // Check the policy also survives into subsequent conversation turns.
        assert.match(request.messages[0].content, /Never offer overwriting/);
        return answer("Please choose a new filename; existing files cannot be overwritten.");
      },
    ]);
    const agent = createAgent({ openai, workspace });
    await agent.respond("Create notes.txt, overwriting it if necessary.");
    assert.equal(collisionChecked, true);
    await agent.respond("I give permission to overwrite notes.txt.");
    assert.equal(await fs.readFile(file, "utf8"), "PROTECTED");
    assert.deepEqual(await fs.readdir(workspace), ["notes.txt"]);
    openai.assertConsumed();
  });
}

for (const earlierRound of [false, true]) {
  test(`Agent limits: oversized round ${earlierRound ? "after an accepted round" : "on the first response"} executes no calls from that batch`, async t => {
    const { workspace } = await fixture(t);
    const blocked = Array.from({ length: 6 }, (_, index) => tool(`blocked-${index}`, "write_file",
      { fileName: `blocked_${index}.txt`, content: "unsafe" }));
    const script = earlierRound ? [calls(tool("accepted", "create_file", { fileName: "accepted.txt" }))] : [];
    script.push(calls(...blocked));
    script.push(request => {
      assert.ok(!request.messages.some(message => message.tool_calls?.some(call => call.id.startsWith("blocked-"))));
      assert.equal(results(request).length, earlierRound ? 1 : 0);
      assert.match(request.messages.at(-2).content, /Too many tool calls in one round/);
      return calls(tool("next-turn", "write_file", { fileName: "next_turn.txt", content: "safe" }));
    });
    script.push(answer("Recovered."));
    const openai = scriptedOpenAI(script);
    const executed = [];
    const logs = [];
    const agent = createAgent({ openai, workspace, onToolCall: name => executed.push(name),
      logger: { toolExecution: record => logs.push(record) } });
    assert.match(await agent.respond("Run too many tools."), /maximum 5/);
    assert.equal(executed.length, earlierRound ? 1 : 0);
    assert.equal(logs.length, executed.length);
    assert.equal(openai.requests.length, earlierRound ? 2 : 1, "stop without asking the model for another response");
    assert.deepEqual(await fs.readdir(workspace), earlierRound ? ["accepted.txt"] : []);
    assert.equal(await agent.respond("Try a smaller request."), "Recovered.");
    assert.equal(await fs.readFile(path.join(workspace, "next_turn.txt"), "utf8"), "safe");
    openai.assertConsumed();
  });
}

test("Agent limits: ten total calls are accepted, an eleventh is blocked, and the next request has fresh budget", async t => {
  const { workspace } = await fixture(t);
  const batch = offset => calls(...Array.from({ length: 5 }, (_, index) =>
    tool(`accepted-${offset + index}`, "create_file", { fileName: `accepted_${offset + index}.txt` })));
  const openai = scriptedOpenAI([
    batch(0), batch(5),
    calls(tool("eleventh", "write_file", { fileName: "blocked.txt", content: "unsafe" })),
    request => {
      assert.equal(results(request).length, 10);
      assert.ok(!request.messages.some(message => message.tool_calls?.some(call => call.id === "eleventh")));
      assert.match(request.messages.at(-2).content, /maximum 10 per request/);
      return calls(tool("fresh-budget", "create_file", { fileName: "fresh.txt" }));
    },
    answer("Created with fresh budget."),
  ]);
  const executed = [];
  const agent = createAgent({ openai, workspace, onToolCall: name => executed.push(name) });
  assert.match(await agent.respond("Create many files."), /maximum 10 per request/);
  assert.equal(executed.length, 10);
  assert.equal(openai.requests.length, 3);
  assert.equal((await fs.readdir(workspace)).length, 10);
  await assert.rejects(fs.stat(path.join(workspace, "blocked.txt")), { code: "ENOENT" });
  assert.equal(await agent.respond("Create one more file."), "Created with fresh budget.");
  assert.equal(executed.length, 11);
  assert.equal((await fs.stat(path.join(workspace, "fresh.txt"))).size, 0);
  openai.assertConsumed();
});

test("Agent limits: reject an entire batch exceeding remaining budget without executing even its first call", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("first", "create_file", { fileName: "first.txt" }), tool("second", "create_file", { fileName: "second.txt" })),
    calls(tool("would-fit-alone", "create_file", { fileName: "partial.txt" }),
      tool("over-budget", "create_file", { fileName: "blocked.txt" })),
    request => {
      assert.equal(results(request).length, 2);
      assert.ok(!request.messages.some(message => message.tool_calls?.some(call => call.id === "would-fit-alone")));
      return answer("Ready.");
    },
  ]);
  const agent = createAgent({ openai, workspace, maxToolCallsPerRequest: 3, maxToolCallsPerRound: 3 });
  assert.match(await agent.respond("Use four calls."), /maximum 3 per request/);
  assert.deepEqual((await fs.readdir(workspace)).sort(), ["first.txt", "second.txt"]);
  assert.equal(await agent.respond("Continue."), "Ready.");
  openai.assertConsumed();
});

test("Agent limits: failed and unsupported attempts count toward the total budget", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("malformed", "write_file", "{bad"), tool("unsupported", "unsupported_tool")),
    request => {
      const outputs = results(request);
      assert.match(outputs[0].content, /^Tool execution error:/);
      assert.match(outputs[1].content, /^Error: Unsupported tool/);
      return calls(tool("blocked", "create_file", { fileName: "blocked.txt" }));
    },
    answer("Ready for another request."),
  ]);
  const logs = [];
  const agent = createAgent({ openai, workspace, maxToolCallsPerRequest: 2, maxToolCallsPerRound: 2,
    logger: { toolExecution: record => logs.push(record) } });
  assert.match(await agent.respond("Attempt three calls."), /maximum 2 per request/);
  assert.deepEqual(logs.map(record => record.success), [false, false]);
  assert.deepEqual(await fs.readdir(workspace), []);
  assert.equal(await agent.respond("Continue."), "Ready for another request.");
  openai.assertConsumed();
});

test("Agent limits: exact custom boundaries allow final text without a false limit error", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("one", "create_file", { fileName: "one.txt" })),
    calls(tool("two", "create_file", { fileName: "two.txt" })),
    answer("Both files created."),
  ]);
  const agent = createAgent({ openai, workspace, maxToolCallsPerRequest: 2, maxToolCallsPerRound: 1 });
  assert.equal(await agent.respond("Create two files."), "Both files created.");
  assert.deepEqual((await fs.readdir(workspace)).sort(), ["one.txt", "two.txt"]);
  openai.assertConsumed();
});

test("Agent limits: enforce a configured per-round cap independently of the total", async t => {
  const { workspace } = await fixture(t);
  const openai = scriptedOpenAI([
    calls(tool("one", "create_file", { fileName: "one.txt" }), tool("two", "create_file", { fileName: "two.txt" })),
  ]);
  const agent = createAgent({ openai, workspace, maxToolCallsPerRequest: 10, maxToolCallsPerRound: 1 });
  assert.match(await agent.respond("Create two files in one round."), /maximum 1/);
  assert.deepEqual(await fs.readdir(workspace), []);
  openai.assertConsumed();
});

test("Agent limits: API errors reset history and the next request receives a fresh call budget", async t => {
  const { workspace } = await fixture(t);
  const failure = new Error("Mock service failure after a tool");
  const openai = scriptedOpenAI([
    calls(tool("before-error", "create_file", { fileName: "before.txt" })), failure,
    request => {
      assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
      return calls(tool("after-error", "create_file", { fileName: "after.txt" }));
    },
    answer("Recovered."),
  ]);
  const agent = createAgent({ openai, workspace, maxToolCallsPerRequest: 1, maxToolCallsPerRound: 1 });
  await assert.rejects(agent.respond("First request."), error => error === failure);
  assert.equal(await agent.respond("Second request."), "Recovered.");
  assert.deepEqual((await fs.readdir(workspace)).sort(), ["after.txt", "before.txt"]);
  openai.assertConsumed();
});

test("Agent limits: reject invalid configuration before any API or tool work", () => {
  let completions = 0;
  const openai = { chat: { completions: { create() { completions++; } } } };
  for (const name of ["maxToolCallsPerRequest", "maxToolCallsPerRound"]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5", null]) {
      assert.throws(() => createAgent({ openai, [name]: value }),
        error => error instanceof RangeError && error.message === `${name} must be a positive safe integer.`);
    }
  }
  assert.equal(completions, 0);
});
