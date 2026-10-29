import fs from "node:fs/promises";
import path from "node:path";

// Define workspace directory
const workspace = path.resolve("workspace");

// Function to create a file
export async function createFile(fileName) {

    // Validate filename
    if (
        typeof fileName !== "string" ||
        !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)
    ) {
        throw new Error("Invalid file name.");
    }

    // Construct file path
    const filePath = path.join(workspace, fileName);

    // Make sure workspace exists
    await fs.mkdir(workspace, { recursive: true });

    // Create a new empty file without overwriting an existing file
    const fileHandle = await fs.open(filePath, "wx");
    await fileHandle.close();

    return `File '${fileName}' created successfully.`;
}