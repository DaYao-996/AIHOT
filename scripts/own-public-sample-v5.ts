// Rebind evidence to the current article revision. No new request. Does not rewrite v3 or v4.
import { writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { JudgmentConflict, alignEvidenceToArticleRevision, appendControlledEvidence, listPendingDrafts, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const OUT = "docs/own-pipeline/BINDING_AND_DRAFT_v5.json";
const FROZEN = new Set([
  "own_public_sample_test", "own_public_sample_v2_test", "own_public_sample_v3_test", "own_public_sample_v4_test",
  "own_rss_probe_test", "own_review_loop_test", "own_codex_note_test",
]);

async function mismatches() {
  return sql<{ id: string; url: string; article_revision: number; evidence_version: number; evidence_revision: number; evidence_hash: string; body_text: string }[]>`
    SELECT a.id, a.url, a.revision AS article_revision, v.version AS evidence_version, v.article_revision AS evidence_revision, v.evidence_hash, a.body_text
    FROM articles a
    JOIN LATERAL (
      SELECT version, article_revision, evidence_hash FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true
    WHERE a.revision <> v.article_revision
    ORDER BY a.url`;
}

function outputFor(body: string) {
  const excerpt = body.slice(0, 24);
  return {
    narrowClaim: "技术导入只验证绑定",
    quoteLocation: { excerpt, start: 0, end: excerpt.length },
    conditions: ["只验证当前修订"], time: "2026-11-18", valueBasis: "夹具", audience: ["复核绑定的人"],
    substantiveAddition: "没有新的语义结论", clauses: [{ id: "scope", text: "只验证绑定" }],
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDatabase(databaseUrl);
  const database = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (FROZEN.has(database)) throw new Error("这是已冻结的库");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
  const [counts] = await sql<{ articles: number; revisions: number; evidence: number; judgments: number }[]>`
    SELECT (SELECT count(*)::int FROM articles) AS articles, (SELECT count(*)::int FROM article_revisions) AS revisions,
           (SELECT count(*)::int FROM own_evidence_versions) AS evidence, (SELECT count(*)::int FROM own_judgments) AS judgments`;
  if (counts!.articles !== 40 || counts!.revisions !== 84 || counts!.evidence !== 41 || counts!.judgments !== 0) {
    throw new Error("这不是未改过的 v4 副本");
  }
  const before = await mismatches();
  if (before.length !== 10) throw new Error(`错位不是 10 条，是 ${before.length}`);
  const [target, other] = before;
  if (!target || !other) throw new Error("缺少对照材料");
  const targetOutput = outputFor(target.body_text);
  const rejectOld = await recordFileResult({
    articleId: target.id, evidenceHash: target.evidence_hash, evidenceVersion: target.evidence_version,
    inputRevision: target.evidence_revision, rulesetVersion: "rules@v5", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output: targetOutput,
  }, "2026-11-18T09:40:00.000Z").then(() => "accepted", (error) => error instanceof JudgmentConflict ? error.message : Promise.reject(error));
  const rejectNew = await recordFileResult({
    articleId: target.id, evidenceHash: target.evidence_hash, evidenceVersion: target.evidence_version,
    inputRevision: target.article_revision, rulesetVersion: "rules@v5", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output: targetOutput,
  }, "2026-11-18T09:40:01.000Z").then(() => "accepted", (error) => error instanceof JudgmentConflict ? error.message : Promise.reject(error));
  if (!rejectOld.includes("当前文章修订") || !rejectNew.includes("当前文章修订")) throw new Error(`错位时没有拒绝：${rejectOld} / ${rejectNew}`);

  const aligned = [];
  for (const row of before) {
    const result = await alignEvidenceToArticleRevision(row.id);
    if (result.unchanged || result.articleRevision !== row.article_revision || result.evidenceHash !== row.evidence_hash) {
      throw new Error(`绑定没有对齐 ${row.url}`);
    }
    aligned.push({ url: row.url, articleRevision: result.articleRevision, evidenceVersion: result.version, evidenceHash: result.evidenceHash, staled: result.staled });
  }
  if ((await mismatches()).length !== 0) throw new Error("对齐后仍有错位");

  const semantic = await recordFileResult({
    articleId: target.id, evidenceHash: aligned[0]!.evidenceHash, evidenceVersion: aligned[0]!.evidenceVersion,
    inputRevision: aligned[0]!.articleRevision, rulesetVersion: "rules@v5", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output: targetOutput,
  }, "2026-11-18T09:40:02.000Z");
  const oldStillRejected = await recordFileResult({
    articleId: target.id, evidenceHash: aligned[0]!.evidenceHash, evidenceVersion: aligned[0]!.evidenceVersion,
    inputRevision: target.evidence_revision, rulesetVersion: "rules@v5", promptVersion: "prompt@semantic-old",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output: targetOutput,
  }, "2026-11-18T09:40:03.000Z").then(() => "accepted", (error) => error instanceof JudgmentConflict ? error.message : Promise.reject(error));
  if (!oldStillRejected.includes("当前文章修订")) throw new Error("旧修订仍被接受");
  const decision = await recordSelectionDecision({
    articleId: target.id, evidenceHash: aligned[0]!.evidenceHash, evidenceVersion: aligned[0]!.evidenceVersion,
    inputRevision: aligned[0]!.articleRevision, rulesetVersion: "rules@v5", promptVersion: "prompt@select",
    decision_rationale: "技术夹具，只验证选择绑到当前修订。", conditions: ["只验证当前修订"],
  }, "2026-11-18T09:40:04.000Z");
  const draft = await recordReviewDraft({
    articleId: target.id, evidenceHash: aligned[0]!.evidenceHash, evidenceVersion: aligned[0]!.evidenceVersion,
    inputRevision: aligned[0]!.articleRevision, rulesetVersion: "rules@v5", promptVersion: "prompt@draft",
    text: "技术夹具稿，不是对外稿件。", sourceNote: "fixture", conditions: ["只验证当前修订"], technicalFixture: true,
  }, "2026-11-18T09:40:05.000Z");
  const otherOutput = outputFor(other.body_text);
  const otherSemantic = await recordFileResult({
    articleId: other.id, evidenceHash: aligned[1]!.evidenceHash, evidenceVersion: aligned[1]!.evidenceVersion,
    inputRevision: aligned[1]!.articleRevision, rulesetVersion: "rules@v5", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output: otherOutput,
  }, "2026-11-18T09:40:06.000Z");
  const otherDecision = await recordSelectionDecision({
    articleId: other.id, evidenceHash: aligned[1]!.evidenceHash, evidenceVersion: aligned[1]!.evidenceVersion,
    inputRevision: aligned[1]!.articleRevision, rulesetVersion: "rules@v5", promptVersion: "prompt@select",
    decision_rationale: "旁观夹具，只验证不受影响。", conditions: ["旁观"],
  }, "2026-11-18T09:40:07.000Z");
  const otherDraft = await recordReviewDraft({
    articleId: other.id, evidenceHash: aligned[1]!.evidenceHash, evidenceVersion: aligned[1]!.evidenceVersion,
    inputRevision: aligned[1]!.articleRevision, rulesetVersion: "rules@v5", promptVersion: "prompt@draft",
    text: "旁观夹具稿。", sourceNote: "fixture", conditions: ["旁观"], technicalFixture: true,
  }, "2026-11-18T09:40:08.000Z");
  const [targetRow] = await sql<{ source_id: string; title: string; body_text: string; raw: unknown }[]>`
    SELECT source_id, title, body_text, raw FROM articles WHERE id = ${target.id}`;
  await appendControlledEvidence({
    sourceId: targetRow!.source_id, url: target.url, title: targetRow!.title, raw: targetRow!.raw ?? { role: "binding-check" },
    bodyText: `${targetRow!.body_text}技术回归标记。`,
  });
  const [stale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${draft.id}`;
  const [kept] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${otherDraft.id}`;
  if (!stale!.stale || kept!.stale) throw new Error("失效没有停在被改的那一篇");
  const pending = await listPendingDrafts();
  if (!pending.some((row) => row.id === otherDraft.id) || pending.some((row) => row.id === draft.id)) throw new Error("待审稿导出没有守住当前修订");
  const [finalCounts] = await sql<{ articles: number; revisions: number; evidence: number; queued: number; publications: number }[]>`
    SELECT (SELECT count(*)::int FROM articles) AS articles, (SELECT count(*)::int FROM article_revisions) AS revisions,
           (SELECT count(*)::int FROM own_evidence_versions) AS evidence,
           (SELECT count(*)::int FROM articles WHERE processing_state = 'new') AS queued,
           (SELECT count(*)::int FROM publications) AS publications`;
  if (finalCounts!.articles !== 40 || finalCounts!.queued !== 0 || finalCounts!.publications !== 0) throw new Error(`库状态不符 ${JSON.stringify(finalCounts)}`);
  const report = {
    asOf: new Date().toISOString(), basedOn: "public-sample-v4", frozenV3Unchanged: true, frozenV4Unchanged: true,
    database, newRequests: 0, qualityPass: false, realManuscripts: 0, styleScored: false,
    workerStarted: false, modelCalls: 0, paid: false, completenessClaimed: false,
    beforeMismatch: before.map((row) => ({ url: row.url, articleRevision: row.article_revision, evidenceRevision: row.evidence_revision, evidenceVersion: row.evidence_version })),
    rejectedBeforeAlign: { oldRevision: rejectOld, currentRevisionWhileEvidenceBehind: rejectNew },
    aligned, rejectedOldRevisionAfterAlign: oldStillRejected,
    target: { url: target.url, semanticId: semantic.id, selectionId: decision.id, draftId: draft.id, draftStale: true },
    other: { url: other.url, semanticId: otherSemantic.id, selectionId: otherDecision.id, draftId: otherDraft.id, draftStale: false },
    pendingDrafts: pending.length, counts: finalCounts,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, database, aligned: aligned.length, pendingDrafts: pending.length, queued: finalCounts!.queued }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => undefined);
  await closeDb();
}
