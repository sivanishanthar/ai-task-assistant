import fs from "node:fs/promises";
import path from "node:path";

export async function listFiles(
    workspace = path.resolve("workspace")
) {
    await fs.mkdir(workspace, { recursive: true });

    const items = await fs.readdir(workspace, {
        withFileTypes: true
    });

    return items.map(item => ({
        name: item.name,
        type: item.isDirectory() ? "folder" : "file"
    }));
}