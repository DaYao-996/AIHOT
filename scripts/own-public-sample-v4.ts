// Chart rows and Apple date-only fields from bytes already saved. No new request. Does not rewrite v3.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { contentHash, fillPublicationTime, reviseMaterial } from "@aihot/backend/content/materials";
import { appendLocatedSupplement } from "@aihot/backend/own-pipeline-store";
import { readPublicationDate } from "@aihot/backend/sources/dates";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const V3 = "docs/own-pipeline/PUBLIC_SAMPLE_v3.json";
const OUT = "docs/own-pipeline/PUBLIC_SAMPLE_v4.json";
const MISTRAL_SHA = "6f6d1081c63ed3b7fde2d4f63bf97b13d1db28f1444cd89d0fb07851fa389605";
const MISTRAL_URL = "https://mistral.ai/news/mistral-large-4-oss/";
const FROZEN = new Set([
  "own_public_sample_test", "own_public_sample_v2_test", "own_public_sample_v3_test",
  "own_rss_probe_test", "own_review_loop_test", "own_codex_note_test",
  "own_source_coverage_test", "own_source_coverage_gap_test",
]);

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonSlice(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function chartText(heading: string, section: string, captions: string[], chart: Record<string, unknown>): string {
  const lines = [`heading: ${heading}`, `section: ${section}`];
  for (const caption of captions) lines.push(`pageCaption: ${caption}`);
  for (const key of ["title", "type", "caption", "subtitle", "subject", "opponent"]) {
    if (typeof chart[key] === "string") lines.push(`${key}: ${chart[key]}`);
  }
  const axis = (name: string) => {
    const value = chart[name];
    if (value && typeof value === "object" && "label" in value && typeof value.label === "string") lines.push(`${name}: ${value.label}`);
  };
  axis("x");
  axis("y");
  if (typeof chart.value === "string") lines.push(`value: ${chart.value}`);
  const rows = Array.isArray(chart.data) ? chart.data : Array.isArray(chart.points) ? chart.points : [];
  lines.push("rows:");
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const bits = [`label=${String(item.label ?? "")}`];
    if (item.value !== undefined) bits.push(`value=${String(item.value)}`);
    if (item.x !== undefined) bits.push(`x=${String(item.x)}`);
    if (item.y !== undefined) bits.push(`y=${String(item.y)}`);
    if (typeof item.series === "string") bits.push(`series=${item.series}`);
    if (item.tie !== undefined) bits.push(`tie=${String(item.tie)}`);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}

function chartsFrom(bytes: Buffer): Array<{ id: string; role: string; byteStart: number; byteEnd: number; text: string }> {
  const html = bytes.toString("utf8");
  const $ = cheerio.load(html);
  const parts = [];
  let n = 0;
  $("figure").each((_, el) => {
    const node = $(el).find("mistral-block-chart").first();
    if (!node.length) return;
    n += 1;
    const raw = jsonSlice(node.text());
    const heading = $(el).find("h2, h3").first().text().replace(/\s+/g, " ").trim();
    let section = "";
    let prev = $(el).prev();
    while (prev.length) {
      if (/^h2$/i.test(prev.get(0)!.tagName)) { section = prev.text().replace(/\s+/g, " ").trim(); break; }
      prev = prev.prev();
    }
    const captions = [...new Set($(el).find("p").toArray().map((p) => $(p).text().replace(/\s+/g, " ").trim()).filter((text) => text && !text.includes("{")))];
    if (!raw) {
      parts.push({ id: `chart-${n}`, role: "chart_not_extracted", byteStart: 0, byteEnd: 0, text: `heading: ${heading}\nchartNotExtracted: true` });
      return;
    }
    const at = bytes.indexOf(Buffer.from(raw));
    if (at < 0) throw new Error(`图表原文对不上字节 ${heading}`);
    parts.push({
      id: `chart-${n}`, role: "chart", byteStart: at, byteEnd: at + Buffer.byteLength(raw),
      text: chartText(heading, section, captions, JSON.parse(raw) as Record<string, unknown>),
    });
  });
  return parts;
}

function datePublished(html: string): string | null {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.datePublished === "string") found.push(record.datePublished);
    if (record["@graph"]) walk(record["@graph"]);
  };
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(match[1]!)); } catch { /* a broken block names no date */ }
  }
  return found.length === 1 ? found[0]! : null;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDatabase(databaseUrl);
  const database = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (FROZEN.has(database)) throw new Error("这是已冻结的库");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
  const [counts] = await sql<{ articles: number; revisions: number; evidence: number; judgments: number }[]>`
    SELECT (SELECT count(*)::int FROM articles) AS articles,
           (SELECT count(*)::int FROM article_revisions) AS revisions,
           (SELECT count(*)::int FROM own_evidence_versions) AS evidence,
           (SELECT count(*)::int FROM own_judgments) AS judgments`;
  if (counts!.articles !== 40 || counts!.revisions !== 74 || counts!.evidence !== 40 || counts!.judgments !== 0) {
    throw new Error("这不是未改过的 v3 副本");
  }
  const bytes = readFileSync(process.env.MISTRAL_HTML ?? `/tmp/public-sample-v2/bytes/${MISTRAL_SHA}.bin`);
  if (sha(bytes) !== MISTRAL_SHA) throw new Error("Mistral 原件哈希不符");
  const parts = chartsFrom(bytes);
  if (parts.some((part) => part.role === "chart_not_extracted")) throw new Error("有图表没有抽出，已停止，没有改库");
  const joined = parts.map((part) => part.text).join("\n");
  for (const needle of ["50.9", "label=GLM-5.3 value=64", "label=DeepSeek V4.1 Flash value=56", "label=Claude Opus 5.5 value=22", "JailbreakBench", "StrongREJECT", "AgentHarm"]) {
    if (!joined.includes(needle)) throw new Error(`图表里缺少原文 ${needle}`);
  }
  const [mistralBefore] = await sql<{ id: string; body_text: string; evidence_hash: string }[]>`
    SELECT a.id, a.body_text, v.evidence_hash FROM articles a
    JOIN own_evidence_versions v ON v.article_id = a.id
    WHERE a.url = ${MISTRAL_URL} ORDER BY v.version DESC LIMIT 1`;
  const othersBefore = await sql<{ id: string; evidence_hash: string }[]>`
    SELECT a.id, v.evidence_hash FROM articles a
    JOIN LATERAL (SELECT evidence_hash FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url <> ${MISTRAL_URL}`;
  const supplement = await appendLocatedSupplement(mistralBefore!.id, {
    kind: "chart-section", sourceUrl: MISTRAL_URL, httpStatus: 200, responseSha256: MISTRAL_SHA, parts,
  });
  const [mistralAfter] = await sql<{ body_text: string; revision: number; version: number }[]>`
    SELECT a.body_text, a.revision, v.version FROM articles a
    JOIN own_evidence_versions v ON v.article_id = a.id
    WHERE a.id = ${mistralBefore!.id} ORDER BY v.version DESC LIMIT 1`;
  if (mistralAfter!.body_text !== mistralBefore!.body_text) throw new Error("Mistral 正文被覆盖了");
  if (mistralAfter!.revision !== 2 || mistralAfter!.version !== 2) throw new Error("Mistral 修订或证据版次不符");
  if (supplement.staled !== 0) throw new Error("没有判断却标成失效");

  const v3 = JSON.parse(readFileSync(V3, "utf8"));
  const apple = [];
  for (const item of v3.items) {
    if (!String(item.source).startsWith("apple_newsroom_")) continue;
    const fileSha = item.sha256 ?? item.detail?.sha256;
    const path = item.detailFrom === "v1"
      ? `/tmp/public-sample-v1/bytes/${fileSha}.bin`
      : `/tmp/public-sample-v2/bytes/${fileSha}.bin`;
    const html = readFileSync(path).toString("utf8");
    if (sha(Buffer.from(html)) !== fileSha) throw new Error(`Apple 原件哈希不符 ${item.url}`);
    const raw = datePublished(html);
    if (!raw || !/^\d{4}-\d{2}-\d{2}Z$/.test(raw)) throw new Error(`详情没有单独的日期字段 ${item.url}`);
    const read = readPublicationDate(raw, "+00:00");
    if (read.publicationTime !== raw.slice(0, 10)) throw new Error(`日期读法不符 ${item.url}`);
    const [row] = await sql<{ id: string; revision: number; body_text: string; published_at: Date | null }[]>`
      SELECT id, revision, body_text, published_at FROM articles WHERE url = ${item.url}`;
    if (!row || row.published_at) throw new Error(`Apple 日期列不是空的 ${item.url}`);
    const bodyBefore = row.body_text;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM articles WHERE id = ${row.id} FOR UPDATE`;
      const filled = await fillPublicationTime(tx, row.id, read.publishedAt, undefined, read.publicationTime);
      if (!filled) throw new Error(`日期没有写入 ${item.url}`);
      const [current] = await tx<{ title: string; body_text: string | null; excerpt: string | null; content_hash: string }[]>`
        SELECT title, body_text, excerpt, content_hash FROM articles WHERE id = ${row.id}`;
      await reviseMaterial(tx, row.id, {
        set: sql`title = title`, hash: current!.content_hash, title: current!.title, bodyText: current!.body_text,
      });
      await tx`UPDATE own_judgments SET stale = true
        WHERE article_id = ${row.id} AND stale = false AND input_revision <> (SELECT revision FROM articles WHERE id = ${row.id})`;
      await tx`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL WHERE id = ${row.id}`;
    });
    const [after] = await sql<{ revision: number; body_text: string; publication_time: string | null; published_at: Date | null; processing_state: string }[]>`
      SELECT revision, body_text, publication_time, published_at, processing_state FROM articles WHERE id = ${row.id}`;
    if (after!.body_text !== bodyBefore) throw new Error(`Apple 正文被覆盖了 ${item.url}`);
    if (after!.publication_time !== read.publicationTime || after!.processing_state !== "skipped") throw new Error(`Apple 日期没有按日期级留下 ${item.url}`);
    apple.push({
      url: item.url, source: item.source, timeSource: "jsonld:datePublished", raw,
      publicationTime: after!.publication_time, publicationPrecision: "date_only",
      revisionBefore: row.revision, revisionAfter: after!.revision, bodyUnchanged: true,
      notUsed: ["dateModified", "atom:updated", "readTime"],
    });
  }

  const othersAfter = await sql<{ id: string; evidence_hash: string }[]>`
    SELECT a.id, v.evidence_hash FROM articles a
    JOIN LATERAL (SELECT evidence_hash FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE a.url <> ${MISTRAL_URL}`;
  const moved = othersAfter.filter((row) => othersBefore.find((before) => before.id === row.id)?.evidence_hash !== row.evidence_hash);
  if (moved.length) throw new Error("其他材料的证据被改了");
  const [finalCounts] = await sql<{ articles: number; evidence: number; judgments: number; queued: number }[]>`
    SELECT (SELECT count(*)::int FROM articles) AS articles,
           (SELECT count(*)::int FROM own_evidence_versions) AS evidence,
           (SELECT count(*)::int FROM own_judgments) AS judgments,
           (SELECT count(*)::int FROM articles WHERE processing_state = 'new') AS queued`;
  if (finalCounts!.articles !== 40 || finalCounts!.evidence !== 41 || finalCounts!.judgments !== 0 || finalCounts!.queued !== 0) {
    throw new Error(`库计数不符 ${JSON.stringify(finalCounts)}`);
  }
  const manifest = {
    asOf: new Date().toISOString(), basedOn: "public-sample-v3", frozenV3Unchanged: true,
    database, newRequests: 0, scores: null, decisions: null, labels: null,
    workerStarted: false, modelCalls: 0, paid: false, completenessClaimed: false,
    denominator: 40,
    mistral: {
      url: MISTRAL_URL, bodyUnchanged: true, bodyLength: mistralBefore!.body_text.length,
      previousEvidenceHash: supplement.previousHash, evidenceHash: supplement.evidenceHash,
      evidenceVersion: supplement.version, articleRevision: supplement.articleRevision,
      staledJudgments: supplement.staled, charts: parts.length,
      chartsNotExtracted: parts.filter((part) => part.role === "chart_not_extracted").length,
      parts,
    },
    apple,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    ok: true, database, charts: parts.length, apple: apple.length,
    evidence: supplement.evidenceHash, bodyUnchanged: true, completenessClaimed: false,
  }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => undefined);
  await closeDb();
}
