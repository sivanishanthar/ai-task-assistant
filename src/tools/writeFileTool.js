import fs from "node:fs/promises";
import path from "node:path";

// Define workspace directory
const workspace = path.resolve("workspace");

// Function to write content into a file
export async function writeFile(fileName, content) {

    // Validate filename
    if (
        typeof fileName !== "string" ||
        !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName)
    ) {
        throw new Error("Invalid file name.");
    }

    // Validate content
    if (typeof content !== "string") {
        throw new Error("Content must be a string.");
    }

    // Construct file path
    const filePath = path.join(workspace, fileName);

    // Ensure workspace exists
    await fs.mkdir(workspace, { recursive: true });

    // Write only to a new file or an existing empty file.
    // This prevents accidental overwriting of user content.
    try {
        const handle = await fs.open(filePath, "wx");
        try {
            await handle.writeFile(content, "utf8");
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }

        // Existing files must be empty.
        const stats = await fs.lstat(filePath);

        if (!stats.isFile() || stats.size !== 0) {
            throw new Error(
                `File '${fileName}' already contains data. Overwriting is not allowed.`
            );
        }

        // Use an exclusive file handle to avoid following symlinks.
        const handle = await fs.open(filePath, "r+");

        try {
            const currentStats = await handle.stat();

            if (!currentStats.isFile() || currentStats.size !== 0) {
                throw new Error("File is no longer an empty regular file.");
            }

            await handle.writeFile(content, "utf8");
        } finally {
            await handle.close();
        }
    }

    return `Content successfully written to '${fileName}'.`;
}