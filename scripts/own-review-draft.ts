// File import for a pending manuscript. The text is the draft, not the selection rationale.
import { readFileSync } from "node:fs";
import { closeDb } from "@aihot/backend/db";
import { JudgmentConflict, recordReviewDraft } from "@aihot/backend/own-pipeline-store";
import { ImportRejected, assertThrowawayDatabase, cliEntryAllowed, parseReviewDraftDocument } from "../site/own-pipeline.ts";

const dryRun = process.argv.includes("--dry-run");
const fileFlag = process.argv.indexOf("--file");
const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : "";

async function main() {
  if (!file) throw new ImportRejected("usage: node scripts/own-review-draft.ts --file <drafts.json> [--dry-run]");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new ImportRejected(`外发或模型开关打开，拒绝导入：${gate.outboundIfWorker.join(",")}`);
  const items = parseReviewDraftDocument(JSON.parse(readFileSync(file, "utf8")));
  const recorded = [];
  for (const item of items) {
    if (dryRun) {
      recorded.push({
        articleId: item.articleId, evidenceHash: item.evidenceHash, evidenceVersion: item.evidenceVersion,
        inputRevision: item.inputRevision, dryRun: true, technicalFixture: item.technicalFixture,
        requiresHumanReview: item.requiresHumanReview, factStatus: "unchecked", releaseStatus: "not_licensed",
      });
      continue;
    }
    try {
      const result = await recordReviewDraft(item, new Date().toISOString());
      recorded.push({
        articleId: item.articleId, judgmentId: result.id, idempotent: result.idempotent,
        technicalFixture: result.body.reviewDraft?.technicalFixture, requiresHumanReview: result.body.reviewDraft?.requiresHumanReview,
        factStatus: result.body.factStatus, releaseStatus: result.body.releaseStatus,
        boundSemanticJudgmentId: result.body.reviewDraft?.boundSemanticJudgmentId,
        boundSelectionJudgmentId: result.body.reviewDraft?.boundSelectionJudgmentId,
      });
    } catch (error) {
      if (!(error instanceof JudgmentConflict)) throw error;
      console.log(JSON.stringify({ ok: false, articleId: item.articleId, error: error.message, items: recorded }));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({ ok: true, dryRun, count: recorded.length, items: recorded }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { await closeDb(); }
