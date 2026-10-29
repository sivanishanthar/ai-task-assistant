// Import required libraries
import OpenAI from "openai";
import dotenv from "dotenv";
import readline from "node:readline/promises";
import { createFolder } from "./tools/folderTool.js";
import { listFiles } from "./tools/listFilesTool.js";
import { createFile } from "./tools/createFileTool.js";
import { writeFile } from "./tools/writeFileTool.js";
import { readFile } from "./tools/readFileTool.js";

// Load environment variables
dotenv.config();

// Check API key
if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is missing.");
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Create terminal interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Store conversation history
const messages = [
  {
    role: "system",
    content:
      "You are a helpful AI task assistant. " +
      "When the user asks you to create a folder, use the create_folder tool. " +
      "Do not explain manual folder creation steps when the tool can perform the task. " +
      "All folders are created inside the application's workspace directory.",
  },
];

// Define tools available to the AI
const tools = [
  {
    type: "function",
    function: {
      name: "create_folder",
      description:
        "Create a folder inside the application's workspace directory.",
      parameters: {
        type: "object",
        properties: {
          folderName: {
            type: "string",
            description:
              "Name of the folder to create, without path separators.",
          },
        },
        required: ["folderName"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files and folders in the workspace directory.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new empty file inside the workspace directory.",
      parameters: {
        type: "object",
        properties: {
          fileName: {
            type: "string",
            description:
              "Name of the file including its extension, such as notes.txt",
          },
        },
        required: ["fileName"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "write_file",

      description:
        "Write text content into a new or empty file inside the workspace directory. Existing nonempty files cannot be overwritten.",

      parameters: {
        type: "object",

        properties: {
          fileName: {
            type: "string",
            description:
              "Name of the file including extension, such as testPlan.txt",
          },

          content: {
            type: "string",
            description: "The complete text content to write into the file",
          },
        },

        required: ["fileName", "content"],

        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "read_file",

      description:
        "Read the contents of a text file inside the workspace directory.",

      parameters: {
        type: "object",

        properties: {
          fileName: {
            type: "string",
            description: "Name of the file to read, including its extension.",
          },
        },

        required: ["fileName"],

        additionalProperties: false,
      },
    },
  }
];

// Execute tools requested by the AI
async function executeTool(toolCall) {
  const toolName = toolCall.function.name;

  try {
    const args = JSON.parse(toolCall.function.arguments);

    switch (toolName) {
      case "create_folder":
        return await createFolder(args.folderName);

      case "list_files":
        return JSON.stringify(await listFiles());

      case "create_file":
        return await createFile(args.fileName);

      case "write_file":
        return await writeFile(args.fileName, args.content);

      case "read_file":
        return await readFile(args.fileName);
        
      default:
        return `Error: Unsupported tool '${toolName}'.`;
    }
  } catch (error) {
    return `Tool execution error: ${error.message}`;
  }
}

// Main AI assistant function
async function startAgent() {
  console.log("\n******************************************");
  console.log("       Welcome to AI Task Assistant!");
  console.log("******************************************");
  console.log("Type 'exit' to quit.\n");

  try {
    while (true) {
      const userInput = await rl.question("You: ");

      // Exit application
      if (userInput.trim().toLowerCase() === "exit") {
        console.log("\nAgent: Goodbye!");
        break;
      }

      // Ignore empty input
      if (!userInput.trim()) {
        continue;
      }

      // Save user message
      messages.push({
        role: "user",
        content: userInput,
      });

      try {
        // Request AI response with available tools
        let response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: messages,
          tools: tools,
          tool_choice: "auto",
        });

        let assistantMessage = response.choices[0].message;

        // Handle tool calls (up to 5 rounds per request)
        let toolRounds = 0;

        while (assistantMessage.tool_calls?.length && toolRounds < 5) {
          toolRounds++;

          // Save assistant tool request
          messages.push(assistantMessage);

          // Execute each requested tool
          for (const toolCall of assistantMessage.tool_calls) {
            console.log(`\n[Executing tool: ${toolCall.function.name}]`);

            const result = await executeTool(toolCall);

            console.log(`[Tool result: ${result}]`);

            // Send tool result back to AI
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result,
            });
          }

          // Ask AI to interpret tool results
          response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            tools: tools,
            tool_choice: "auto",
          });

          assistantMessage = response.choices[0].message;
        }

        // Prevent an unresolved tool call from entering history
        if (assistantMessage.tool_calls?.length) {
          console.log(
            "\nAgent: Tool execution limit reached. Please try a simpler request.\n",
          );
          continue;
        }

        // Display final response
        const agentResponse =
          assistantMessage.content ?? "No response received.";

        console.log("\nAgent:", agentResponse, "\n");

        // Save final response
        messages.push({
          role: "assistant",
          content: agentResponse,
        });
      } catch (error) {
        console.error("\nError:", error.message, "\n");

        // Reset conversation to prevent invalid tool history
        messages.splice(1);

        console.log(
          "Conversation history reset after the error. You can try again.\n",
        );
      }
    }
  } finally {
    rl.close();
  }
}

// Start AI assistant
startAgent().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exitCode = 1;
});
