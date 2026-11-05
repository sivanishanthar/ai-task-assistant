import OpenAI from "openai";
import path from "node:path";
import dotenv from "dotenv";
import readline from "node:readline/promises";
import { createAgent } from "./agentCore.js";
import { createLogger } from "./logger.js";
import { timeoutConfigFromEnv } from "./timeouts.js";
import { historyConfigFromEnv } from "./history.js";
import { formatHelp } from "./help.js";
import { getStatus, formatStatus } from "./status.js";

const logger = createLogger();

async function startAgent() {
  dotenv.config();
  const helpRequested = process.argv.slice(2).some(argument => argument === "--help" || argument === "-h");
  const statusRequested = process.argv.slice(2).includes("--status");
  if (!helpRequested && !statusRequested && !process.env.OPENAI_API_KEY) {
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
  const workspace = path.resolve("workspace");
  const help = formatHelp({ ...timeouts, ...historyLimits });
  const status = async () => formatStatus(await getStatus({ workspace, ...timeouts, ...historyLimits,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY) }));
  if (helpRequested) {
    console.log(help);
    return;
  }
  if (statusRequested) {
    console.log(await status());
    return;
  }
  // Construction is inside the guarded startup path too: never print raw SDK
  // or terminal errors, which can include private input or configuration.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const agent = createAgent({ openai, logger, workspace, ...timeouts, ...historyLimits });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n******************************************");
  console.log("       Welcome to AI Task Assistant!");
  console.log("******************************************");
  console.log("Type 'help' for tools and limits, 'status' for setup checks, 'reset' to clear history, or 'exit' to quit.\n");
  try {
    while (true) {
      const userInput = await rl.question("You: ");
      const command = userInput.trim().toLowerCase();
      if (command === "exit") {
        console.log("\nAgent: Goodbye!");
        break;
      }
      if (!command) continue;
      if (command === "help") {
        console.log(help);
        continue;
      }
      if (command === "status") {
        console.log(await status());
        continue;
      }
      if (command === "reset") {
        agent.reset();
        console.log("\nAgent: Conversation history cleared. System instructions and workspace files are unchanged.\n");
        continue;
      }
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
