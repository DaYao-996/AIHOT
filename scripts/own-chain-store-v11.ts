// Normal collection store persists parsed asides, and a file result can cite them.
// The script does not pass contentAside into the evidence writer itself.
import { readFileSync, writeFileSync } from "node:fs";
import { readable } from "@aihot/backend/content/extract";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { JudgmentConflict, listPendingDrafts, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { applyDetail, storeCollected, type CollectionCandidate } from "@aihot/backend/sources/collect";
import { asideDocument, asideFromGate } from "@aihot/backend/sources/saved-supplements";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_v6_test", "own_public_sample_v9_test", "own_public_sample_v9_change_test",
  "own_chain_aside_v10_test", "own_rss_probe_test", "own_review_loop_test",
]);
const SOURCE = "chain-store-v11";
const PAGE = "https://example.org/post";
const OTHER = "https://example.org/other";
const PAPER = "https://example.org/paper.pdf";
const SUFFIX = "value.suffix: %";

function fail(message: string): never {
  throw new Error(message);
}

function candidateFrom(html: string, url: string, title: string): CollectionCandidate {
  const parsed = readable(html, url);
  if (!parsed) fail(`普通解析没有正文 ${url}`);
  const candidate = { url, title, raw: { kind: "offline-html" } } as CollectionCandidate;
  applyDetail(candidate, { title, summary: null, publishedAt: null, publicationTime: null, body: parsed, response: null }, "offline");
  return candidate;
}

async function stored(url: string) {
  const [row] = await sql<{
    id: string; body_text: string | null; revision: number; version: number; evidence_hash: string;
    article_revision: number; evidence_body: string | null; body_gate: unknown;
  }[]>`
    SELECT a.id, a.body_text, a.revision, v.version, v.evidence_hash, v.article_revision,
           v.body_text AS evidence_body, v.body_gate
    FROM articles a
    JOIN LATERAL (
      SELECT version, evidence_hash, article_revision, body_text, body_gate
      FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true
    WHERE a.url = ${url}`;
  if (!row) fail(`没有入库 ${url}`);
  return row;
}

function cite(doc: string, excerpt: string) {
  const start = doc.indexOf(excerpt);
  if (start < 0) fail(`补充里没有 ${excerpt}`);
  return { excerpt, start, end: start + excerpt.length };
}

async function fileOn(row: Awaited<ReturnType<typeof stored>>, quote: { excerpt: string; start: number; end: number }, prompt: string, write = true) {
  return recordFileResult({
    articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version),
    inputRevision: Number(row.revision), rulesetVersion: "rules@store-v11", promptVersion: prompt,
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "补充里有这一处可定位的材料",
      quoteLocation: quote,
      conditions: ["只引用已经入库的补充"], time: "unknown", valueBasis: "补充文本里有这一段",
      audience: ["复核的人"], substantiveAddition: "正文没有写出的地址或单位",
      clauses: [{ id: "scope", text: "当前证据里的补充" }],
    },
  }, "2026-11-18T11:10:00.000Z", write ? undefined : { write: false });
}

const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unset").pathname.replace(/^\//, "");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (FROZEN.has(database)) fail("这是已冻结的库");
if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") fail("开关开着");

const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 ? process.argv[outFlag + 1]! : "docs/own-pipeline/chain-store-v11/REPORT.json";
const htmlPath = process.argv.includes("--html") ? process.argv[process.argv.indexOf("--html") + 1]! : "docs/own-pipeline/chain-aside-v10/input.html";
const bodyPath = process.argv.includes("--body") ? process.argv[process.argv.indexOf("--body") + 1]! : "docs/own-pipeline/chain-aside-v10/evidence-v1-body.txt";
const log: string[] = [];
const note = (row: unknown) => { const line = JSON.stringify(row); log.push(line); console.log(line); };

try {
  const html = readFileSync(htmlPath, "utf8");
  const expectedBody = readFileSync(bodyPath, "utf8");
  const otherHtml = `<!doctype html><html><body><article><p>${"Another release note stays on its own page. ".repeat(8)}</p><p>See the <a href="https://example.org/other.pdf">other paper</a>.</p></article></body></html>`;
  await sql`INSERT INTO sources (id, name, kind, participation_mode, config, next_fetch_at)
    VALUES (${SOURCE}, 'Chain store', 'web_list', 'isolated', ${sql.json({ detail: { maxFetches: 1 } })}, '2100-01-01')
    ON CONFLICT (id) DO NOTHING`;

  const first = candidateFrom(html, PAGE, "Probe");
  note({ step: "parsed", paperInBody: first.bodyText?.includes("paper.pdf") ?? false, asideLinks: first.contentAside?.links.map((link) => link.absoluteUrl) });
  await storeCollected(SOURCE, "web_list", [first], null);
  const saved = await stored(PAGE);
  const aside = asideFromGate(saved.body_gate);
  const doc = asideDocument(aside);
  if (saved.body_text !== expectedBody) fail("入库正文不是原来的 817 字");
  if (saved.evidence_body !== saved.body_text) fail("证据正文和文章正文不一致");
  if (saved.body_text.includes("paper.pdf")) fail("正文里不该有论文地址");
  if (!doc.includes(PAPER) || !doc.includes(SUFFIX) || !doc.includes("linkedPageRead: false")) fail("入库补充没有论文地址或单位");
  const cited = await fileOn(saved, cite(doc, PAPER), "prompt@store-semantic");
  const citedUnit = await fileOn(saved, cite(doc, SUFFIX), "prompt@store-unit", false);
  if (cited.identity.evidenceHash !== saved.evidence_hash || cited.identity.inputRevision !== Number(saved.revision)) fail("文件语义没有绑当前证据");
  await recordSelectionDecision({
    articleId: saved.id, evidenceHash: saved.evidence_hash, evidenceVersion: Number(saved.version),
    inputRevision: Number(saved.revision), rulesetVersion: "rules@store-v11", promptVersion: "prompt@store-select",
    decision_rationale: "选择理由不是稿件正文。", conditions: ["只引用已经入库的补充"],
  }, "2026-11-18T11:10:01.000Z");
  await recordReviewDraft({
    articleId: saved.id, evidenceHash: saved.evidence_hash, evidenceVersion: Number(saved.version),
    inputRevision: Number(saved.revision), rulesetVersion: "rules@store-v11", promptVersion: "prompt@store-draft",
    text: "版本说明给出了技术论文的入口，单位写在图上。", sourceNote: "离线页入库后的待审稿",
    sourceCitations: [PAPER], conditions: ["只引用已经入库的补充"], technicalFixture: false, requiresHumanReview: true,
  }, "2026-11-18T11:10:02.000Z");

  const second = candidateFrom(otherHtml, OTHER, "Other");
  await storeCollected(SOURCE, "web_list", [second], null);
  const other = await stored(OTHER);
  const otherDoc = asideDocument(asideFromGate(other.body_gate));
  await fileOn(other, cite(otherDoc, "https://example.org/other.pdf"), "prompt@store-other");
  await recordSelectionDecision({
    articleId: other.id, evidenceHash: other.evidence_hash, evidenceVersion: Number(other.version),
    inputRevision: Number(other.revision), rulesetVersion: "rules@store-v11", promptVersion: "prompt@store-select",
    decision_rationale: "另一篇的选择理由。", conditions: ["另一篇"],
  }, "2026-11-18T11:10:03.000Z");
  const otherDraft = await recordReviewDraft({
    articleId: other.id, evidenceHash: other.evidence_hash, evidenceVersion: Number(other.version),
    inputRevision: Number(other.revision), rulesetVersion: "rules@store-v11", promptVersion: "prompt@store-draft",
    text: "另一篇仍待审。", sourceNote: "另一篇", sourceCitations: ["https://example.org/other.pdf"],
    conditions: ["另一篇"], technicalFixture: false, requiresHumanReview: true,
  }, "2026-11-18T11:10:04.000Z");

  const again = await storeCollected(SOURCE, "web_list", [candidateFrom(html, PAGE, "Probe")], null);
  const replay = await stored(PAGE);
  if (Number(replay.version) !== Number(saved.version) || replay.evidence_hash !== saved.evidence_hash) fail("相同材料再次入库不是幂等");
  note({ step: "replay", created: again.created, revised: again.revised, version: replay.version });

  let missing = "";
  try {
    await fileOn(replay, { excerpt: "https://example.org/not-a-page.pdf", start: 0, end: "https://example.org/not-a-page.pdf".length }, "prompt@store-missing");
  } catch (error) {
    if (!(error instanceof JudgmentConflict)) throw error;
    missing = error.message;
  }
  let wrongPlace = "";
  try {
    await fileOn(replay, { excerpt: PAPER, start: 0, end: PAPER.length }, "prompt@store-offset");
  } catch (error) {
    if (!(error instanceof JudgmentConflict)) throw error;
    wrongPlace = error.message;
  }
  if (!missing || !wrongPlace) fail("不存在或错位的补充被接受了");

  const changedHtml = html.replaceAll(PAPER, "https://example.org/paper-v2.pdf");
  await storeCollected(SOURCE, "web_list", [candidateFrom(changedHtml, PAGE, "Probe")], null);
  const moved = await stored(PAGE);
  if (moved.body_text !== expectedBody) fail("只改链接后正文变了");
  if (moved.evidence_hash === saved.evidence_hash) fail("补充变了证据哈希却没变");
  const [probeDraft] = await sql<{ stale: boolean }[]>`
    SELECT stale FROM own_judgments WHERE article_id = ${saved.id} AND comparison->'reviewDraft'->>'status' = 'pending_review'`;
  const [kept] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${otherDraft.id}`;
  if (!probeDraft?.stale || kept?.stale) fail("失效范围不是只这一篇");
  let oldHash = "";
  try {
    await fileOn(saved, cite(doc, PAPER), "prompt@store-old");
  } catch (error) {
    if (!(error instanceof JudgmentConflict)) throw error;
    oldHash = error.message;
  }
  if (!oldHash) fail("旧证据哈希仍被接受");
  const pending = await listPendingDrafts();
  if (!pending.some((row) => row.id === otherDraft.id) || pending.some((row) => row.articleId === saved.id)) fail("待审列表不对");

  const samples = [];
  for (const sample of [
    { file: "/tmp/public-sample-v2/bytes/6f6d1081c63ed3b7fde2d4f63bf97b13d1db28f1444cd89d0fb07851fa389605.bin", url: "https://mistral.ai/news/mistral-large-4-oss/" },
    { file: "/tmp/public-sample-v1/bytes/ab180da801fca34eb50d653dd28275ce84a4a96e82dfd6969fdef905e4fdb7af.bin", url: "https://mistral.ai/news/build-with-studio/" },
    { file: "/tmp/public-sample-v2/bytes/7b872d33f2809084640c86bb62b25c4382857af25ac8dfea6aae8b86ccba298e.bin", url: "https://deepmind.google/blog/introducing-alphaproof-code/" },
  ]) {
    let page = "";
    try { page = readFileSync(sample.file, "utf8"); } catch { samples.push({ url: sample.url, stored: false }); continue; }
    const parsed = readable(page, sample.url);
    if (!parsed?.aside || (parsed.aside.links.length === 0 && parsed.aside.charts.length === 0)) {
      samples.push({ url: sample.url, stored: false });
      continue;
    }
    const item = { url: sample.url, title: parsed.text.slice(0, 80), raw: { kind: "saved-html" } } as CollectionCandidate;
    applyDetail(item, { title: item.title, summary: null, publishedAt: null, publicationTime: null, body: parsed, response: null }, "offline");
    await storeCollected(SOURCE, "web_list", [item], null);
    const row = await stored(sample.url);
    const got = asideFromGate(row.body_gate);
    samples.push({ url: sample.url, stored: true, bodyChars: row.body_text?.length ?? 0, links: got.links.length, charts: got.charts.length, bodyMatchesParser: row.body_text === parsed.text });
  }
  if (!samples.some((row) => row.stored)) fail("真实页面没有一条走通同一入库");

  const [counts] = await sql<{ publications: number; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications,
           (SELECT count(*)::int FROM deliveries) AS deliveries`;
  if ((counts?.publications ?? 1) !== 0 || (counts?.deliveries ?? 1) !== 0) fail("有发布或发送");
  await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL WHERE source_id = ${SOURCE}`;

  const report = {
    premiseRejected: "解析和评分可见补充，就等于正常持久化与文件语义真正可消费",
    whyRejected: "v10 是调用方把旁路交给证据写入。这一轮只调用 storeCollected，证据和引用都从库里的当前行来。",
    database, network: false,
    bodyChars: saved.body_text?.length ?? 0,
    bodyUnchangedAfterLinkEdit: moved.body_text === expectedBody,
    paperCited: true, unitCited: citedUnit.idempotent === false,
    missingRejected: missing, wrongOffsetRejected: wrongPlace, oldHashRejected: oldHash,
    probeDraftStale: probeDraft?.stale === true, otherDraftStale: kept?.stale === true,
    publications: counts?.publications ?? null, samples,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(out.replace(/REPORT\.json$/, "COMMANDS.log"), log.join("\n") + "\n");
  note({ ok: true, report });
} finally {
  await stopBoss();
  await closeDb();
}
