// Append located condition supplements. Does not rewrite article revisions or existing file judgments.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { samePageFootnotes, utf8ByteOffset } from "@aihot/backend/body-gate";
import { appendLocatedSupplement } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const GEMINI = "j990zr6w58a7lxqye639td6ch";
const WATERMARK = "dx5k31vfb5cnwfgxqqb535v7v";
const CLAUDE = [
  "https://platform.claude.com/docs/en/release-notes/overview#linked-billing",
  "https://platform.claude.com/docs/en/release-notes/overview#text-watermark-claude-opus-4-6-and-4-5-models",
  "https://platform.claude.com/docs/en/release-notes/overview#self-hosted-managed-agents",
];
const PLATFORMS = "https://support.claude.com/en/articles/16266773-how-claude-marks-ai-generated-content";
const OUT = "/tmp/condition-supplement";

function plain(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function judgments(articleId: string) {
  return sql<{ id: string; stale: boolean; evidence_hash: string; claim: string | null }[]>`
    SELECT id, stale, evidence_hash, comparison->'fileResult'->'output'->>'narrowClaim' AS claim
    FROM own_judgments WHERE article_id = ${articleId} AND origin = 'file' ORDER BY created_at`;
}

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  if (process.env.MODEL_CALLS_ENABLED === "true" || process.env.COLLECT_ENABLED === "true") throw new Error("开关开着");
  mkdirSync(OUT, { recursive: true });
  const before = await sql<{ url: string; revision: number; version: number; evidence_hash: string; publication_time: string | null; body_len: number | null }[]>`
    SELECT a.url, a.revision, v.version, v.evidence_hash, a.publication_time, length(v.body_text) AS body_len
    FROM articles a JOIN own_evidence_versions v ON v.article_id = a.id
    WHERE a.id IN (${GEMINI}, ${WATERMARK}) AND v.version = (SELECT max(version) FROM own_evidence_versions WHERE article_id = a.id)`;
  const geminiJudgments = await judgments(GEMINI);
  const watermarkJudgments = await judgments(WATERMARK);

  const geminiHtml = readFileSync("/tmp/own-evidence-v13/items/04/response.bin").toString("utf8");
  const notes = samePageFootnotes(geminiHtml);
  const geminiBytes = Buffer.from(geminiHtml);
  const gemini = await appendLocatedSupplement(GEMINI, {
    kind: "same-page-footnotes",
    sourceUrl: "https://blog.google/innovation-and-ai/products/gemini-app/tasks-in-gemini-free-new-features/",
    httpStatus: 200,
    responseSha256: sha256(geminiBytes),
    parts: notes.flatMap((note) => [
      { id: `citation-${note.n}`, role: "citation", byteStart: note.citationByte, byteEnd: note.citationByte, text: String(note.n) },
      { id: `note-${note.n}`, role: "note", byteStart: note.noteByte, byteEnd: note.noteEndByte, text: note.text },
    ]),
  });

  const started = new Date().toISOString();
  const res = await guardedFetch(PLATFORMS, { timeoutMs: 25_000 });
  const page = Buffer.from(res.body);
  const pageSha = sha256(page);
  writeFileSync(`${OUT}/${pageSha}.bin`, page);
  let platform: { version: number; evidenceHash: string; previousHash: string; articleRevision: number; staled: number } | null = null;
  let platformText: string | null = null;
  let platformSpan: { start: number; end: number } | null = null;
  if (res.status === 200) {
    const html = page.toString("utf8");
    const start = html.indexOf(">What’s covered<") >= 0 ? html.indexOf(">What’s covered<") : html.indexOf(">What's covered<");
    const end = html.indexOf(">How Claude marks content<");
    if (start < 0 || end < start) throw new Error("平台段没有在这一页里");
    platformText = plain(html.slice(start, end));
    platformSpan = { start: utf8ByteOffset(html, start), end: utf8ByteOffset(html, end) };
    platform = await appendLocatedSupplement(WATERMARK, {
      kind: "linked-official-platforms",
      sourceUrl: res.url || PLATFORMS,
      httpStatus: res.status,
      responseSha256: pageSha,
      parts: [{ id: "platforms-and-models", role: "platforms", byteStart: platformSpan.start, byteEnd: platformSpan.end, text: platformText }],
    });
  }
  const dates = [];
  for (const url of CLAUDE) {
    const [row] = await sql<{ publication_time: string | null; revision: number }[]>`
      SELECT publication_time, revision FROM articles WHERE url = ${url}`;
    const day = row?.publication_time?.slice(0, 10) ?? null;
    if (day && row?.publication_time !== day) {
      await sql`UPDATE articles SET publication_time = ${day} WHERE url = ${url} AND revision = ${row.revision}`;
    }
    const [afterDate] = await sql<{ publication_time: string | null; published_at: Date | null; revision: number }[]>`
      SELECT publication_time, published_at, revision FROM articles WHERE url = ${url}`;
    dates.push({ url, before: row?.publication_time ?? null, after: afterDate?.publication_time ?? null, publishedAt: afterDate?.published_at ?? null, revision: afterDate?.revision ?? null, timePrecision: "date" });
  }
  const xy = await sql<{ revision: number; content_hash: string; body_len: number | null }[]>`
    SELECT r.revision, r.content_hash, length(r.body_text) AS body_len
    FROM article_revisions r JOIN articles a ON a.id = r.article_id
    WHERE a.url = 'https://huggingface.co/blog/allenai/xybench' ORDER BY r.revision`;
  const [xyNow] = await sql<{ revision: number; body_len: number | null; evidence_version: number; evidence_hash: string }[]>`
    SELECT a.revision, length(a.body_text) AS body_len, v.version AS evidence_version, v.evidence_hash
    FROM articles a JOIN own_evidence_versions v ON v.article_id = a.id
    WHERE a.url = 'https://huggingface.co/blog/allenai/xybench'
      AND v.version = (SELECT max(version) FROM own_evidence_versions WHERE article_id = a.id)`;
  const after = await sql<{ url: string; revision: number; version: number; evidence_hash: string; body_len: number | null }[]>`
    SELECT a.url, a.revision, v.version, v.evidence_hash, length(v.body_text) AS body_len
    FROM articles a JOIN own_evidence_versions v ON v.article_id = a.id
    WHERE a.id IN (${GEMINI}, ${WATERMARK}) AND v.version = (SELECT max(version) FROM own_evidence_versions WHERE article_id = a.id)`;
  const report = {
    paid: false, bypass403: false,
    before, after,
    gemini: { notes, result: gemini, judgmentsBefore: geminiJudgments, judgmentsAfter: await judgments(GEMINI) },
    watermark: {
      requestedUrl: PLATFORMS, fetchedAt: started, status: res.status, finalUrl: res.url, bytes: page.length, sha256: pageSha,
      followedFurtherLinks: false, platformSpan, platformText, result: platform,
      judgmentsBefore: watermarkJudgments, judgmentsAfter: await judgments(WATERMARK),
    },
    claudeDatePrecision: dates,
    xybench: {
      explanation: "article.revision counts content-hash changes of the article row. own_evidence_versions.version appends each stored snapshot and keeps the article revision it was attached to. XYBench's current article revision is still 4 because later evidence writes did not create a new article revision; evidence version 15 is the bound text. The revision was not incremented to match the evidence number.",
      revisions: xy, now: xyNow,
    },
  };
  writeFileSync(`${OUT}/SUPPLEMENT_RUN.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    gemini: { version: gemini.version, hash: gemini.evidenceHash, previous: gemini.previousHash, revision: gemini.articleRevision, staled: gemini.staled, notes: notes.map((n) => n.text) },
    watermark: platform ? { status: res.status, version: platform.version, hash: platform.evidenceHash, previous: platform.previousHash, revision: platform.articleRevision, staled: platform.staled } : { status: res.status },
    dates: dates.map((d) => d.after),
    xyRevision: xyNow?.revision,
  }));
}

try { await main(); } finally { await closeDb(); }
