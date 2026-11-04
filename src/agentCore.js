import path from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_API_TIMEOUT_MS, DEFAULT_WORKER_TIMEOUT_MS, validateTimeout, withApiTimeout, WORKER_TIMEOUT_NOTICE } from "./timeouts.js";
import { tools } from "./agentTools.js";
import { createFolder } from "./tools/folderTool.js";
import { listFiles } from "./tools/listFilesTool.js";
import { createFile } from "./tools/createFileTool.js";
import { writeFile } from "./tools/writeFileTool.js";
import { readFile } from "./tools/readFileTool.js";

const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "You are a helpful AI task assistant. " +
    "When the user asks you to create a folder, use the create_folder tool. " +
    "Do not explain manual folder creation steps when the tool can perform the task. " +
    "All folders are created inside the application's workspace directory. " +
    "File creation is create-only: existing files, including empty files, cannot be overwritten. " +
    "Never offer overwriting, ask permission to overwrite, or claim that overwriting is supported, even if the user requests it. " +
    "When a file already exists, explain that it is protected and suggest a new filename instead. " +
    "Ask the user to choose or confirm the new filename before creating an alternative file. " +
    "Do not suggest deleting, renaming, or truncating the existing file as a workaround. " +
    "To create a file with content, call write_file directly; do not call create_file first.",
};

// The client is injected: production passes OpenAI; offline tests pass a scripted
// chat.completions.create implementation. No SDK, dotenv, or API key is needed
// to import or test this module. Call respond serially, as the CLI does.
export function createAgent({
  openai,
  workspace = path.resolve("workspace"),
  onToolCall = () => {},
  onToolResult = () => {},
  logger,
  maxToolCallsPerRequest = 10,
  maxToolCallsPerRound = 5,
  apiTimeoutMs = DEFAULT_API_TIMEOUT_MS,
  workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
}) {
  for (const [name, value] of Object.entries({ maxToolCallsPerRequest, maxToolCallsPerRound })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  validateTimeout("apiTimeoutMs", apiTimeoutMs);
  validateTimeout("workerTimeoutMs", workerTimeoutMs);
  const workerOptions = { timeoutMs: workerTimeoutMs };
  const directory = path.resolve(workspace);
  const messages = [{ ...SYSTEM_MESSAGE }];
  const toolNames = new Set(tools.map(tool => tool.function.name));

  async function executeTool(toolCall) {
    const toolName = toolCall.function.name;
    try {
      const args = JSON.parse(toolCall.function.arguments);
      // Always use the configured workspace, never a model-supplied argument.
      let content;
      switch (toolName) {
        case "create_folder": content = await createFolder(args.folderName, directory, workerOptions); break;
        case "list_files": content = JSON.stringify(await listFiles(directory, workerOptions)); break;
        case "create_file": content = await createFile(args.fileName, directory, workerOptions); break;
        case "write_file": content = await writeFile(args.fileName, args.content, directory, workerOptions); break;
        case "read_file": content = await readFile(args.fileName, directory, workerOptions); break;
        default: return { content: `Error: Unsupported tool '${toolName}'.`, success: false };
      }
      return { content, success: true };
    } catch (error) {
      return { content: `Tool execution error: ${error.message}`, success: false, timedOut: error.code === "WORKER_TIMEOUT" };
    }
  }

  async function complete() {
    const response = await withApiTimeout(signal => openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: structuredClone(messages),
      tools,
      tool_choice: "auto",
    }, { signal, timeout: apiTimeoutMs, maxRetries: 0 }), apiTimeoutMs);
    return response.choices[0].message;
  }

  return {
    async respond(userInput) {
      messages.push({ role: "user", content: userInput });
      try {
        let assistantMessage = await complete();
        let toolRounds = 0;
        let toolCallsUsed = 0;
        while (assistantMessage.tool_calls?.length) {
          const requestedCalls = assistantMessage.tool_calls.length;
          let limitMessage;
          if (toolRounds >= 5) {
            limitMessage = "Tool execution limit reached. Please try a simpler request.";
          } else if (requestedCalls > maxToolCallsPerRound) {
            limitMessage = `Too many tool calls in one round (maximum ${maxToolCallsPerRound}). Please try a simpler request.`;
          } else if (requestedCalls > maxToolCallsPerRequest - toolCallsUsed) {
            limitMessage = `Tool call limit reached (maximum ${maxToolCallsPerRequest} per request). Please try a simpler request.`;
          }
          if (limitMessage) {
            // Reject the whole batch before saving its assistant message or
            // executing any of its calls. No unmatched tool IDs enter history.
            messages.push({ role: "assistant", content: limitMessage });
            return limitMessage;
          }
          toolRounds++;
          messages.push(assistantMessage);
          for (const [index, toolCall] of assistantMessage.tool_calls.entries()) {
            // Failures, malformed arguments, and unknown tools also spend budget.
            toolCallsUsed++;
            onToolCall(toolCall.function.name);
            const started = performance.now();
            const { content: result, success, timedOut } = await executeTool(toolCall);
            const durationMs = Math.max(0, performance.now() - started);
            try {
              // Pass metadata only. In particular, do not infer success from
              // content: a valid file can contain text beginning with "Error:".
              Promise.resolve(logger?.toolExecution({
                tool: toolNames.has(toolCall.function.name) ? toolCall.function.name : "unknown", durationMs, success,
              }))
                .catch(() => {});
            } catch {
              // Custom logger failures must not affect tool execution/history.
            }
            onToolResult(result);
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
            if (timedOut) {
              // Resolve every pending ID explicitly as skipped, without running
              // or logging those calls. Do not let the model automatically retry.
              for (const skipped of assistantMessage.tool_calls.slice(index + 1)) {
                messages.push({ role: "tool", tool_call_id: skipped.id,
                  content: "Tool execution skipped: a preceding filesystem worker timed out. This call was not executed." });
              }
              messages.push({ role: "assistant", content: WORKER_TIMEOUT_NOTICE });
              return WORKER_TIMEOUT_NOTICE;
            }
          }
          assistantMessage = await complete();
        }
        const content = assistantMessage.content ?? "No response received.";
        messages.push({ role: "assistant", content });
        return content;
      } catch (error) {
        messages.splice(1);
        throw error;
      }
    },
  };
}
