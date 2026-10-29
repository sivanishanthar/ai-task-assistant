import fs from "node:fs/promises";
import path from "node:path";

// Define the workspace directory
const workspace = path.resolve("workspace");

// Function to create a folder
export async function createFolder(folderName) {

  // Validate the folder name
  if (
    typeof folderName !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(folderName)
  ) {
    throw new Error("Invalid folder name.");
  }

  // Construct the folder path
  const folderPath = path.join(workspace, folderName);

  // Create the folder
  await fs.mkdir(folderPath, { recursive: true });

  // Return success message
  return `Folder '${folderName}' created successfully.`;
}