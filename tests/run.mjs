// Runs every tests/*.test.ts: each file is bundled with rolldown (already installed with Vite) and run with node.
// Usage: npm test            all files
//        npm test -- model   only files whose name contains "model"
import { readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "rolldown";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "node_modules", ".cache", "cutir-tests");
mkdirSync(out, { recursive: true });

const only = process.argv[2];
const files = readdirSync(here).filter((f) => f.endsWith(".test.ts") && (!only || f.includes(only)));
let failed = 0;

for (const f of files) {
  const file = join(out, f.replace(/\.ts$/, ".mjs"));
  await build({ input: join(here, f), platform: "node", logLevel: "silent", output: { file, format: "esm" } });
  console.log(`\n== ${f}`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
