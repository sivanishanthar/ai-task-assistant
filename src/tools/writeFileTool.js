
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

// Function to write content into a file
export async function writeFile(
    fileName,
    content,
    workspace = path.resolve("workspace")
) {

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

    // Exclusive creation never follows an existing final-component symlink.
    let handle;
    try {
        handle = await fs.open(filePath, "wx");
    } catch (error) {
        // Only an open collision may enter the existing-file path.
        if (error.code !== "EEXIST") {
            throw error;
        }

        const stats = await fs.lstat(filePath);
        if (!stats.isFile() || stats.size !== 0) {
            throw new Error(
                `File '${fileName}' already contains data. Overwriting is not allowed.`
            );
        }

        // Do not create, truncate, or follow a symlink if the entry changed.
        handle = await fs.open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
            const currentStats = await handle.stat();
            if (
                !currentStats.isFile() ||
                currentStats.size !== 0 ||
                currentStats.dev !== stats.dev ||
                currentStats.ino !== stats.ino
            ) {
                throw new Error("File is no longer the same empty regular file.");
            }
        } catch (error) {
            await handle.close();
            throw error;
        }
    }

    try {
        await handle.writeFile(content, "utf8");
    } finally {
        await handle.close();
    }

    return `Content successfully written to '${fileName}'.`;
}
