import fs from "node:fs/promises";
import path from "node:path";

// Function to create a folder
export async function createFolder(
    folderName,
    workspace = path.resolve("workspace")
) {

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