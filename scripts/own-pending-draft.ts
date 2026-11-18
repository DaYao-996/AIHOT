// Read pending manuscripts. Does not write a manuscript, a score, or a publication.
import { writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
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
  const [jobsTable] = await sql<{ ok: boolean }[]>`SELECT to_regclass('pgboss.job') IS NOT NULL AS ok`;
  const items = [];
  for (const row of drafts) {
    const [article] = await sql<{ url: string; processing_state: string; revision: number }[]>`
      SELECT url, processing_state, revision FROM articles WHERE id = ${row.articleId}`;
    const [local] = await sql<{ publications: number; publicPublications: number; analyses: number; deliveries: number; receipts: number }[]>`
      SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${row.articleId}) AS publications,
             (SELECT count(*)::int FROM publications WHERE article_id = ${row.articleId} AND visibility = 'public') AS "publicPublications",
             (SELECT count(*)::int FROM analyses WHERE article_id = ${row.articleId}) AS analyses,
             (SELECT count(*)::int FROM deliveries WHERE subject_id = ${row.articleId}) AS deliveries,
             (SELECT count(*)::int FROM receipts WHERE subject = ${`article:${row.articleId}`}) AS receipts`;
    const [jobs] = jobsTable?.ok ? await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created', 'retry') AND data->>'articleId' = ${row.articleId}
        AND name IN ('content.analyze', 'content.extract-body', 'events.group', 'notify.selected')` : [{ n: 0 }];
    items.push({
      ...row, url: article?.url ?? null, processingState: article?.processing_state ?? null, articleRevision: article?.revision ?? null,
      publications: local?.publications ?? null, publicPublications: local?.publicPublications ?? null, analyses: local?.analyses ?? null,
      deliveries: local?.deliveries ?? null, receipts: local?.receipts ?? null, releaseJobs: jobs?.n ?? 0,
    });
  }
  const held = items.every((item) => item.processingState === "skipped" && item.publicPublications === 0 && item.analyses === 0
    && item.deliveries === 0 && item.receipts === 0 && item.releaseJobs === 0 && item.factStatus === "unchecked"
    && item.releaseStatus === "not_licensed" && (item.technicalFixture === true || item.requiresHumanReview === true));
  const report = {
    qualityPass: false, realManuscripts: items.filter((item) => item.technicalFixture === false).length, styleScored: false,
    pending: items.length, heldOutOfSendQueue: held, items,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, pending: report.pending, realManuscripts: report.realManuscripts, heldOutOfSendQueue: report.heldOutOfSendQueue, qualityPass: false }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { await stopBoss(); await closeDb(); }
