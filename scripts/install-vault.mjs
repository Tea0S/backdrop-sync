import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const vaultPlugin = path.resolve(
  process.env.BACKDROP_SYNC_VAULT_PLUGIN ||
    "C:/Users/Bambi/Documents/Roleplay Writing/.obsidian/plugins/backdrop-sync"
);

fs.mkdirSync(vaultPlugin, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const src = path.join(root, file);
  if (!fs.existsSync(src)) {
    console.error(`Missing ${file} — run build first.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(vaultPlugin, file));
  console.log(`Copied ${file} → ${vaultPlugin}`);
}
