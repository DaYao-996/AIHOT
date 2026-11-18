// Dated and undated editorial RSS, plus an isolated source, through collectSource only.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { JudgmentConflict, appendLocatedSupplement, materialForScoring, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { asideDocument, asideFromGate } from "@aihot/backend/sources/saved-supplements";
import { collectSource } from "@aihot/backend/sources/collect";
import { publishArticle } from "@aihot/backend/publication/publish";
import { assertThrowawayDatabase, cumulativeEvidenceHash } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_v6_test", "own_public_sample_v9_test", "own_public_sample_v9_change_test",
  "own_chain_aside_v10_test", "own_chain_store_v11_test", "own_chain_bind_v12_test",
]);
const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unset").pathname.replace(/^\//, "");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (FROZEN.has(database)) throw new Error("这是已冻结的库");
const outDir = process.argv.includes("--out-dir") ? process.argv[process.argv.indexOf("--out-dir") + 1]! : "docs/own-pipeline/collect-branches-v13";
mkdirSync(outDir, { recursive: true });
const html = readFileSync("docs/own-pipeline/chain-aside-v10/input.html");
const PAPER = "https://example.org/paper.pdf";
const SUFFIX = "value.suffix: %";
const otherHtml = `<!doctype html><html><body><article><p>${"Another page stays aside. ".repeat(12)}</p><p>See the <a href="https://example.org/other.pdf">other paper</a>.</p></article></body></html>`;
const reads: string[] = [];
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  reads.push(path);
  const body = path.startsWith("/feed") ? feed(path) : path === "/probe" || path === "/iso-probe" ? html : path === "/other" ? otherHtml : null;
  res.writeHead(body === null ? 404 : 200, { "content-type": path.startsWith("/feed") ? "application/rss+xml" : "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
function item(title: string, path: string, dated: boolean) {
  return `<item><title>${title}</title><link>${base}${path}</link>${dated ? "<pubDate>Wed, 18 Nov 2026 03:00:00 GMT</pubDate>" : ""}</item>`;
}
function feed(path: string) {
  const items = path.endsWith("/ed") ? item("Probe", "/probe", true) + item("Other", "/other", false) : item("Isolated", "/iso-probe", true);
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
}
function dump(name: string) {
  const file = `${outDir}/${name}.dump`;
  execFileSync("pg_dump", ["-Fc", "--no-owner", "-f", file, process.env.DATABASE_URL!], { stdio: "inherit" });
  return file;
}
function fail(message: string): never { throw new Error(message); }

try {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, next_fetch_at) VALUES
    ('v13-ed', 'editorial', 'rss', 'editorial', ${sql.json({ feedUrl: `${base}/feed/ed`, detail: { maxFetches: 2 } })}, false, '2100-01-01'),
    ('v13-iso', 'isolated', 'rss', 'isolated', ${sql.json({ feedUrl: `${base}/feed/iso`, detail: { maxFetches: 2 } })}, false, '2100-01-01')`;
  const editorial = await collectSource("v13-ed", { force: true });
  const isolated = await collectSource("v13-iso", { force: true });
  const replay = await collectSource("v13-ed", { force: true });
  if (!reads.includes("/probe") || !reads.includes("/other")) fail("已批准的编辑源没有把详情预算用在缺正文的条目上");
  if (reads.includes("/iso-probe")) fail("隔离源被放行去读正文");
  if (replay.created !== 0 || replay.revised !== 0) fail("再次采集不是幂等");
  const [mode] = await sql<{ participation_mode: string }[]>`SELECT participation_mode FROM sources WHERE id = 'v13-iso'`;
  if (mode!.participation_mode !== "isolated") fail("隔离源被改成了编辑源");
  dump("after-collect");
  const [probe] = await sql<{ id: string; title: string; raw: unknown; body_text: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, a.title, v.raw, a.body_text, v.evidence_hash, v.version, a.revision, v.body_gate AS gate
    FROM articles a JOIN LATERAL (
      SELECT raw, evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.url = ${`${base}/probe`}`;
  if (!probe) fail("有日期的编辑条目没有证据");
  const doc = asideDocument(asideFromGate(probe.gate));
  const paperAt = doc.indexOf(PAPER);
  const unitAt = doc.indexOf(SUFFIX);
  if (paperAt < 0 || unitAt < 0) fail("旁路里没有论文地址或单位");
  const cite = (excerpt: string, start: number) => ({ excerpt, start, end: start + excerpt.length });
  const output = {
    narrowClaim: "补充里有论文地址", quoteLocation: cite(PAPER, paperAt), conditions: ["已入库"], time: "unknown",
    valueBasis: "地址在补充", audience: ["复核的人"], substantiveAddition: "正文没有这个地址", clauses: [{ id: "scope", text: "当前补充" }],
  };
  const file = await recordFileResult({
    articleId: probe.id, evidenceHash: probe.evidence_hash, evidenceVersion: Number(probe.version), inputRevision: Number(probe.revision),
    rulesetVersion: "rules@branches-v13", promptVersion: "prompt@paper", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output,
  }, "2026-11-18T12:10:00.000Z");
  if ((await recordFileResult({
    articleId: probe.id, evidenceHash: probe.evidence_hash, evidenceVersion: Number(probe.version), inputRevision: Number(probe.revision),
    rulesetVersion: "rules@branches-v13", promptVersion: "prompt@paper", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null, output,
  }, "2026-11-18T12:10:00.000Z")).idempotent !== true) fail("同一文件结果再写不是幂等");
  await recordFileResult({
    articleId: probe.id, evidenceHash: probe.evidence_hash, evidenceVersion: Number(probe.version), inputRevision: Number(probe.revision),
    rulesetVersion: "rules@branches-v13", promptVersion: "prompt@unit", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: { ...output, narrowClaim: "补充里有单位", quoteLocation: cite(SUFFIX, unitAt), valueBasis: "单位在补充", substantiveAddition: "正文没有单位行" },
  }, "2026-11-18T12:10:01.000Z", { write: false });
  let missing = "";
  try {
    await recordFileResult({
      articleId: probe.id, evidenceHash: probe.evidence_hash, evidenceVersion: Number(probe.version), inputRevision: Number(probe.revision),
      rulesetVersion: "rules@branches-v13", promptVersion: "prompt@missing", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
      output: { ...output, narrowClaim: "没有", quoteLocation: { excerpt: "https://example.org/missing.pdf", start: 0, end: 32 } },
    }, "2026-11-18T12:10:02.000Z", { write: false });
  } catch (error) {
    if (!(error instanceof JudgmentConflict)) throw error;
    missing = error.message;
  }
  if (missing !== "引文不在当前正文或引用里") fail("伪引文没有被拒绝");
  const [other] = await sql<{ id: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, v.evidence_hash, v.version, a.revision, v.body_gate AS gate FROM articles a
    JOIN LATERAL (SELECT evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url = ${`${base}/other`}`;
  const otherDoc = asideDocument(asideFromGate(other!.gate));
  const otherAt = otherDoc.indexOf("https://example.org/other.pdf");
  await recordFileResult({
    articleId: other!.id, evidenceHash: other!.evidence_hash, evidenceVersion: Number(other!.version), inputRevision: Number(other!.revision),
    rulesetVersion: "rules@branches-v13", promptVersion: "prompt@other", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: { ...output, narrowClaim: "另一篇", quoteLocation: { excerpt: "https://example.org/other.pdf", start: otherAt, end: otherAt + "https://example.org/other.pdf".length }, conditions: ["另一篇"], valueBasis: "另一篇", substantiveAddition: "另一篇" },
  }, "2026-11-18T12:10:03.000Z");
  await recordSelectionDecision({
    articleId: other!.id, evidenceHash: other!.evidence_hash, evidenceVersion: Number(other!.version), inputRevision: Number(other!.revision),
    rulesetVersion: "rules@branches-v13", promptVersion: "prompt@select", decision_rationale: "另一篇的选择理由。", conditions: ["另一篇"],
  }, "2026-11-18T12:10:04.000Z");
  const draft = await recordReviewDraft({
    articleId: other!.id, evidenceHash: other!.evidence_hash, evidenceVersion: Number(other!.version), inputRevision: Number(other!.revision),
    rulesetVersion: "rules@branches-v13", promptVersion: "prompt@draft", text: "另一篇仍待审。", sourceNote: "另一篇",
    sourceCitations: ["https://example.org/other.pdf"], conditions: ["另一篇"], technicalFixture: false, requiresHumanReview: true,
  }, "2026-11-18T12:10:05.000Z");
  dump("after-judgments");
  const held = await processArticle(probe.id);
  if (held.state !== "held") fail("未许可的文章仍进入了分析");
  const published = await publishArticle(probe.id);
  if (published !== null) fail("未许可的文章被发布");
  const [counts] = await sql<{ publicPublications: number; receipts: number; deliveries: number; jobs: number }[]>`
    SELECT (SELECT count(*)::int FROM publications WHERE visibility = 'public') AS "publicPublications",
           (SELECT count(*)::int FROM receipts) AS receipts,
           (SELECT count(*)::int FROM deliveries) AS deliveries,
           (SELECT count(*)::int FROM pgboss.job WHERE state IN ('created', 'retry') AND data->>'articleId' = ${probe.id}
              AND name IN ('content.analyze', 'content.extract-body', 'events.group', 'notify.selected')) AS jobs`;
  if (counts!.publicPublications !== 0 || counts!.receipts !== 0 || counts!.deliveries !== 0 || counts!.jobs !== 0) fail("未许可材料仍有公开、回执、发送或待跑作业");
  const added = await appendLocatedSupplement(probe.id, {
    kind: "content-links", sourceUrl: `${base}/probe`, httpStatus: 200, responseSha256: "local",
    parts: [{ id: "extra", role: "content_link", byteStart: 0, byteEnd: 0, text: "label: extra\nabsoluteUrl: https://example.org/extra.pdf\nlinkedPageRead: false" }],
  });
  const scored = await materialForScoring(probe.id);
  const [afterRow] = await sql<{ title: string; raw: unknown; body_text: string; quoted_text: string | null; x_post: unknown; evidence_hash: string; gate: unknown }[]>`
    SELECT a.title, v.raw, v.body_text, v.quoted_text, v.x_post, v.evidence_hash, v.body_gate AS gate
    FROM articles a JOIN LATERAL (
      SELECT raw, body_text, quoted_text, x_post, evidence_hash, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.id = ${probe.id}`;
  const shown = asideFromGate(afterRow!.gate);
  const recomputed = cumulativeEvidenceHash({
    title: afterRow!.title, raw: afterRow!.raw, bodyText: afterRow!.body_text, quotedText: afterRow!.quoted_text, xPost: afterRow!.x_post as never, aside: shown,
  });
  if (recomputed !== afterRow!.evidence_hash || scored?.evidenceHash !== recomputed) fail("补料后的哈希没有盖住显示的旁路");
  if (shown.links.find((link) => link.absoluteUrl === PAPER)?.byteStart !== html.indexOf(PAPER)) fail("论文位置不是原页字节");
  const [probeStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${file.id}`;
  const [draftStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${draft.id}`;
  if (!probeStale?.stale || draftStale?.stale) fail("失效范围不是只这一篇");
  dump("after-supplement");
  const [iso] = await sql<{ body_status: string; evidence: number }[]>`
    SELECT a.body_status, (SELECT count(*)::int FROM own_evidence_versions v WHERE v.article_id = a.id) AS evidence
    FROM articles a WHERE a.source_id = 'v13-iso'`;
  const report = {
    database, entry: "collectSource", calledApplyDetail: false, calledStoreCollected: false,
    isolated: { chain: "blocked", participationMode: "isolated", bodyStatus: iso?.body_status ?? null, evidence: iso?.evidence ?? null, pageRequested: reads.includes("/iso-probe") },
    editorial: { datedPage: reads.includes("/probe"), undatedPage: reads.includes("/other"), replayCreated: replay.created, replayRevised: replay.revised },
    paperByteStart: shown.links.find((link) => link.absoluteUrl === PAPER)?.byteStart ?? null,
    missingRejected: missing, hashCoversDisplayedAside: true, afterSupplementHash: added.evidenceHash,
    probeJudgmentStale: true, otherDraftStale: false,
    consumer: { processArticle: held.state, publishArticle: published, publicPublications: counts!.publicPublications, receipts: counts!.receipts, deliveries: counts!.deliveries, releaseJobs: counts!.jobs },
    requests: reads,
  };
  writeFileSync(`${outDir}/REPORT.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, isolated: report.isolated.chain, replayCreated: replay.created, consumer: report.consumer.processArticle }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
}
