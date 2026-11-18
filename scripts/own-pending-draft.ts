// Read pending manuscripts. Does not write a manuscript, a score, or a publication.
import { writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { listPendingDrafts } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase, cliEntryAllowed } from "../site/own-pipeline.ts";

const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 ? process.argv[outFlag + 1] : "";

async function main() {
  if (!out) throw new Error("usage: node scripts/own-pending-draft.ts --out <file.json>");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new Error(`外发或模型开关打开，拒绝导出：${gate.outboundIfWorker.join(",")}`);
  const drafts = await listPendingDrafts();
  const items = [];
  for (const row of drafts) {
    const [article] = await sql<{ url: string; processing_state: string; revision: number }[]>`
      SELECT url, processing_state, revision FROM articles WHERE id = ${row.articleId}`;
    const [local] = await sql<{ publications: number; analyses: number; deliveries: number }[]>`
      SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${row.articleId}) AS publications,
             (SELECT count(*)::int FROM analyses WHERE article_id = ${row.articleId}) AS analyses,
             (SELECT count(*)::int FROM deliveries WHERE subject_id = ${row.articleId}) AS deliveries`;
    items.push({ ...row, url: article?.url ?? null, processingState: article?.processing_state ?? null, articleRevision: article?.revision ?? null, publications: local?.publications ?? null, analyses: local?.analyses ?? null, deliveries: local?.deliveries ?? null });
  }
  const held = items.every((item) => item.processingState === "skipped" && item.publications === 0 && item.analyses === 0 && item.factStatus === "unchecked" && item.releaseStatus === "not_licensed" && (item.technicalFixture === true || item.requiresHumanReview === true));
  const report = {
    qualityPass: false, realManuscripts: 0, styleScored: false, workerStarted: false, modelCalls: 0, paid: false,
    pending: items.length, heldOutOfSendQueue: held, items,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, pending: report.pending, heldOutOfSendQueue: report.heldOutOfSendQueue, qualityPass: false }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { await closeDb(); }
