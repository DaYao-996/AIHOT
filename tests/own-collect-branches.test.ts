// The false premise: an editorial listing with no date that collects a body proves every approved
// RSS does. A pubDate makes detailNeed ignore a missing body, so the detail budget is never spent.
// Isolation is a different role: it is not approved to read the article, and must stay blocked.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { JudgmentConflict, appendLocatedSupplement, materialForScoring, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { asideDocument, asideFromGate } from "@aihot/backend/sources/saved-supplements";
import { collectSource } from "@aihot/backend/sources/collect";
import { publishArticle } from "@aihot/backend/publication/publish";
import { cumulativeEvidenceHash } from "../site/own-pipeline.ts";

const T = tag();
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
  const when = dated ? "<pubDate>Wed, 18 Nov 2026 03:00:00 GMT</pubDate>" : "";
  return `<item><title>${title}</title><link>${base}${path}</link>${when}</item>`;
}
function feed(path: string) {
  const items = path.endsWith("/ed")
    ? item("Probe", "/probe", true) + item("Other", "/other", false)
    : item("Isolated", "/iso-probe", true);
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
}

const editorial = `branch-ed-${T}`;
const isolated = `branch-iso-${T}`;
await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, next_fetch_at) VALUES
  (${editorial}, 'editorial', 'rss', 'editorial', ${sql.json({ feedUrl: `${base}/feed/ed`, detail: { maxFetches: 2 } })}, false, '2100-01-01'),
  (${isolated}, 'isolated', 'rss', 'isolated', ${sql.json({ feedUrl: `${base}/feed/iso`, detail: { maxFetches: 2 } })}, false, '2100-01-01')`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("a dated approved RSS is not covered by the undated path, and isolation stays blocked", async () => {
  const dated = await collectSource(editorial, { force: true });
  const blocked = await collectSource(isolated, { force: true });
  assert.equal(dated.status, "ok");
  assert.equal(blocked.status, "ok");
  assert.ok(reads.includes("/other"), "the undated editorial item still opens its page");
  assert.ok(reads.includes("/probe"), "an approved source with its own pubDate still spends the detail budget on the missing body");
  assert.equal(reads.includes("/iso-probe"), false, "isolation is not approved to read the article, even with the same budget");
  const [mode] = await sql<{ participation_mode: string }[]>`SELECT participation_mode FROM sources WHERE id = ${isolated}`;
  assert.equal(mode!.participation_mode, "isolated");
  const rows = await sql<{ url: string; body_status: string; evidence: number }[]>`
    SELECT a.url, a.body_status, (SELECT count(*)::int FROM own_evidence_versions v WHERE v.article_id = a.id) AS evidence
    FROM articles a WHERE a.source_id IN (${editorial}, ${isolated})`;
  const byPath = new Map(rows.map((row) => [new URL(row.url).pathname, row]));
  assert.equal(byPath.get("/probe")?.body_status, "ok");
  assert.equal(byPath.get("/probe")?.evidence, 1);
  assert.equal(byPath.get("/other")?.body_status, "ok");
  assert.equal(byPath.get("/other")?.evidence, 1);
  assert.equal(byPath.get("/iso-probe")?.body_status, "pending");
  assert.equal(byPath.get("/iso-probe")?.evidence, 0);

  const [probe] = await sql<{ id: string; title: string; raw: unknown; body_text: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, a.title, v.raw, a.body_text, v.evidence_hash, v.version, a.revision, v.body_gate AS gate
    FROM articles a JOIN LATERAL (
      SELECT raw, evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.url = ${`${base}/probe`}`;
  const doc = asideDocument(asideFromGate(probe!.gate));
  const paperAt = doc.indexOf(PAPER);
  const unitAt = doc.indexOf(SUFFIX);
  assert.ok(paperAt >= 0 && unitAt >= 0);
  const cite = (excerpt: string, start: number) => ({ excerpt, start, end: start + excerpt.length });
  const file = await recordFileResult({
    articleId: probe!.id, evidenceHash: probe!.evidence_hash, evidenceVersion: Number(probe!.version), inputRevision: Number(probe!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@paper", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "补充里有论文地址", quoteLocation: cite(PAPER, paperAt), conditions: ["已入库"], time: "unknown",
      valueBasis: "地址在补充", audience: ["复核的人"], substantiveAddition: "正文没有这个地址", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T12:00:00.000Z");
  await recordFileResult({
    articleId: probe!.id, evidenceHash: probe!.evidence_hash, evidenceVersion: Number(probe!.version), inputRevision: Number(probe!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@unit", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "补充里有单位", quoteLocation: cite(SUFFIX, unitAt), conditions: ["已入库"], time: "unknown",
      valueBasis: "单位在补充", audience: ["复核的人"], substantiveAddition: "正文没有单位行", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T12:00:01.000Z", { write: false });
  await assert.rejects(recordFileResult({
    articleId: probe!.id, evidenceHash: probe!.evidence_hash, evidenceVersion: Number(probe!.version), inputRevision: Number(probe!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@missing", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "没有的地址", quoteLocation: { excerpt: "https://example.org/missing.pdf", start: 0, end: 32 }, conditions: ["无"], time: "unknown",
      valueBasis: "无", audience: ["无"], substantiveAddition: "无", clauses: [{ id: "scope", text: "无" }],
    },
  }, "2026-11-18T12:00:02.000Z", { write: false }), /引文不在当前正文或引用里/);

  const again = await recordFileResult({
    articleId: probe!.id, evidenceHash: probe!.evidence_hash, evidenceVersion: Number(probe!.version), inputRevision: Number(probe!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@paper", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "补充里有论文地址", quoteLocation: cite(PAPER, paperAt), conditions: ["已入库"], time: "unknown",
      valueBasis: "地址在补充", audience: ["复核的人"], substantiveAddition: "正文没有这个地址", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T12:00:00.000Z");
  assert.equal(again.idempotent, true);
  assert.equal(again.id, file.id);

  const [other] = await sql<{ id: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, v.evidence_hash, v.version, a.revision, v.body_gate AS gate FROM articles a
    JOIN LATERAL (SELECT evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url = ${`${base}/other`}`;
  const otherDoc = asideDocument(asideFromGate(other!.gate));
  const otherAt = otherDoc.indexOf("https://example.org/other.pdf");
  await recordFileResult({
    articleId: other!.id, evidenceHash: other!.evidence_hash, evidenceVersion: Number(other!.version), inputRevision: Number(other!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@other", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "另一篇", quoteLocation: { excerpt: "https://example.org/other.pdf", start: otherAt, end: otherAt + "https://example.org/other.pdf".length },
      conditions: ["另一篇"], time: "unknown", valueBasis: "另一篇", audience: ["复核的人"], substantiveAddition: "另一篇", clauses: [{ id: "scope", text: "另一篇" }],
    },
  }, "2026-11-18T12:00:03.000Z");
  await recordSelectionDecision({
    articleId: other!.id, evidenceHash: other!.evidence_hash, evidenceVersion: Number(other!.version), inputRevision: Number(other!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@select", decision_rationale: "另一篇的选择理由。", conditions: ["另一篇"],
  }, "2026-11-18T12:00:04.000Z");
  const draft = await recordReviewDraft({
    articleId: other!.id, evidenceHash: other!.evidence_hash, evidenceVersion: Number(other!.version), inputRevision: Number(other!.revision),
    rulesetVersion: "rules@branches", promptVersion: "prompt@draft", text: "另一篇仍待审。", sourceNote: "另一篇",
    sourceCitations: ["https://example.org/other.pdf"], conditions: ["另一篇"], technicalFixture: false, requiresHumanReview: true,
  }, "2026-11-18T12:00:05.000Z");

  const held = await processArticle(probe!.id);
  assert.equal(held.state, "held");
  const [receipts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE subject = ${`article:${probe!.id}`}`;
  assert.equal(receipts!.n, 0, "the analyze consumer must not buy a model call");
  const published = await publishArticle(probe!.id);
  assert.equal(published, null);
  const [publicRows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id = ${probe!.id} AND visibility = 'public'`;
  assert.equal(publicRows!.n, 0);
  const [jobs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pgboss.job
    WHERE state IN ('created', 'retry') AND data->>'articleId' = ${probe!.id}
      AND name IN ('content.analyze', 'content.extract-body', 'events.group', 'notify.selected')`;
  assert.equal(jobs!.n, 0);
  const [parked] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${probe!.id}`;
  assert.equal(parked!.processing_state, "skipped");

  const added = await appendLocatedSupplement(probe!.id, {
    kind: "content-links", sourceUrl: `${base}/probe`, httpStatus: 200, responseSha256: "local",
    parts: [{ id: "extra", role: "content_link", byteStart: 0, byteEnd: 0, text: "label: extra\nabsoluteUrl: https://example.org/extra.pdf\nlinkedPageRead: false" }],
  });
  const scored = await materialForScoring(probe!.id);
  const [afterRow] = await sql<{ title: string; raw: unknown; body_text: string; quoted_text: string | null; x_post: unknown; evidence_hash: string; gate: unknown }[]>`
    SELECT a.title, v.raw, v.body_text, v.quoted_text, v.x_post, v.evidence_hash, v.body_gate AS gate
    FROM articles a JOIN LATERAL (
      SELECT raw, body_text, quoted_text, x_post, evidence_hash, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.id = ${probe!.id}`;
  const shown = asideFromGate(afterRow!.gate);
  const recomputed = cumulativeEvidenceHash({
    title: afterRow!.title, raw: afterRow!.raw, bodyText: afterRow!.body_text, quotedText: afterRow!.quoted_text, xPost: afterRow!.x_post as never, aside: shown,
  });
  assert.equal(recomputed, afterRow!.evidence_hash);
  assert.equal(scored?.evidenceHash, recomputed);
  assert.equal(added.evidenceHash, recomputed);
  assert.equal(shown.links.find((link) => link.absoluteUrl === PAPER)?.byteStart, html.indexOf(PAPER));
  const [probeStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${file.id}`;
  const [draftStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${draft.id}`;
  assert.equal(probeStale!.stale, true);
  assert.equal(draftStale!.stale, false);
});
