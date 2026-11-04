import OpenAI from "openai";
import dotenv from "dotenv";
import readline from "node:readline/promises";
import { createAgent } from "./agentCore.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

async function startAgent() {
  dotenv.config();
  if (!process.env.OPENAI_API_KEY) {
    logger.agentFailure("startup");
    console.log("Error: OPENAI_API_KEY is missing.");
    process.exitCode = 1;
    return;
  }
  // Construction is inside the guarded startup path too: never print raw SDK
  // or terminal errors, which can include private input or configuration.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const agent = createAgent({ openai, logger });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
      } catch {
        logger.agentFailure("request");
        console.log("\nAgent: The request failed. Please try again.\n");
        console.log("Conversation history reset after the error. You can try again.\n");
      }
    }
  } finally {
    rl.close();
  }
}

startAgent().catch(() => {
  logger.agentFailure("fatal");
  console.log("Fatal error: The agent stopped unexpectedly.");
  process.exitCode = 1;
});
