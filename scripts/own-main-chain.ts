// Independently runnable entry. A --seal file is checked before any collect.
// The sealed config, contract and prior files are only read. A mismatch stops the run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "@aihot/backend/config";

config.allowPrivateNetworkFetch = true;
const defaults: Record<string, string> = {
  "--config": "docs/own-pipeline/contract-run-v15/CONFIG.json",
  "--out-dir": "docs/own-pipeline/contract-run-v15",
  "--prior": "docs/own-pipeline/contract-run-v15/PRIOR17.json",
  "--contract": "docs/own-pipeline/contract-run-v15/inputs/SOURCE_CONTRACT_v1.json",
};
for (const [flag, value] of Object.entries(defaults)) {
  if (!process.argv.includes(flag)) process.argv.push(flag, value);
}
const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sealPath = flag("--seal");
if (sealPath) {
  const seal = JSON.parse(readFileSync(sealPath, "utf8")) as { code?: { HEAD?: string }; files?: Record<string, string> };
  for (const [path, expected] of Object.entries(seal.files ?? {})) {
    const got = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (got !== expected) {
      console.error(`封存不一致 ${path} ${got} != ${expected}`);
      process.exit(2);
    }
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (seal.code?.HEAD && head !== seal.code.HEAD) {
    console.error(`HEAD ${head} != ${seal.code.HEAD}`);
    process.exit(2);
  }
  const dirty = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "scripts/own-main-chain.ts", "scripts/own-contract-entry.ts", "packages/backend/src/sources/collect.ts"], { encoding: "utf8" });
  if (dirty.trim()) {
    console.error(dirty);
    process.exit(2);
  }
}
await import("./own-contract-entry.ts");
