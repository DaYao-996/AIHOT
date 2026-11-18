// Gap check for already-public unblinded samples. No scores, no database writes, no network.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { unblindedStructureGaps } from "../site/own-pipeline.ts";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/own-gap-check.ts <samples-dir>");
  process.exit(1);
}
const reports = readdirSync(root).sort().map((id) => {
  const rawBytes = readFileSync(`${root}/${id}/raw.json`);
  const record = JSON.parse(readFileSync(`${root}/${id}/record.json`, "utf8")) as { root_text?: unknown; quote?: unknown };
  const raw = JSON.parse(rawBytes.toString("utf8")) as unknown;
  return {
    postId: id,
    rawBytes: rawBytes.length,
    rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
    ...unblindedStructureGaps(record, raw),
    holdout: false,
  };
});
console.log(JSON.stringify(reports, null, 2));
