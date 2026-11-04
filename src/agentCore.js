import path from "node:path";
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
    "All folders are created inside the application's workspace directory.",
};

// The client is injected: production passes OpenAI; offline tests pass a scripted
// chat.completions.create implementation. No SDK, dotenv, or API key is needed
// to import or test this module. Call respond serially, as the CLI does.
export function createAgent({
  openai,
  workspace = path.resolve("workspace"),
  onToolCall = () => {},
  onToolResult = () => {},
}) {
  const directory = path.resolve(workspace);
  const messages = [{ ...SYSTEM_MESSAGE }];

  async function executeTool(toolCall) {
    const toolName = toolCall.function.name;
    try {
      const args = JSON.parse(toolCall.function.arguments);
      // Always use the configured workspace, never a model-supplied argument.
      switch (toolName) {
        case "create_folder": return await createFolder(args.folderName, directory);
        case "list_files": return JSON.stringify(await listFiles(directory));
        case "create_file": return await createFile(args.fileName, directory);
        case "write_file": return await writeFile(args.fileName, args.content, directory);
        case "read_file": return await readFile(args.fileName, directory);
        default: return `Error: Unsupported tool '${toolName}'.`;
      }
    } catch (error) {
      return `Tool execution error: ${error.message}`;
    }
  }

  async function complete() {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
    });
    return response.choices[0].message;
  }

  return {
    async respond(userInput) {
      messages.push({ role: "user", content: userInput });
      try {
        let assistantMessage = await complete();
        let toolRounds = 0;
        while (assistantMessage.tool_calls?.length && toolRounds < 5) {
          toolRounds++;
          messages.push(assistantMessage);
          for (const toolCall of assistantMessage.tool_calls) {
            onToolCall(toolCall.function.name);
            const result = await executeTool(toolCall);
            onToolResult(result);
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
          }
          assistantMessage = await complete();
        }
        // Do not save an assistant request whose tools were never executed.
        if (assistantMessage.tool_calls?.length) {
          return "Tool execution limit reached. Please try a simpler request.";
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
