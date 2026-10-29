import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve("workspace");

export async function listFiles() {
    await fs.mkdir(workspace, { recursive: true });

    const items = await fs.readdir(workspace, {
        withFileTypes: true
    });

    if (items.length === 0) {
        return "The workspace is empty.";
    }

    return items.map(item => ({
        name: item.name,
        type: item.isDirectory() ? "folder" : "file"
    }));
}