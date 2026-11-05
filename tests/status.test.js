import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getStatus, inspectWorkspace, formatStatus } from "../src/status.js";

const KEY = "sk-FAKE-STATUS-KEY-DO-NOT-DISPLAY";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ai-status-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace: path.join(root, "workspace"), trace: path.join(root, "trace.json") };
}

async function cli(files, { args = [], inputs = ["exit"], env = {} } = {}) {
  return promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-loader",
    fileURLToPath(new URL("./helpers/loggingCliLoader.mjs", import.meta.url)),
    fileURLToPath(new URL("../src/agent.js", import.meta.url)), ...args], {
    cwd: files.root,
    env: { ...process.env, OPENAI_API_KEY: KEY, API_TIMEOUT_MS: "30000", WORKER_TIMEOUT_MS: "10000",
      MAX_HISTORY_TURNS: "20", MAX_HISTORY_BYTES: "262144", LOG_TEST_MODE: "help",
      HELP_TEST_TRACE: files.trace, HELP_TEST_INPUTS: JSON.stringify(inputs), HELP_TEST_FAIL_API: "1", ...env },
  });
}

function assertKeyHidden(value) { assert.ok(!value.includes(KEY), "API key must never be displayed or returned"); }

test("Status metadata: healthy workspace matches tool requirements and configuration is allowlisted", async t => {
  const { workspace } = await fixture(t);
  await fs.mkdir(workspace, { mode: 0o700 });
  const status = await getStatus({ workspace, apiKeyConfigured: true, apiTimeoutMs: 1234,
    workerTimeoutMs: 5678, maxHistoryTurns: 3, maxHistoryBytes: 8192, apiKey: KEY });
  assert.equal(status.workspace, workspace);
  assert.deepEqual(status.workspaceCheck, {
    exists: true, directory: true, pathSafe: true, ownerMatches: true,
    sharingSafe: true, ownerAccess: true, mode: "0700", issue: null, platformSupported: true,
  });
  const text = formatStatus(status);
  assert.match(text, /Workspace checks: PASS/);
  assert.ok(text.includes(JSON.stringify(workspace)));
  assert.match(text, /API key: configured \(value hidden; not validated\)/);
  assert.match(text, /1234 ms per completion request/);
  assert.match(text, /5678 ms per operation/);
  assert.match(text, /3 turns \(active included\); 8192 serialized/);
  assertKeyHidden(JSON.stringify(status));
  assertKeyHidden(text);
  assert.deepEqual(await fs.readdir(workspace), []);
});

test("Status metadata: missing workspace is reported without creating its ancestors", async t => {
  const { root } = await fixture(t);
  const workspace = path.join(root, "missing", "nested");
  const status = await getStatus({ workspace });
  assert.equal(status.workspaceCheck.exists, false);
  assert.equal(status.workspaceCheck.ownerMatches, null);
  assert.match(formatStatus(status), /NOT READY \(workspace missing\)/);
  assert.match(formatStatus(status), /API key: not configured/);
  assert.deepEqual(await fs.readdir(root), []);
});

for (const ancestor of [false, true]) {
  test(`Status metadata: stop at ${ancestor ? "ancestor" : "workspace"} symlink without inspecting target`, async t => {
    const { root } = await fixture(t);
    const target = path.join(root, KEY);
    const linked = path.join(root, "linked");
    await fs.mkdir(target);
    await fs.symlink(target, linked);
    const requested = ancestor ? path.join(linked, "nested") : linked;
    const reads = [];
    const lstat = fs.lstat.bind(fs);
    const io = { process, fs: { async lstat(file) { reads.push(file); return lstat(file); } } };
    const status = await getStatus({ workspace: requested }, io);
    assert.equal(status.workspaceCheck.pathSafe, false);
    assert.equal(status.workspaceCheck.exists, ancestor ? null : true);
    assert.equal(status.workspaceCheck.issue, ancestor ? "ancestor_symlink" : "symlink");
    assert.equal(reads.at(-1), linked);
    assert.ok(!reads.includes(requested) || requested === linked);
    assert.match(formatStatus(status), /Workspace checks: FAIL/);
    assertKeyHidden(formatStatus(status));
    assert.deepEqual(await fs.readdir(target), []);
  });
}

for (const ancestor of [false, true]) {
  test(`Status metadata: reject ${ancestor ? "ancestor" : "workspace"} regular file`, async t => {
    const { workspace } = await fixture(t);
    await fs.writeFile(workspace, "PROTECTED");
    const check = await inspectWorkspace(ancestor ? path.join(workspace, "nested") : workspace);
    assert.equal(check.exists, !ancestor);
    assert.equal(check.pathSafe, false);
    assert.equal(check.issue, ancestor ? "ancestor_not_directory" : "not_directory");
    assert.equal(await fs.readFile(workspace, "utf8"), "PROTECTED");
  });
}

test("Status metadata: report shared-write failure and refresh after permissions change", async t => {
  const { workspace } = await fixture(t);
  await fs.mkdir(workspace);
  await fs.chmod(workspace, 0o777);
  const unsafe = await getStatus({ workspace });
  assert.equal(unsafe.workspaceCheck.ownerMatches, true);
  assert.equal(unsafe.workspaceCheck.sharingSafe, false);
  assert.match(formatStatus(unsafe), /Workspace checks: FAIL/);
  await fs.chmod(workspace, 0o700);
  const safe = await getStatus({ workspace });
  assert.equal(safe.workspaceCheck.sharingSafe, true);
  assert.match(formatStatus(safe), /Workspace checks: PASS/);
  assert.equal((await fs.stat(workspace)).mode & 0o777, 0o700);
});

test("Status metadata: warn about incomplete owner access without modifying permissions", async t => {
  const { workspace } = await fixture(t);
  await fs.mkdir(workspace, { mode: 0o500 });
  const status = await getStatus({ workspace });
  assert.equal(status.workspaceCheck.sharingSafe, true);
  assert.equal(status.workspaceCheck.ownerAccess, false);
  assert.match(formatStatus(status), /Workspace checks: WARN/);
  assert.equal((await fs.stat(workspace)).mode & 0o777, 0o500);
});

test("Status metadata: mismatched owner fails and unavailable user identity stays unknown", async t => {
  const { workspace } = await fixture(t);
  await fs.mkdir(workspace, { mode: 0o700 });
  const status = await getStatus({ workspace }, { fs, process: { platform: "linux", geteuid: () => process.geteuid() + 1 } });
  assert.equal(status.workspaceCheck.ownerMatches, false);
  assert.match(formatStatus(status), /Workspace checks: FAIL/);
  const unknown = await getStatus({ workspace }, { fs, process: { platform: "linux" } });
  assert.equal(unknown.workspaceCheck.ownerMatches, null);
  assert.match(formatStatus(unknown), /Workspace checks: UNKNOWN/);
});

for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
  test(`Status metadata: ${code} errors produce safe diagnostic state`, async t => {
    const { workspace } = await fixture(t);
    await fs.mkdir(workspace);
    const lstat = fs.lstat.bind(fs);
    const io = { process, fs: { async lstat(file) {
      if (file === workspace) throw Object.assign(new Error(KEY), { code });
      return lstat(file);
    } } };
    const status = await getStatus({ workspace }, io);
    assert.equal(status.workspaceCheck.issue, code === "ENOTDIR" ? "ancestor_not_directory" : "unavailable");
    assert.match(formatStatus(status), code === "ENOTDIR" ? /Workspace checks: FAIL/ : /Workspace checks: UNKNOWN/);
    assertKeyHidden(JSON.stringify(status));
    assertKeyHidden(formatStatus(status));
  });
}

test("Status metadata: unsupported platform never claims Unix permissions are sufficient", async t => {
  const { workspace } = await fixture(t);
  await fs.mkdir(workspace);
  const status = await getStatus({ workspace }, { fs, process: { platform: "win32" } });
  assert.equal(status.workspaceCheck.exists, true);
  assert.equal(status.workspaceCheck.ownerMatches, null);
  assert.equal(status.workspaceCheck.mode, null);
  assert.match(formatStatus(status), /supported platforms are macOS\/Linux/);
});

test("Status metadata: root path is handled and control characters in displayed paths are escaped", async t => {
  const root = await inspectWorkspace(path.parse(process.cwd()).root);
  assert.equal(root.exists, true);
  assert.equal(root.directory, true);
  const files = await fixture(t);
  const workspace = path.join(files.root, "line\n\u001bworkspace");
  await fs.mkdir(workspace, { mode: 0o700 });
  const text = formatStatus(await getStatus({ workspace }));
  assert.ok(text.includes(JSON.stringify(workspace)));
  assert.ok(!text.includes("line\n\u001bworkspace"));
});

test("Status configuration: defaults and invalid values are checked before filesystem access", async () => {
  let reads = 0;
  const io = { process: { platform: "linux", geteuid: () => 42 }, fs: { async lstat() {
    reads++;
    return { uid: 42, mode: 0o700, isSymbolicLink: () => false, isDirectory: () => true };
  } } };
  const status = await getStatus(undefined, io);
  assert.equal(status.workspace, path.resolve("workspace"));
  assert.equal(status.apiKeyConfigured, false);
  assert.equal(status.apiTimeoutMs, 30000);
  assert.equal(status.workerTimeoutMs, 10000);
  assert.equal(status.maxHistoryTurns, 20);
  assert.equal(status.maxHistoryBytes, 262144);
  const before = reads;
  for (const options of [{ apiTimeoutMs: 0 }, { workerTimeoutMs: 0 }, { maxHistoryTurns: 0 }, { maxHistoryBytes: 0 }]) {
    await assert.rejects(getStatus(options, io), RangeError);
  }
  assert.equal(reads, before);
});

for (const configured of [false, true]) {
  test(`CLI --status: no API client or mutations with key ${configured ? "configured" : "absent"}`, async t => {
    const files = await fixture(t);
    const output = await cli(files, { args: ["--status"], env: { OPENAI_API_KEY: configured ? KEY : "", LOG_TEST_MODE: "constructor",
      API_TIMEOUT_MS: "1234", WORKER_TIMEOUT_MS: "5678", MAX_HISTORY_TURNS: "3", MAX_HISTORY_BYTES: "8192" } });
    assert.match(output.stdout, /AI Task Assistant - Status/);
    assert.ok(output.stdout.includes(JSON.stringify(files.workspace)));
    assert.match(output.stdout, /Workspace exists: no/);
    assert.match(output.stdout, configured ? /API key: configured/ : /API key: not configured/);
    assert.match(output.stdout, /1234 ms per completion request/);
    assert.match(output.stdout, /5678 ms per operation/);
    assert.match(output.stdout, /3 turns \(active included\); 8192 serialized/);
    assertKeyHidden(output.stdout);
    assertKeyHidden(output.stderr);
    assert.equal(output.stderr, "");
    assert.deepEqual(await fs.readdir(files.root), []);
  });
}

test("CLI status: case/whitespace variants stay local with no API calls or tool logs", async t => {
  const files = await fixture(t);
  await fs.mkdir(files.workspace, { mode: 0o700 });
  const output = await cli(files, { inputs: [" status ", "STATUS", "\tstatus\t", "exit"] });
  assert.equal((output.stdout.match(/AI Task Assistant - Status/g) ?? []).length, 3);
  assert.match(output.stdout, /Workspace checks: PASS/);
  assert.equal(output.stderr, "");
  assertKeyHidden(output.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(files.trace, "utf8")), { calls: 0, requests: [] });
  assert.deepEqual(await fs.readdir(files.workspace), []);
  assert.equal((await fs.stat(files.workspace)).mode & 0o777, 0o700);
});

test("CLI status: preserve history and route longer status requests to the mocked model", async t => {
  const files = await fixture(t);
  const output = await cli(files, { inputs: ["first request", "status", "status of my files", "exit"], env: { HELP_TEST_FAIL_API: "0" } });
  const trace = JSON.parse(await fs.readFile(files.trace, "utf8"));
  assert.equal(trace.calls, 2);
  const messages = trace.requests[1].messages;
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "first request");
  assert.equal(messages[3].content, "status of my files");
  assert.ok(!JSON.stringify(messages).includes(files.root));
  assert.ok(!JSON.stringify(messages).includes("AI Task Assistant - Status"));
  assertKeyHidden(output.stdout);
  assert.equal(output.stderr, "");
});

test("CLI --status: invalid limits give a safe local configuration error without constructing a client", async t => {
  const files = await fixture(t);
  await assert.rejects(cli(files, { args: ["--status"], env: {
    OPENAI_API_KEY: "", LOG_TEST_MODE: "constructor", MAX_HISTORY_BYTES: "0",
  } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /MAX_HISTORY_TURNS and MAX_HISTORY_BYTES/);
    assert.equal(JSON.parse(error.stderr).stage, "startup");
    assertKeyHidden(error.stdout);
    assertKeyHidden(error.stderr);
    return true;
  });
  assert.deepEqual(await fs.readdir(files.root), []);
});
