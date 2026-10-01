import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "backdrop-sync-test-"));

await esbuild.build({
  entryPoints: ["src/syncState.test.ts", "src/secrets.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir,
  logLevel: "silent",
});

let status = 0;
for (const name of fs.readdirSync(outdir)) {
  if (!name.endsWith(".js")) continue;
  const result = spawnSync(process.execPath, ["--test", path.join(outdir, name)], { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) status = result.status ?? 1;
}
fs.rmSync(outdir, { recursive: true, force: true });
process.exit(status);
