// Own-review material stays out of analysis and public pages after the judgment goes stale.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { closeDb, sql } from "@aihot/backend/db";
import { processArticle } from "@aihot/backend/jobs/content";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { appendLocatedSupplement, recordFileResult } from "@aihot/backend/own-pipeline-store";
import { asideDocument, asideFromGate } from "@aihot/backend/sources/saved-supplements";
import { collectSource } from "@aihot/backend/sources/collect";
import { publishArticle } from "@aihot/backend/publication/publish";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_v6_test", "own_public_sample_v9_test", "own_public_sample_v9_change_test",
  "own_chain_aside_v10_test", "own_chain_store_v11_test", "own_chain_bind_v12_test",
  "own_collect_branches_v13_test", "own_contract_run_v13_test",
]);
const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unset").pathname.replace(/^\//, "");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (FROZEN.has(database)) throw new Error("这是已冻结的库");
const outDir = process.argv.includes("--out-dir") ? process.argv[process.argv.indexOf("--out-dir") + 1]! : "docs/own-pipeline/review-hold-v14";
mkdirSync(outDir, { recursive: true });
const html = readFileSync("docs/own-pipeline/chain-aside-v10/input.html");
const PAPER = "https://example.org/paper.pdf";
const otherHtml = `<!doctype html><html><body><article><p>${"Another page stays aside. ".repeat(12)}</p><p>See the <a href="https://example.org/other.pdf">other paper</a>.</p></article></body></html>`;
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  const body = path.endsWith("/ed") ? feed(true) : path.endsWith("/iso") ? feed(false) : path === "/probe" ? html : path === "/other" ? otherHtml : path === "/iso-probe" ? html : null;
  res.writeHead(body === null ? 404 : 200, { "content-type": path.startsWith("/feed") ? "application/rss+xml" : "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
function feed(editorial: boolean) {
  const items = editorial
    ? `<item><title>Probe</title><link>${base}/probe</link><pubDate>Wed, 18 Nov 2026 03:00:00 GMT</pubDate></item><item><title>Other</title><link>${base}/other</link></item>`
    : `<item><title>Isolated</title><link>${base}/iso-probe</link><pubDate>Wed, 18 Nov 2026 03:00:00 GMT</pubDate></item>`;
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
}
function dump(name: string) {
  execFileSync("pg_dump", ["-Fc", "--no-owner", "-f", `${outDir}/${name}.dump`, process.env.DATABASE_URL!], { stdio: "inherit" });
}
function fail(message: string): never { throw new Error(message); }
async function cite(articleUrl: string, excerpt: string) {
  const [row] = await sql<{ id: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, v.evidence_hash, v.version, a.revision, v.body_gate AS gate FROM articles a
    JOIN LATERAL (SELECT evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url = ${articleUrl}`;
  const start = asideDocument(asideFromGate(row!.gate)).indexOf(excerpt);
  if (start < 0) fail(`补充里没有 ${excerpt}`);
  await recordFileResult({
    articleId: row!.id, evidenceHash: row!.evidence_hash, evidenceVersion: Number(row!.version), inputRevision: Number(row!.revision),
    rulesetVersion: "rules@hold-v14", promptVersion: `prompt@${excerpt.slice(0, 16)}`, executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: excerpt, quoteLocation: { excerpt, start, end: start + excerpt.length }, conditions: ["已入库"], time: "unknown",
      valueBasis: "补充", audience: ["复核的人"], substantiveAddition: "正文没有", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T12:30:00.000Z");
  return row!.id;
}
async function guard(articleId: string) {
  const processed = await processArticle(articleId);
  const published = await publishArticle(articleId);
  const [counts] = await sql<{ publicRows: number; anyRows: number; receipts: number; analyses: number; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${articleId} AND visibility = 'public') AS "publicRows",
           (SELECT count(*)::int FROM publications WHERE article_id = ${articleId}) AS "anyRows",
           (SELECT count(*)::int FROM receipts WHERE subject = ${`article:${articleId}`}) AS receipts,
           (SELECT count(*)::int FROM analyses WHERE article_id = ${articleId}) AS analyses,
           (SELECT count(*)::int FROM deliveries WHERE subject_id = ${articleId}) AS deliveries`;
  if (processed.state !== "held" || published !== null || counts!.publicRows !== 0 || counts!.anyRows !== 0 || counts!.receipts !== 0 || counts!.analyses !== 0 || counts!.deliveries !== 0) {
    fail(`守卫没有拦住 ${articleId} ${JSON.stringify({ processed, published, counts })}`);
  }
  return { process: processed.state, publish: published, ...counts };
}

try {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, next_fetch_at) VALUES
    ('hold-v14-ed', 'editorial', 'rss', 'editorial', ${sql.json({ feedUrl: `${base}/feed/ed`, detail: { maxFetches: 2 } })}, false, '2100-01-01'),
    ('hold-v14-iso', 'isolated', 'rss', 'isolated', ${sql.json({ feedUrl: `${base}/feed/iso`, detail: { maxFetches: 2 } })}, false, '2100-01-01')`;
  if ((await collectSource("hold-v14-ed", { force: true })).status !== "ok") fail("编辑采集失败");
  if ((await collectSource("hold-v14-iso", { force: true })).status !== "ok") fail("隔离采集失败");
  await enqueue(QUEUES.analyze, { articleId: "unrelated-hold-article" });
  const probe = await cite(`${base}/probe`, PAPER);
  const other = await cite(`${base}/other`, "https://example.org/other.pdf");
  const live = await guard(probe);
  dump("after-live-hold");
  const [beforeBody] = await sql<{ body_text: string; revision: number }[]>`SELECT body_text, revision FROM articles WHERE id = ${other}`;
  await upsertMaterial({ sourceId: "hold-v14-ed", url: `${base}/other`, title: "Other", bodyText: `${beforeBody!.body_text} 正文又写了一句。`, bodyStatus: "ok", via: "fetch" });
  const bodyRevised = await guard(other);
  dump("after-body-revision");
  await appendLocatedSupplement(probe, {
    kind: "content-links", sourceUrl: `${base}/probe`, httpStatus: 200, responseSha256: "local",
    parts: [{ id: "extra", role: "content_link", byteStart: 0, byteEnd: 0, text: "label: extra\nabsoluteUrl: https://example.org/extra.pdf\nlinkedPageRead: false" }],
  });
  const afterStale = await guard(probe);
  dump("after-supplement");
  if ((await collectSource("hold-v14-ed", { force: true })).status !== "ok") fail("重采失败");
  const afterRecollect = await guard(probe);
  dump("after-recollect");
  const [jobs] = await sql<{ unrelated: number; isolated: number; probeRelease: number }[]>`
    SELECT count(*) FILTER (WHERE data->>'articleId' = 'unrelated-hold-article')::int AS unrelated,
           count(*) FILTER (WHERE name = 'events.group' AND data->>'articleId' IN (SELECT id FROM articles WHERE source_id = 'hold-v14-iso'))::int AS isolated,
           count(*) FILTER (WHERE data->>'articleId' = ${probe} AND name IN ('content.analyze', 'content.extract-body', 'events.group', 'notify.selected') AND state IN ('created', 'retry'))::int AS "probeRelease"
    FROM pgboss.job`;
  if (jobs!.unrelated !== 1 || jobs!.isolated !== 1 || jobs!.probeRelease !== 0) fail(`作业范围不对 ${JSON.stringify(jobs)}`);
  const report = { database, live, bodyRevised, afterStale, afterRecollect, jobs, publicationsPublic: 0 };
  writeFileSync(`${outDir}/REPORT.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, ...report }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
}
