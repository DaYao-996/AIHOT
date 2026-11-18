// File reasoning entry. No vendor call, no vendor receipt, no scoring.
import { readFileSync } from "node:fs";
import { closeDb } from "@aihot/backend/db";
import { JudgmentConflict, recordFileResult } from "@aihot/backend/own-pipeline-store";
import { ImportRejected, assertThrowawayDatabase, cliEntryAllowed, parseFileResultDocument } from "../site/own-pipeline.ts";

const dryRun = process.argv.includes("--dry-run");
const fileFlag = process.argv.indexOf("--file");
const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : "";

async function main() {
  if (!file) throw new ImportRejected("usage: node scripts/own-file-result.ts --file <results.json> [--dry-run]");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new ImportRejected(`外发或模型开关打开，拒绝导入：${gate.outboundIfWorker.join(",")}`);
  const items = parseFileResultDocument(JSON.parse(readFileSync(file, "utf8")));
  const recorded = [];
  for (const item of items) {
    try {
      const result = await recordFileResult(item, new Date().toISOString(), dryRun ? { write: false } : undefined);
      if (dryRun) {
        recorded.push({ articleId: item.articleId, evidenceHash: item.evidenceHash, evidenceVersion: item.evidenceVersion, dryRun: true, vendorReceipt: false, factStatus: result.body.factStatus, releaseStatus: result.body.releaseStatus });
        continue;
      }
      recorded.push({
        articleId: item.articleId,
        judgmentId: result.id,
        idempotent: result.idempotent,
        origin: result.body.origin,
        factStatus: result.body.factStatus,
        releaseStatus: result.body.releaseStatus,
        fileReceipt: result.fileReceipt,
      });
    } catch (error) {
      if (!(error instanceof JudgmentConflict)) throw error;
      console.log(JSON.stringify({ ok: false, vendorReceipt: false, articleId: item.articleId, error: error.message, items: recorded }));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({ ok: true, dryRun, vendorReceipt: false, count: recorded.length, items: recorded }));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, vendorReceipt: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await closeDb();
}
