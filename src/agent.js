import OpenAI from "openai";
import dotenv from "dotenv";
import readline from "node:readline/promises";
import { createAgent } from "./agentCore.js";
import { createLogger } from "./logger.js";
import { timeoutConfigFromEnv } from "./timeouts.js";
import { historyConfigFromEnv } from "./history.js";

const logger = createLogger();

async function startAgent() {
  dotenv.config();
  if (!process.env.OPENAI_API_KEY) {
    logger.agentFailure("startup");
    console.log("Error: OPENAI_API_KEY is missing.");
    process.exitCode = 1;
    return;
  }
  let timeouts;
  try {
    timeouts = timeoutConfigFromEnv();
  } catch {
    logger.agentFailure("startup");
    console.log("Error: API_TIMEOUT_MS and WORKER_TIMEOUT_MS must be integer milliseconds between 1 and 2147483647.");
    process.exitCode = 1;
    return;
  }
  let historyLimits;
  try {
    historyLimits = historyConfigFromEnv();
  } catch {
    logger.agentFailure("startup");
    console.log("Error: MAX_HISTORY_TURNS and MAX_HISTORY_BYTES must be positive safe integers.");
    process.exitCode = 1;
    return;
  }
  // Construction is inside the guarded startup path too: never print raw SDK
  // or terminal errors, which can include private input or configuration.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const agent = createAgent({ openai, logger, ...timeouts, ...historyLimits });
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
      } catch (error) {
        logger.agentFailure("request");
        if (error.code === "OPENAI_TIMEOUT") {
          console.log("\nAgent: OpenAI request timed out. Please try again. Previously completed tools are not rolled back.\n");
        } else if (error.code === "HISTORY_LIMIT") {
          console.log("\nAgent: Conversation history exceeds the configured limit. Use a shorter request or smaller file. Previously completed tools are not rolled back.\n");
        } else {
          console.log("\nAgent: The request failed. Please try again.\n");
        }
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
