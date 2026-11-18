// Offline proof: the same saved page goes through the normal parser into scoring.
// A read-only pass can also show supplements that were already stored on evidence.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readable } from "@aihot/backend/content/extract";
import { closeDb, sql } from "@aihot/backend/db";
import { applyDetail } from "@aihot/backend/sources/collect";
import { JudgmentConflict, appendControlledEvidence, materialForScoring, recordFileResult } from "@aihot/backend/own-pipeline-store";
import { cumulativeEvidenceHash, assertThrowawayDatabase } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_test", "own_public_sample_v2_test", "own_public_sample_v3_test",
  "own_public_sample_v4_test", "own_public_sample_v5_test", "own_public_sample_v6_test",
  "own_public_sample_v9_test", "own_public_sample_v9_change_test", "own_rss_probe_test", "own_review_loop_test",
]);
const readOnly = process.argv.includes("--read-only");
const htmlFlag = process.argv.indexOf("--html");
const bodyFlag = process.argv.indexOf("--body");
const outFlag = process.argv.indexOf("--out");

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
const database = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
if (!readOnly && FROZEN.has(database)) throw new Error("这是已冻结的库");
if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");

if (readOnly) {
  const rows = await sql<{ id: string; url: string }[]>`
    SELECT id, url FROM articles WHERE url IN (
      'https://mistral.ai/news/mistral-large-4-oss/',
      'https://mistral.ai/news/build-with-studio/',
      'https://deepmind.google/blog/introducing-alphaproof-code/'
    ) ORDER BY url`;
  const items = [];
  for (const row of rows) {
    const scored = await materialForScoring(row.id);
    const view = JSON.stringify(scored?.aside ?? {});
    items.push({
      url: row.url,
      bodyChars: scored?.bodyText?.length ?? 0,
      scoringHasValueSuffixLine: view.includes("value.suffix:"),
      scoringHasDocsHost: view.includes("docs.mistral.ai"),
      scoringHasCodeVerification: view.includes("code-verification"),
      linkCount: scored?.aside.links.length ?? 0,
      chartCount: scored?.aside.charts.length ?? 0,
    });
  }
  const report = { readOnly: true, database, items };
  if (outFlag >= 0) writeFileSync(process.argv[outFlag + 1]!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await closeDb();
} else {
  const htmlPath = htmlFlag >= 0 ? process.argv[htmlFlag + 1]! : "";
  const bodyPath = bodyFlag >= 0 ? process.argv[bodyFlag + 1]! : "";
  if (!htmlPath || !bodyPath || outFlag < 0) throw new Error("usage: node scripts/own-chain-aside-v10.ts --html <input.html> --body <evidence-body.txt> --out <report.json>");
  const html = readFileSync(htmlPath, "utf8");
  const expectedBody = readFileSync(bodyPath, "utf8");
  const url = "https://example.org/post";
  const parsed = readable(html, url);
  if (!parsed) throw new Error("普通解析没有得到正文");
  const candidate = { url, title: "Probe" } as Parameters<typeof applyDetail>[0];
  applyDetail(candidate, { title: null, summary: null, publishedAt: null, publicationTime: null, body: parsed, response: null }, "offline");
  await sql`INSERT INTO sources (id, name, kind, participation_mode, next_fetch_at)
    VALUES ('chain-aside-v10', 'Chain aside', 'external', 'isolated', '2100-01-01')
    ON CONFLICT (id) DO NOTHING`;
  const saved = await appendControlledEvidence({
    sourceId: "chain-aside-v10", url, title: "Probe", raw: { kind: "chain-handoff", network: false },
    bodyText: candidate.bodyText, contentAside: candidate.contentAside,
  });
  const scored = await materialForScoring(saved.articleId);
  const bodyOnlyHash = cumulativeEvidenceHash({
    title: "Probe", raw: { kind: "chain-handoff", network: false }, bodyText: candidate.bodyText ?? null, quotedText: null, xPost: null,
  });
  let oldBindingRejected = "";
  try {
    const excerpt = "Read the technical paper";
    await recordFileResult({
      articleId: saved.articleId, evidenceHash: bodyOnlyHash, evidenceVersion: saved.evidenceVersion,
      inputRevision: saved.articleRevision, rulesetVersion: "rules@chain", promptVersion: "prompt@chain",
      executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
      output: {
        narrowClaim: "正文提到技术论文",
        quoteLocation: { excerpt, start: (candidate.bodyText ?? "").indexOf(excerpt), end: (candidate.bodyText ?? "").indexOf(excerpt) + excerpt.length },
        conditions: ["只看这一页"], time: "unknown", valueBasis: "页内写了论文入口", audience: ["复核的人"],
        substantiveAddition: "给出了论文地址", clauses: [{ id: "scope", text: "这一页" }],
      },
    }, "2026-11-18T10:42:00.000Z");
  } catch (error) {
    if (!(error instanceof JudgmentConflict)) throw error;
    oldBindingRejected = error.message;
  }
  const [counts] = await sql<{ publications: number; queued: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications,
           (SELECT count(*)::int FROM articles WHERE processing_state = 'new') AS queued`;
  const report = {
    database,
    network: false,
    bodySameAsHandoff: scored?.bodyText === expectedBody,
    bodyChars: scored?.bodyText?.length ?? 0,
    bodySha256: sha(scored?.bodyText ?? ""),
    handoffBodySha256: sha(expectedBody),
    paperInBody: scored?.bodyText?.includes("paper.pdf") ?? false,
    paperInScoring: scored?.aside.links.some((link) => link.absoluteUrl === "https://example.org/paper.pdf" && link.linkedPageRead === false) ?? false,
    suffixInScoring: scored?.aside.charts.some((chart) => chart.text.includes("value.suffix: %")) ?? false,
    navKept: scored?.aside.links.some((link) => link.absoluteUrl.includes("/nav") || link.absoluteUrl.includes("/privacy")) ?? false,
    oldHash: bodyOnlyHash,
    currentHash: saved.evidenceHash,
    oldBindingRejected,
    publications: counts?.publications ?? null,
    queued: counts?.queued ?? null,
  };
  if (!report.bodySameAsHandoff || !report.paperInScoring || !report.suffixInScoring || report.navKept || !report.oldBindingRejected) {
    writeFileSync(process.argv[outFlag + 1]!, JSON.stringify(report, null, 2));
    throw new Error(`对照没有通过 ${JSON.stringify(report)}`);
  }
  writeFileSync(process.argv[outFlag + 1]!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, ...report }));
  await closeDb();
}
