// Content links and chart units from bytes already stored. No new request. Does not rewrite v3, v4, or v5.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { appendLocatedSupplement } from "@aihot/backend/own-pipeline-store";
import { chartAxisParts, storedContentLink } from "@aihot/backend/sources/saved-supplements";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const FACTS = "docs/own-pipeline/HREF_FACTS_v3.json";
const FACTS_SHA = "85a8f53b759c5369b0db4ef5230e4dcc31cabdaeba1da77a6dac8144c8645249";
const OUT = "docs/own-pipeline/LINKS_AND_AXIS_v6.json";
const MISTRAL_URL = "https://mistral.ai/news/mistral-large-4-oss/";
const FROZEN = new Set([
  "own_public_sample_test", "own_public_sample_v2_test", "own_public_sample_v3_test",
  "own_public_sample_v4_test", "own_public_sample_v5_test", "own_rss_probe_test", "own_review_loop_test",
]);

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDatabase(databaseUrl);
  const database = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (FROZEN.has(database)) throw new Error("这是已冻结的库");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
  const factBytes = readFileSync(FACTS);
  if (sha(factBytes) !== FACTS_SHA) throw new Error("链接事实哈希不符");
  const facts = JSON.parse(factBytes.toString("utf8")) as { items: Array<Record<string, unknown>> };
  const [beforeJudgments] = await sql<{ ids: string[] }[]>`
    SELECT coalesce(array_agg(id ORDER BY id) FILTER (WHERE stale), '{}') AS ids FROM own_judgments`;
  const staleBefore = new Set(beforeJudgments!.ids ?? []);
  const linkReports = [];
  for (const item of facts.items) {
    const url = String(item.url);
    const [article] = await sql<{ id: string; body_text: string | null }[]>`SELECT id, body_text FROM articles WHERE url = ${url}`;
    if (!article) throw new Error(`库里没有 ${url}`);
    const [file] = await sql<{ raw: Buffer; file_sha: string }[]>`
      SELECT raw_file AS raw, encode(sha256(raw_file), 'hex') AS file_sha FROM own_evidence_versions
      WHERE article_id = ${article.id} AND raw_file IS NOT NULL ORDER BY version DESC LIMIT 1`;
    if (!file || file.file_sha !== item.rawSha256) throw new Error(`原件哈希不符 ${url}`);
    const html = file.raw.toString("utf8");
    const kept = [];
    const skipped = [];
    for (const anchor of (item.anchors as Array<{ label: string; href: string; absoluteUrl: string; byteOffset: number; limit?: string }>) ?? []) {
      const found = storedContentLink(html, url, article.body_text ?? "", anchor);
      if ("skipped" in found) skipped.push({ label: anchor.label, reason: found.skipped });
      else kept.push({ ...found, limit: anchor.limit ?? null, linkedPageRead: false as const });
    }
    let evidence = null;
    if (kept.length) {
      evidence = await appendLocatedSupplement(article.id, {
        kind: "content-links", sourceUrl: url, httpStatus: 200, responseSha256: file.file_sha,
        parts: kept.map((link, index) => ({
          id: `link-${index + 1}`, role: "content_link", byteStart: link.byteStart, byteEnd: link.byteEnd,
          text: [`label: ${link.label}`, `absoluteUrl: ${link.absoluteUrl}`, `linkedPageRead: false`, link.limit ? `limit: ${link.limit}` : ""].filter(Boolean).join("\n"),
        })),
      });
    }
    const [bodyAfter] = await sql<{ body_text: string | null }[]>`SELECT body_text FROM articles WHERE id = ${article.id}`;
    if (bodyAfter!.body_text !== article.body_text) throw new Error(`正文被覆盖 ${url}`);
    linkReports.push({
      nn: item.nn, url, rawSha256: item.rawSha256, kept, skipped,
      plainTextNoHref: item.plainTextNoHref ?? [],
      evidence, bodyUnchanged: true, linkedPagesRead: false,
    });
  }
  const [mistral] = await sql<{ id: string; body_text: string }[]>`SELECT id, body_text FROM articles WHERE url = ${MISTRAL_URL}`;
  const [mistralFile] = await sql<{ raw: Buffer; file_sha: string }[]>`
    SELECT raw_file AS raw, encode(sha256(raw_file), 'hex') AS file_sha FROM own_evidence_versions
    WHERE article_id = ${mistral!.id} AND raw_file IS NOT NULL ORDER BY version DESC LIMIT 1`;
  const charts = chartAxisParts(mistralFile!.raw.toString("utf8"));
  if (charts.some((part) => part.text.startsWith("chartNotExtracted"))) throw new Error("有图表没有抽出");
  const first = charts[0]?.text ?? "";
  if (!first.includes("value.label: Score") || !first.includes("value.suffix: %") || !first.includes("value.decimals: 1")) {
    throw new Error("首图没有留下 Score/%");
  }
  const chartEvidence = await appendLocatedSupplement(mistral!.id, {
    kind: "chart-axis", sourceUrl: MISTRAL_URL, httpStatus: 200, responseSha256: mistralFile!.file_sha,
    parts: charts,
  });
  const [mistralBody] = await sql<{ body_text: string }[]>`SELECT body_text FROM articles WHERE id = ${mistral!.id}`;
  if (mistralBody!.body_text !== mistral!.body_text) throw new Error("Mistral 正文被覆盖");
  const staleNow = await sql<{ id: string; article_id: string }[]>`SELECT id, article_id FROM own_judgments WHERE stale = true`;
  const newlyStale = staleNow.filter((row) => !staleBefore.has(row.id));
  const touched = new Set([
    ...linkReports.filter((row) => row.evidence).map((row) => row.url),
    MISTRAL_URL,
  ]);
  const [touchedIds] = await sql<{ ids: string[] }[]>`SELECT array_agg(id) AS ids FROM articles WHERE url IN ${sql([...touched])}`;
  const allowed = new Set(touchedIds!.ids ?? []);
  if (newlyStale.some((row) => !allowed.has(row.article_id))) throw new Error("其他篇的判断被失效了");
  const [counts] = await sql<{ articles: number; queued: number; publications: number }[]>`
    SELECT (SELECT count(*)::int FROM articles) AS articles,
           (SELECT count(*)::int FROM articles WHERE processing_state = 'new') AS queued,
           (SELECT count(*)::int FROM publications) AS publications`;
  if (counts!.articles !== 40 || counts!.queued !== 0 || counts!.publications !== 0) throw new Error(`库状态不符 ${JSON.stringify(counts)}`);
  const report = {
    asOf: new Date().toISOString(), basedOn: "public-sample-v5", factsSha256: FACTS_SHA,
    frozenV3Unchanged: true, frozenV4Unchanged: true, frozenV5Unchanged: true,
    database, newRequests: 0, qualityPass: false, linkedPagesRead: false,
    workerStarted: false, modelCalls: 0, paid: false, completenessClaimed: false,
    links: linkReports,
    chartAxis: { url: MISTRAL_URL, evidence: chartEvidence, parts: charts.length, firstHasScorePercent: true, bodyUnchanged: true },
    newlyStaleJudgments: newlyStale.length, counts,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: true, database,
    supplemented: linkReports.filter((row) => row.evidence).map((row) => row.nn),
    skipped: linkReports.filter((row) => !row.evidence).map((row) => row.nn),
    charts: charts.length, newlyStale: newlyStale.length,
  }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => undefined);
  await closeDb();
}
