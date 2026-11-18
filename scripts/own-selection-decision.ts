// Pending selection decisions. Keeps the original item. Does not import a batch as accepted.
// v2 is a shape fixture only; the official nine wait for a later file.
import { readFileSync } from "node:fs";
import { closeDb } from "@aihot/backend/db";
import { JudgmentConflict, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { ImportRejected, assertThrowawayDatabase, cliEntryAllowed, parseSelectionDecisionDocument } from "../site/own-pipeline.ts";

const dryRun = process.argv.includes("--dry-run");
const fileFlag = process.argv.indexOf("--file");
const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : "";

async function main() {
  if (!file) throw new ImportRejected("usage: node scripts/own-selection-decision.ts --file <decisions.json> [--dry-run]");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new ImportRejected(`外发或模型开关打开，拒绝导入：${gate.outboundIfWorker.join(",")}`);
  const items = parseSelectionDecisionDocument(JSON.parse(readFileSync(file, "utf8")));
  const recorded = [];
  for (const item of items) {
    if (dryRun) {
      recorded.push({ articleId: item.articleId, evidenceHash: item.evidenceHash, dryRun: true, status: "pending_review", factStatus: "unchecked", releaseStatus: "not_licensed" });
      continue;
    }
    try {
      const result = await recordSelectionDecision(item, new Date().toISOString());
      recorded.push({
        articleId: item.articleId, judgmentId: result.id, idempotent: result.idempotent,
        status: "pending_review", factStatus: result.body.factStatus, releaseStatus: result.body.releaseStatus,
        outputSha256: result.body.selectionDecision?.outputSha256,
      });
    } catch (error) {
      if (!(error instanceof JudgmentConflict)) throw error;
      console.log(JSON.stringify({ ok: false, acceptedBatch: false, articleId: item.articleId, error: error.message, items: recorded }));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({ ok: true, dryRun, acceptedBatch: false, count: recorded.length, items: recorded }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, acceptedBatch: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { await closeDb(); }
