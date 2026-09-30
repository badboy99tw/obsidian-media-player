import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["main.js", "manifest.json", "styles.css"];

async function findVaultRoot(start) {
  let current = start;
  while (true) {
    try {
      await access(path.join(current, ".obsidian"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error("找不到包含 .obsidian 的 vault 根目錄");
      current = parent;
    }
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const vaultRoot = await findVaultRoot(projectRoot);
const manifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
if (!manifest.id) throw new Error("manifest.json 缺少 plugin id");

const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", manifest.id);
await mkdir(pluginDir, { recursive: true });

for (const name of files) {
  const source = path.join(projectRoot, name);
  const destination = path.join(pluginDir, name);
  await copyFile(source, destination);
  const [sourceContents, deployedContents] = await Promise.all([
    readFile(source),
    readFile(destination),
  ]);
  if (sha256(sourceContents) !== sha256(deployedContents)) {
    throw new Error(`${name} 部署後雜湊不一致`);
  }
  console.log(`deployed ${name}`);
}

const sourceNotice = `# Music Transcriber deployment

This directory is generated deployment output. Do not edit it directly.

- Source: \`projects/Obsidian Music Transcriber/\`
- Deploy from vault root: \`make music-transcriber-deploy\`
- Deploy: \`npm --prefix "projects/Obsidian Music Transcriber" run deploy\`
- After deployment: run \`Reload app without saving\` in Obsidian.
`;
await writeFile(path.join(pluginDir, "SOURCE.md"), sourceNotice, "utf8");
console.log("generated SOURCE.md");

console.log(`plugin directory: ${path.relative(vaultRoot, pluginDir)}`);
