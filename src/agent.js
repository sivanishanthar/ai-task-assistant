import OpenAI from "openai";
import dotenv from "dotenv";
import readline from "node:readline/promises";
import { createAgent } from "./agentCore.js";

dotenv.config();
if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is missing.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const agent = createAgent({
  openai,
  onToolCall: name => console.log(`\n[Executing tool: ${name}]`),
  onToolResult: result => console.log(`[Tool result: ${result}]`),
});
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function startAgent() {
  console.log("\n******************************************");
  console.log("       Welcome to AI Task Assistant!");
  console.log("******************************************");
  console.log("Type 'exit' to quit.\n");
  try {
    while (true) {
      const userInput = await rl.question("You: ");
      if (userInput.trim().toLowerCase() === "exit") {
        console.log("\nAgent: Goodbye!");
        break;
      }
      if (!userInput.trim()) continue;
      try {
        console.log("\nAgent:", await agent.respond(userInput), "\n");
      } catch (error) {
        console.error("\nError:", error.message, "\n");
        console.log("Conversation history reset after the error. You can try again.\n");
      }
    }
  } finally {
    rl.close();
  }
}

startAgent().catch(error => {
  console.error("Fatal error:", error.message);
  process.exitCode = 1;
});
