import fs from "node:fs/promises";
import path from "node:path";

// Define workspace directory
const workspace = path.resolve("workspace");

// Read a text file from the workspace
export async function readFile(fileName) {

    // Validate filename
    if (
        typeof fileName !== "string" ||
        !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)
    ) {
        throw new Error("Invalid file name.");
    }

    // Construct file path
    const filePath = path.join(workspace, fileName);

    // Check file information
    const stats = await fs.lstat(filePath);

    // Only allow regular files
    if (!stats.isFile()) {
        throw new Error("The requested path is not a regular file.");
    }

    // Prevent reading excessively large files
    const maxSize = 100 * 1024; // 100 KB

    if (stats.size > maxSize) {
        throw new Error("File exceeds the 100 KB reading limit.");
    }

    // Read the file
    const content = await fs.readFile(filePath, "utf8");

    return content;
}