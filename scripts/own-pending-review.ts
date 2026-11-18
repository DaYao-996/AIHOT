// Read the pending review queue. Does not write a manuscript, a score, or a publication.
import { writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { listPendingSelections } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase, cliEntryAllowed } from "../site/own-pipeline.ts";

const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 ? process.argv[outFlag + 1] : "";

async function bossJobs(): Promise<number | null> {
  const [present] = await sql<{ name: string | null }[]>`SELECT to_regclass('pgboss.job')::text AS name`;
  if (!present?.name) return null;
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job`;
  return row!.n;
}

async function main() {
  if (!out) throw new Error("usage: node scripts/own-pending-review.ts --out <file.json>");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new Error(`外发或模型开关打开，拒绝导出：${gate.outboundIfWorker.join(",")}`);
  const pending = await listPendingSelections();
  const items = [];
  for (const row of pending) {
    const [article] = await sql<{ url: string; processing_state: string; revision: number }[]>`
      SELECT url, processing_state, revision FROM articles WHERE id = ${row.articleId}`;
    const [semantic] = await sql<{
      stale: boolean; evidence_hash: string; input_revision: number; output_sha: string | null; claim: string | null;
      fact_status: string; release_status: string;
    }[]>`SELECT stale, evidence_hash, input_revision, comparison->'fileResult'->>'outputSha256' AS output_sha,
      comparison->'fileResult'->'output'->>'narrowClaim' AS claim, fact_status, release_status
      FROM own_judgments WHERE id = ${row.boundSemanticJudgmentId}`;
    const [local] = await sql<{ publications: number; analyses: number; deliveries: number }[]>`
      SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${row.articleId}) AS publications,
             (SELECT count(*)::int FROM analyses WHERE article_id = ${row.articleId}) AS analyses,
             (SELECT count(*)::int FROM deliveries WHERE subject_id = ${row.articleId}) AS deliveries`;
    const item = row.item;
    items.push({
      articleId: row.articleId,
      url: article?.url ?? null,
      processingState: article?.processing_state ?? null,
      articleRevision: article?.revision ?? null,
      selectionId: row.id,
      selectionOutputSha256: row.outputSha256,
      evidenceHash: row.evidenceHash,
      evidenceVersion: item.evidenceVersion ?? null,
      inputRevision: row.inputRevision,
      promptVersion: row.promptVersion,
      boundSemanticJudgmentId: row.boundSemanticJudgmentId,
      semanticStale: semantic?.stale ?? null,
      semanticEvidenceHash: semantic?.evidence_hash ?? null,
      semanticInputRevision: semantic ? Number(semantic.input_revision) : null,
      semanticOutputSha256: semantic?.output_sha ?? null,
      usedClaim: item.used_claim ?? null,
      semanticClaim: semantic?.claim ?? null,
      conditions: item.conditions ?? null,
      uncertaintyNotes: item.uncertainty_notes ?? null,
      missingItems: item.missing_items ?? null,
      abstainReasons: item.abstain_reasons ?? null,
      decisionRationale: item.decision_rationale ?? null,
      factStatus: semantic?.fact_status ?? null,
      releaseStatus: semantic?.release_status ?? null,
      publications: local?.publications ?? null,
      analyses: local?.analyses ?? null,
      deliveries: local?.deliveries ?? null,
    });
  }
  const ready = items.filter((item) =>
    item.processingState !== "skipped"
    || item.publications !== 0
    || item.analyses !== 0
    || item.factStatus !== "unchecked"
    || item.releaseStatus !== "not_licensed"
    || item.semanticStale !== false
    || item.semanticEvidenceHash !== item.evidenceHash
    || item.semanticInputRevision !== item.inputRevision);
  const report = {
    qualityPass: false,
    oldSampleIsNotNewAcceptance: true,
    styleScored: false,
    manuscriptsWritten: 0,
    workerStarted: false,
    modelCalls: 0,
    paid: false,
    pending: items.length,
    heldOutOfSendQueue: ready.length === 0,
    bossJobs: await bossJobs(),
    items,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: true, pending: report.pending, heldOutOfSendQueue: report.heldOutOfSendQueue,
    bossJobs: report.bossJobs, qualityPass: false,
  }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { await closeDb(); }
