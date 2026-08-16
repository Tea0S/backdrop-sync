import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outfile = path.join(os.tmpdir(), `backdrop-sync-test-${process.pid}.cjs`);

await esbuild.build({
  entryPoints: ["src/syncState.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "silent",
});

const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
fs.rmSync(outfile, { force: true });
process.exit(result.status ?? 1);
