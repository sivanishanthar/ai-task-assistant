import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve("workspace");

export async function listFiles() {
    await fs.mkdir(workspace, { recursive: true });

    const items = await fs.readdir(workspace, {
        withFileTypes: true
    });

    return items.map(item => ({
        name: item.name,
        type: item.isDirectory() ? "folder" : "file"
    }));
}