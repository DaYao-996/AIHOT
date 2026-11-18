// Three gaps in the frozen public sample, filled from bytes already saved. No new request.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { appendControlledEvidence } from "@aihot/backend/own-pipeline-store";
import { fromAntigravityChangelog, locateArticleText } from "@aihot/backend/sources/web-list";
import { type SourceRow } from "@aihot/backend/sources/types";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const V2 = "docs/own-pipeline/PUBLIC_SAMPLE_v2.json";
const OUT = "docs/own-pipeline/PUBLIC_SAMPLE_v3.json";
const PACK = "/tmp/public-sample-v3";
const FROZEN = new Set([
  "own_public_sample_test", "own_public_sample_v2_test", "own_rss_probe_test",
  "own_codex_note_test", "own_source_coverage_test", "own_source_coverage_gap_test",
]);
const MISTRAL_SHA = "6f6d1081c63ed3b7fde2d4f63bf97b13d1db28f1444cd89d0fb07851fa389605";
const CHANGELOG_SHA = "b8954f59f47f9b6d6a5108bbd0718b692a6e2d0496fc4a907355e646201d9be0";
const CODEX_SHA = "a7b07857e797942e61e37eab19a9d2f5b3179e072c04e4cccc67cfb85f0b6d08";
const HUB_SHA = "2da88dd05617ecfd448c30eedc35c1d34043a5b0178a5adcc05b0538166c0a81";
const MISTRAL_URL = "https://mistral.ai/news/mistral-large-4-oss/";
const CODEX_URL = "https://github.com/openai/codex/releases/tag/rust-v0.171.0-alpha.13";
const CODEX_BODY = "Release 0.171.0-alpha.13";
const ANTIGRAVITY = [
  "https://antigravity.google/releases?tab=hub&version=2.32.2",
  "https://antigravity.google/releases?tab=hub&version=2.32.1",
  "https://antigravity.google/releases?tab=hub&version=2.32.0",
  "https://antigravity.google/releases?tab=hub&version=2.31.2",
];

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function saved(path: string, expected: string): Buffer {
  const bytes = readFileSync(path);
  const got = sha(bytes);
  if (got !== expected) throw new Error(`字节哈希不符 ${path}`);
  return bytes;
}

async function articleCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles`;
  return row!.n;
}

async function writeSection(input: {
  sourceId: string;
  url: string;
  title: string;
  bodyText: string;
  raw: Record<string, unknown>;
  bytes: Buffer;
  fileSha: string;
  publishedAt?: string;
}): Promise<{ createdArticle: boolean; revisedArticle: boolean; revision: number; evidenceVersion: number; evidenceHash: string; fileSha: string }> {
  const written = await appendControlledEvidence({
    sourceId: input.sourceId,
    url: input.url,
    title: input.title,
    raw: input.raw,
    bodyText: input.bodyText,
    rawFileBase64: input.bytes.toString("base64"),
    rawFileSha256: input.fileSha,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
  });
  if (written.createdArticle) throw new Error(`新文章 ${input.url}`);
  const [check] = await sql<{ file_sha: string; revision: number; n: number }[]>`
    SELECT encode(sha256(v.raw_file), 'hex') AS file_sha, a.revision, length(a.body_text) AS n
    FROM own_evidence_versions v JOIN articles a ON a.id = v.article_id
    WHERE v.article_id = ${written.articleId} AND v.version = ${written.evidenceVersion}`;
  if (check?.file_sha !== input.fileSha) throw new Error(`证据原件哈希不符 ${input.url}`);
  if (check.n !== input.bodyText.length) throw new Error(`正文长度不符 ${input.url}`);
  return {
    createdArticle: written.createdArticle,
    revisedArticle: written.revisedArticle,
    revision: check.revision,
    evidenceVersion: written.evidenceVersion,
    evidenceHash: written.evidenceHash,
    fileSha: check.file_sha,
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDatabase(databaseUrl);
  const database = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (FROZEN.has(database)) throw new Error("这是已冻结的库");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
  const before = await articleCount();
  if (before !== 40) throw new Error(`分母不是 40，是 ${before}`);
  const [judgments] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_judgments`;
  if (judgments!.n !== 0) throw new Error("这个库里有判断，拒绝写入");

  const mistralHtml = saved(process.env.MISTRAL_HTML ?? `/tmp/public-sample-v2/bytes/${MISTRAL_SHA}.bin`, MISTRAL_SHA);
  const changelog = saved(process.env.CHANGELOG_MD ?? `/tmp/public-sample-v1/bytes/${CHANGELOG_SHA}.bin`, CHANGELOG_SHA);
  const codexJson = saved(process.env.CODEX_JSON ?? `/tmp/codex-note/bytes/${CODEX_SHA}.bin`, CODEX_SHA);
  const release = JSON.parse(codexJson.toString("utf8")) as { body?: string; published_at?: string; html_url?: string };
  if (release.body?.trim() !== CODEX_BODY) throw new Error("官方 JSON 的正文不是那一句");
  if (release.published_at !== "2026-11-18T05:47:55Z") throw new Error("官方 JSON 的 published_at 不符");
  if (release.html_url !== CODEX_URL) throw new Error("官方 JSON 的页面不是原来那一条");

  const located = locateArticleText(mistralHtml.toString("utf8"));
  if (!located) throw new Error("Mistral 页面没有 article");
  if (located.text.includes('{"data"') || located.text.includes("Thinking Summary") || located.text.includes("Download PNG")) {
    throw new Error("定位后的正文仍含图表数据或摘要条");
  }
  if (located.navChars > 500) throw new Error("导航长得不像导航");

  const v2 = JSON.parse(readFileSync(V2, "utf8"));
  const asOf = new Date().toISOString();
  const notes = new Map<string, Record<string, unknown>>();

  const [mistral] = await sql<{ title: string; revision: number; raw: Record<string, unknown> | null }[]>`
    SELECT title, revision, raw FROM articles WHERE url = ${MISTRAL_URL}`;
  if (!mistral || mistral.revision !== 1) throw new Error("Mistral 不是未绑定的修订 1");
  const mistralWritten = await writeSection({
    sourceId: "mistral_news", url: MISTRAL_URL, title: mistral.title, bodyText: located.text,
    bytes: mistralHtml, fileSha: MISTRAL_SHA,
    raw: {
      ...(mistral.raw ?? {}),
      role: "detail_article",
      responseSha256: MISTRAL_SHA,
      articleChars: located.articleChars,
      navChars: located.navChars,
      headerChars: located.headerChars,
      footerChars: located.footerChars,
    },
  });
  notes.set(MISTRAL_URL, {
    v3Change: "article_located",
    newRequest: false,
    sourceEmpty: false,
    wholePage: false,
    readabilityRejectedChars: 22694,
    articleChars: located.articleChars,
    navChars: located.navChars,
    headerChars: located.headerChars,
    footerChars: located.footerChars,
    sectionLength: located.text.length,
    excluded: ["nav", "header", "footer", "hero", "thinking-summary", "chart-json", "model-card", "scroll-progress"],
    bodyBound: "detail_article",
    revisionBefore: 1,
    evidence: {
      version: mistralWritten.evidenceVersion,
      evidenceHash: mistralWritten.evidenceHash,
      articleRevision: mistralWritten.revision,
      fileSha256: mistralWritten.fileSha,
      matchesResponse: true,
      bodyLength: located.text.length,
      revisedArticle: mistralWritten.revisedArticle,
    },
  });

  const parsed = fromAntigravityChangelog(changelog.toString("utf8"), "https://antigravity.google/changelog", {
    id: "antigravity_changelog", config: { allowUrlPrefixes: ["https://antigravity.google/"], publishedAtUtcOffset: "+00:00" },
  } as SourceRow);
  for (const url of ANTIGRAVITY) {
    const section = parsed.find((item) => item.url === url);
    const [row] = await sql<{ title: string; body_text: string | null; revision: number }[]>`
      SELECT title, body_text, revision FROM articles WHERE url = ${url}`;
    if (!section?.bodyText || !row?.body_text) throw new Error(`changelog 没有这一节 ${url}`);
    if (section.bodyText !== row.body_text) throw new Error(`已存正文和 changelog 节不一致 ${url}`);
    const written = await writeSection({
      sourceId: "antigravity_changelog", url, title: row.title, bodyText: row.body_text,
      bytes: changelog, fileSha: CHANGELOG_SHA,
      raw: {
        role: "listing_section",
        responseSha256: CHANGELOG_SHA,
        timeSource: "changelog-heading",
        publicationPrecision: "date_only",
        detailHubSha256: HUB_SHA,
        detailHubSectionChars: 0,
      },
    });
    notes.set(url, {
      v3Change: "changelog_section_evidenced",
      newRequest: false,
      sourceEmpty: false,
      detailHubSectionChars: 0,
      detailHubSha256: HUB_SHA,
      bodyBound: "listing_section",
      sectionLength: row.body_text.length,
      revisionBefore: row.revision,
      bodyUnchanged: written.revision === row.revision,
      evidence: {
        version: written.evidenceVersion,
        evidenceHash: written.evidenceHash,
        articleRevision: written.revision,
        fileSha256: written.fileSha,
        matchesResponse: true,
        bodyLength: row.body_text.length,
        revisedArticle: written.revisedArticle,
      },
    });
  }

  const [codex] = await sql<{ title: string; revision: number; body_text: string | null; raw: Record<string, unknown> | null; source_updated_at: Date | null }[]>`
    SELECT title, revision, body_text, raw, source_updated_at FROM articles WHERE url = ${CODEX_URL}`;
  if (!codex || codex.body_text !== null || codex.revision !== 1) throw new Error("Codex alpha.13 不是原来未绑定的那一条");
  const codexWritten = await writeSection({
    sourceId: "openai_codex_github_releases", url: CODEX_URL, title: codex.title, bodyText: CODEX_BODY,
    bytes: codexJson, fileSha: CODEX_SHA, publishedAt: "2026-11-18T05:47:55.000Z",
    raw: {
      ...(codex.raw ?? {}),
      listingTimeSource: codex.raw?.timeSource ?? "atom:updated",
      role: "detail_json",
      timeSource: "json:published_at",
      publicationPrecision: "datetime",
      published_at: "2026-11-18T05:47:55Z",
      responseSha256: CODEX_SHA,
      sourceShort: true,
    },
  });
  const [codexRow] = await sql<{ published_at: Date | null; publication_time: string | null; source_updated_at: Date | null; body_text: string }[]>`
    SELECT published_at, publication_time, source_updated_at, body_text FROM articles WHERE url = ${CODEX_URL}`;
  if (codexRow!.body_text !== CODEX_BODY) throw new Error("Codex 正文被改长了");
  if (codexRow!.source_updated_at?.toISOString() !== "2026-11-18T05:52:48.000Z") throw new Error("atom updated 没有留下");
  if (codexRow!.published_at?.toISOString() !== "2026-11-18T05:47:55.000Z") throw new Error("published_at 没有用官方 JSON");
  const [codexHistory] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM article_revisions r JOIN articles a ON a.id = r.article_id
    WHERE a.url = ${CODEX_URL} AND r.revision = 1 AND r.body_text IS NULL`;
  if (codexHistory!.n !== 1) throw new Error("原来未绑定的修订没有留下");
  notes.set(CODEX_URL, {
    v3Change: "saved_json_merged",
    newRequest: false,
    sourceEmpty: false,
    sourceShort: true,
    bodyBound: "detail_json",
    sectionLength: CODEX_BODY.length,
    bodyText: CODEX_BODY,
    publicationTime: codexRow!.publication_time,
    publicationPrecision: "datetime",
    timeSource: "json:published_at",
    listingTimeSource: "atom:updated",
    revisionBefore: 1,
    unboundHistoryKept: true,
    evidence: {
      version: codexWritten.evidenceVersion,
      evidenceHash: codexWritten.evidenceHash,
      articleRevision: codexWritten.revision,
      fileSha256: codexWritten.fileSha,
      matchesResponse: true,
      bodyLength: CODEX_BODY.length,
      revisedArticle: codexWritten.revisedArticle,
    },
  });

  if (await articleCount() !== 40) throw new Error("分母变了");
  if (!Array.isArray(v2.items) || v2.items.length !== 40) throw new Error("v2 清单不是 40 条");
  const items = [];
  for (const item of v2.items) {
    const note = notes.get(item.url);
    items.push(note ? { ...item, ...note } : { ...item, v3Change: "carried", newRequest: false, sourceEmpty: false });
  }
  const counts = {
    carried: items.filter((item) => item.v3Change === "carried").length,
    articleLocated: items.filter((item) => item.v3Change === "article_located").length,
    changelogSectionEvidenced: items.filter((item) => item.v3Change === "changelog_section_evidenced").length,
    savedJsonMerged: items.filter((item) => item.v3Change === "saved_json_merged").length,
    sourceEmpty: items.filter((item) => item.sourceEmpty).length,
    withEvidence: items.filter((item) => item.evidence).length,
  };
  const sum = counts.carried + counts.articleLocated + counts.changelogSectionEvidenced + counts.savedJsonMerged + counts.sourceEmpty;
  if (sum !== 40 || counts.withEvidence !== 40) throw new Error(`40 状态加不齐 ${JSON.stringify(counts)}`);
  const manifest = {
    asOf, basedOn: "public-sample-v2", v2AsOf: v2.asOf, frozenV1Unchanged: true, frozenV2Unchanged: true,
    database, newRequests: 0, scores: null, decisions: null, labels: null,
    workerStarted: false, modelCalls: 0, socialDataUsd: 0, paid: false,
    denominator: 40, counts, items,
  };
  mkdirSync(`${PACK}/bytes`, { recursive: true });
  writeFileSync(`${PACK}/bytes/${MISTRAL_SHA}.bin`, mistralHtml);
  writeFileSync(`${PACK}/bytes/${CHANGELOG_SHA}.bin`, changelog);
  writeFileSync(`${PACK}/bytes/${CODEX_SHA}.bin`, codexJson);
  writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  writeFileSync(`${PACK}/MANIFEST.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, asOf, database, counts, newRequests: 0 }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => undefined);
  await closeDb();
}
