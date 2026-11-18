// Collect store writes the parsed aside, and later supplements stay inside the evidence hash.
import { readFileSync, writeFileSync } from "node:fs";
import { readable } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { JudgmentConflict, appendLocatedSupplement, materialForScoring, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { applyDetail, storeCollected, type CollectionCandidate } from "@aihot/backend/sources/collect";
import { asideDocument, asideFromGate } from "@aihot/backend/sources/saved-supplements";
import { assertThrowawayDatabase, cumulativeEvidenceHash } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_v6_test", "own_public_sample_v9_test", "own_public_sample_v9_change_test",
  "own_chain_aside_v10_test", "own_chain_store_v11_test",
]);
const SOURCE = "chain-bind-v12";
const PAGE = "https://example.org/post";
const OTHER = "https://example.org/other";
const PAPER = "https://example.org/paper.pdf";
const SUFFIX = "value.suffix: %";

function fail(message: string): never { throw new Error(message); }

function candidateFrom(html: string, url: string, title: string): CollectionCandidate {
  const parsed = readable(html, url);
  if (!parsed) fail(`没有正文 ${url}`);
  const candidate = { url, title, raw: { kind: "offline-html" } } as CollectionCandidate;
  applyDetail(candidate, { title, summary: null, publishedAt: null, publicationTime: null, body: parsed, response: null }, "offline");
  return candidate;
}

const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unset").pathname.replace(/^\//, "");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (FROZEN.has(database)) fail("这是已冻结的库");
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : "docs/own-pipeline/chain-bind-v12/REPORT.json";

try {
  const html = readFileSync("docs/own-pipeline/chain-aside-v10/input.html", "utf8");
  const expectedBody = readFileSync("docs/own-pipeline/chain-aside-v10/evidence-v1-body.txt", "utf8");
  await sql`INSERT INTO sources (id, name, kind, participation_mode, config, next_fetch_at)
    VALUES (${SOURCE}, 'Chain bind', 'web_list', 'isolated', ${sql.json({ detail: { maxFetches: 1 } })}, '2100-01-01')
    ON CONFLICT (id) DO NOTHING`;
  const parsed = candidateFrom(html, PAGE, "Probe");
  await upsertMaterial({ sourceId: SOURCE, url: "https://example.org/upsert-only", title: "只写文章", bodyText: parsed.bodyText, bodyHtml: parsed.bodyHtml, bodyStatus: "ok", via: "fetch", raw: { kind: "upsert-only" } });
  const [upsertOnly] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_evidence_versions v JOIN articles a ON a.id = v.article_id WHERE a.url = 'https://example.org/upsert-only'`;
  if (upsertOnly!.n !== 0) fail("upsertMaterial 不该自己写证据");

  await storeCollected(SOURCE, "web_list", [parsed], null);
  const [row] = await sql<{ id: string; title: string; body_text: string; raw: unknown; version: number; evidence_hash: string; revision: number; gate: unknown; evidence_body: string }[]>`
    SELECT a.id, a.title, a.body_text, v.raw, v.version, v.evidence_hash, a.revision, v.body_gate AS gate, v.body_text AS evidence_body
    FROM articles a JOIN LATERAL (
      SELECT raw, version, evidence_hash, body_gate, body_text FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.url = ${PAGE}`;
  if (!row || row.body_text !== expectedBody || row.evidence_body !== expectedBody) fail("入库正文变了");
  const aside = asideFromGate(row.gate);
  const doc = asideDocument(aside);
  const covered = cumulativeEvidenceHash({ title: row.title, raw: row.raw, bodyText: row.evidence_body, quotedText: null, xPost: null, aside });
  if (covered !== row.evidence_hash) fail("当前哈希没有盖住正在显示的旁路");
  const scored = await materialForScoring(row.id);
  if (!scored?.asideBound || !scored.aside.links.some((link) => link.absoluteUrl === PAPER && link.byteStart === html.indexOf(PAPER) && link.linkedPageRead === false)) fail("评分旁路不是原页位置");
  if (!scored.aside.charts.some((chart) => chart.text.includes(SUFFIX))) fail("评分没有单位");
  const editor = await loadAnalyzeInput(row.id);
  const edited = editor?.aside?.links.find((link) => link.absoluteUrl === PAPER);
  if (!edited || edited.byteStart !== html.indexOf(PAPER) || !editor?.aside?.charts.some((chart) => chart.text.includes(SUFFIX))) fail("编辑视图重解析了 HTML");

  const cite = (excerpt: string) => {
    const start = doc.indexOf(excerpt);
    if (start < 0) fail(`补充里没有 ${excerpt}`);
    return { excerpt, start, end: start + excerpt.length };
  };
  const file = await recordFileResult({
    articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: "rules@bind-v12", promptVersion: "prompt@bind-semantic", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "补充里有论文地址", quoteLocation: cite(PAPER), conditions: ["只引用已入库补充"], time: "unknown",
      valueBasis: "补充写了地址", audience: ["复核的人"], substantiveAddition: "正文没有这个地址", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T11:20:00.000Z");
  await recordFileResult({
    articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: "rules@bind-v12", promptVersion: "prompt@bind-unit", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "补充里有单位", quoteLocation: cite(SUFFIX), conditions: ["只引用已入库补充"], time: "unknown",
      valueBasis: "补充写了单位", audience: ["复核的人"], substantiveAddition: "正文没有这个单位行", clauses: [{ id: "scope", text: "当前补充" }],
    },
  }, "2026-11-18T11:20:01.000Z");
  let missing = "";
  try {
    await recordFileResult({
      articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
      rulesetVersion: "rules@bind-v12", promptVersion: "prompt@bind-missing", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
      output: {
        narrowClaim: "不存在的地址", quoteLocation: { excerpt: "https://example.org/missing.pdf", start: 0, end: 32 }, conditions: ["无"], time: "unknown",
        valueBasis: "无", audience: ["无"], substantiveAddition: "无", clauses: [{ id: "scope", text: "无" }],
      },
    }, "2026-11-18T11:20:02.000Z");
  } catch (error) {
    if (!(error instanceof JudgmentConflict)) throw error;
    missing = error.message;
  }
  if (!missing) fail("不存在的补充被接受了");

  const other = candidateFrom(`<!doctype html><html><body><article><p>${"Another page stays aside. ".repeat(12)}</p><p>See the <a href="https://example.org/other.pdf">other paper</a>.</p></article></body></html>`, OTHER, "Other");
  await storeCollected(SOURCE, "web_list", [other], null);
  const [otherRow] = await sql<{ id: string; evidence_hash: string; version: number; revision: number; gate: unknown }[]>`
    SELECT a.id, v.evidence_hash, v.version, a.revision, v.body_gate AS gate FROM articles a
    JOIN LATERAL (SELECT evidence_hash, version, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url = ${OTHER}`;
  const otherDoc = asideDocument(asideFromGate(otherRow!.gate));
  const otherStart = otherDoc.indexOf("https://example.org/other.pdf");
  await recordFileResult({
    articleId: otherRow!.id, evidenceHash: otherRow!.evidence_hash, evidenceVersion: Number(otherRow!.version), inputRevision: Number(otherRow!.revision),
    rulesetVersion: "rules@bind-v12", promptVersion: "prompt@bind-other", executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "另一篇的地址", quoteLocation: { excerpt: "https://example.org/other.pdf", start: otherStart, end: otherStart + "https://example.org/other.pdf".length },
      conditions: ["另一篇"], time: "unknown", valueBasis: "另一篇", audience: ["复核的人"], substantiveAddition: "另一篇", clauses: [{ id: "scope", text: "另一篇" }],
    },
  }, "2026-11-18T11:20:03.000Z");
  await recordSelectionDecision({
    articleId: otherRow!.id, evidenceHash: otherRow!.evidence_hash, evidenceVersion: Number(otherRow!.version), inputRevision: Number(otherRow!.revision),
    rulesetVersion: "rules@bind-v12", promptVersion: "prompt@bind-select", decision_rationale: "另一篇的选择理由。", conditions: ["另一篇"],
  }, "2026-11-18T11:20:04.000Z");
  const otherDraft = await recordReviewDraft({
    articleId: otherRow!.id, evidenceHash: otherRow!.evidence_hash, evidenceVersion: Number(otherRow!.version), inputRevision: Number(otherRow!.revision),
    rulesetVersion: "rules@bind-v12", promptVersion: "prompt@bind-draft", text: "另一篇仍待审。", sourceNote: "另一篇",
    sourceCitations: ["https://example.org/other.pdf"], conditions: ["另一篇"], technicalFixture: false, requiresHumanReview: true,
  }, "2026-11-18T11:20:05.000Z");

  const added = await appendLocatedSupplement(row.id, {
    kind: "content-links", sourceUrl: PAGE, httpStatus: 200, responseSha256: "local",
    parts: [{ id: "extra", role: "content_link", byteStart: 0, byteEnd: 0, text: "label: extra\nabsoluteUrl: https://example.org/extra.pdf\nlinkedPageRead: false" }],
  });
  const after = await materialForScoring(row.id);
  const [afterRow] = await sql<{ title: string; raw: unknown; body_text: string; quoted_text: string | null; x_post: unknown; evidence_hash: string; gate: unknown }[]>`
    SELECT a.title, v.raw, v.body_text, v.quoted_text, v.x_post, v.evidence_hash, v.body_gate AS gate
    FROM articles a JOIN LATERAL (
      SELECT raw, body_text, quoted_text, x_post, evidence_hash, body_gate FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.id = ${row.id}`;
  const shown = asideFromGate(afterRow!.gate);
  const recomputed = cumulativeEvidenceHash({ title: afterRow!.title, raw: afterRow!.raw, bodyText: afterRow!.body_text, quotedText: afterRow!.quoted_text, xPost: afterRow!.x_post as never, aside: shown });
  if (recomputed !== afterRow!.evidence_hash || after?.evidenceHash !== recomputed) fail("补料后的显示旁路没有被当前哈希盖住");
  if (!shown.links.some((link) => link.absoluteUrl === PAPER) || !shown.links.some((link) => link.absoluteUrl === "https://example.org/extra.pdf")) fail("补料后丢了原来的地址或新地址");
  const [probeStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${file.id}`;
  const [otherStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${otherDraft.id}`;
  if (!probeStale?.stale || otherStale?.stale) fail("失效范围不是只这一篇");
  const [counts] = await sql<{ publications: number; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications, (SELECT count(*)::int FROM deliveries) AS deliveries`;
  if (counts!.publications !== 0 || counts!.deliveries !== 0) fail("有发布或发送");
  await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL WHERE source_id = ${SOURCE}`;
  const report = {
    database, upsertEvidenceRows: upsertOnly!.n, storeEvidenceHash: row.evidence_hash, afterSupplementHash: added.evidenceHash,
    hashCoversDisplayedAside: true, paperByteStart: shown.links.find((link) => link.absoluteUrl === PAPER)?.byteStart ?? null,
    unitCited: true, missingRejected: missing, probeJudgmentStale: probeStale!.stale, otherDraftStale: otherStale!.stale, publications: 0,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, ...report }));
} finally {
  await stopBoss();
  await closeDb();
}
