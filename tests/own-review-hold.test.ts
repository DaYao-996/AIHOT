// The false premise: once an own-review judgment is stale, the article may re-enter
// automatic analysis, and a publication row is acceptable when its visibility is public
// but eligible is false. Stale, a newer body, and a re-collect are still the same
// unapproved article.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { processArticle } from "@aihot/backend/jobs/content";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { appendLocatedSupplement, recordFileResult } from "@aihot/backend/own-pipeline-store";
import { asideDocument, asideFromGate } from "@aihot/backend/sources/saved-supplements";
import { collectSource } from "@aihot/backend/sources/collect";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
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
const editorial = `hold-ed-${T}`;
const isolated = `hold-iso-${T}`;
await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, next_fetch_at) VALUES
  (${editorial}, 'editorial', 'rss', 'editorial', ${sql.json({ feedUrl: `${base}/feed/ed`, detail: { maxFetches: 2 } })}, false, '2100-01-01'),
  (${isolated}, 'isolated', 'rss', 'isolated', ${sql.json({ feedUrl: `${base}/feed/iso`, detail: { maxFetches: 2 } })}, false, '2100-01-01')`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

async function cite(articleUrl: string, excerpt: string) {
  const [row] = await sql<{ id: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, v.evidence_hash, v.version, a.revision, v.body_gate AS gate FROM articles a
    JOIN LATERAL (SELECT evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url = ${articleUrl}`;
  const doc = asideDocument(asideFromGate(row!.gate));
  const start = doc.indexOf(excerpt);
  assert.ok(start >= 0, excerpt);
  await recordFileResult({
    articleId: row!.id, evidenceHash: row!.evidence_hash, evidenceVersion: Number(row!.version), inputRevision: Number(row!.revision),
    rulesetVersion: "rules@hold", promptVersion: `prompt@${excerpt.slice(0, 12)}`, executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: excerpt, quoteLocation: { excerpt, start, end: start + excerpt.length }, conditions: ["已入库"], time: "unknown",
      valueBasis: "补充", audience: ["复核的人"], substantiveAddition: "正文没有", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T12:20:00.000Z");
  return row!.id;
}

async function blocked(articleId: string) {
  const processed = await processArticle(articleId);
  const published = await publishArticle(articleId);
  const [counts] = await sql<{ publicRows: number; receipts: number; analyses: number; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${articleId} AND visibility = 'public') AS "publicRows",
           (SELECT count(*)::int FROM receipts WHERE subject = ${`article:${articleId}`}) AS receipts,
           (SELECT count(*)::int FROM analyses WHERE article_id = ${articleId}) AS analyses,
           (SELECT count(*)::int FROM deliveries WHERE subject_id = ${articleId}) AS deliveries`;
  assert.equal(processed.state, "held");
  assert.equal(published, null);
  assert.equal(counts!.publicRows, 0);
  assert.equal(counts!.receipts, 0);
  assert.equal(counts!.analyses, 0);
  assert.equal(counts!.deliveries, 0);
}

test("a stale or revised own-review article does not re-enter analysis or a public page", async () => {
  assert.equal((await collectSource(editorial, { force: true })).status, "ok");
  assert.equal((await collectSource(isolated, { force: true })).status, "ok");
  await enqueue(QUEUES.analyze, { articleId: "unrelated-hold-article" });
  const probe = await cite(`${base}/probe`, PAPER);
  const other = await cite(`${base}/other`, "https://example.org/other.pdf");
  await blocked(probe);

  const [beforeBody] = await sql<{ body_text: string; revision: number }[]>`SELECT body_text, revision FROM articles WHERE id = ${other}`;
  await upsertMaterial({ sourceId: editorial, url: `${base}/other`, title: "Other", bodyText: `${beforeBody!.body_text} 正文又写了一句。`, bodyStatus: "ok", via: "fetch" });
  const [revised] = await sql<{ revision: number; live: number }[]>`
    SELECT a.revision, (SELECT count(*)::int FROM own_judgments j WHERE j.article_id = a.id AND j.stale = false AND j.input_revision = a.revision) AS live
    FROM articles a WHERE a.id = ${other}`;
  assert.ok(revised!.revision > beforeBody!.revision);
  assert.equal(revised!.live, 0, "the body revision has no current judgment");
  await blocked(other);

  await appendLocatedSupplement(probe, {
    kind: "content-links", sourceUrl: `${base}/probe`, httpStatus: 200, responseSha256: "local",
    parts: [{ id: "extra", role: "content_link", byteStart: 0, byteEnd: 0, text: "label: extra\nabsoluteUrl: https://example.org/extra.pdf\nlinkedPageRead: false" }],
  });
  const [stale] = await sql<{ live: number; stale: number }[]>`
    SELECT count(*) FILTER (WHERE stale = false)::int AS live, count(*) FILTER (WHERE stale)::int AS stale
    FROM own_judgments WHERE article_id = ${probe}`;
  assert.equal(stale!.live, 0);
  assert.ok(stale!.stale >= 1);
  await blocked(probe);

  assert.equal((await collectSource(editorial, { force: true })).status, "ok");
  await blocked(probe);
  const [jobs] = await sql<{ unrelated: number; isolated: number; probeRelease: number }[]>`
    SELECT count(*) FILTER (WHERE data->>'articleId' = 'unrelated-hold-article')::int AS unrelated,
           count(*) FILTER (WHERE name = 'events.group' AND data->>'articleId' IN (SELECT id FROM articles WHERE source_id = ${isolated}))::int AS isolated,
           count(*) FILTER (WHERE data->>'articleId' = ${probe} AND name IN ('content.analyze', 'content.extract-body', 'events.group', 'notify.selected') AND state IN ('created', 'retry'))::int AS "probeRelease"
    FROM pgboss.job`;
  assert.equal(jobs!.unrelated, 1);
  assert.equal(jobs!.isolated, 1);
  assert.equal(jobs!.probeRelease, 0);
});
