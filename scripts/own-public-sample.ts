// One isolated public sample. Listing through collectSource, one detail through fetchDetail.
// No worker left running, no model, no SocialData. Does not touch the nine-article database.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { type SourceRow } from "@aihot/backend/sources/types";
import { appendControlledEvidence } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const OUT = "docs/own-pipeline/PUBLIC_SAMPLE_v1.json";
const PACK = "/tmp/public-sample-v1";
const BATCH = 5;
const WHOLE_PAGE = 20000;
const SOURCES: Array<{ id: string; name: string; kind: "rss" | "web_list"; config: Record<string, unknown> }> = [
  { id: "nvidia_developer_blog", name: "NVIDIA Developer Blog", kind: "rss", config: { feedUrl: "https://developer.nvidia.com/blog/feed/" } },
  { id: "deepmind_blog", name: "DeepMind Blog", kind: "rss", config: { feedUrl: "https://deepmind.google/blog/rss.xml" } },
  { id: "mistral_news", name: "Mistral News", kind: "rss", config: { feedUrl: "https://mistral.ai/news/rss" } },
  { id: "apple_newsroom_cn", name: "Apple Newsroom CN", kind: "rss", config: { feedUrl: "https://www.apple.com.cn/newsroom/rss-feed.rss" } },
  { id: "apple_newsroom_us_rss", name: "Apple Newsroom US", kind: "rss", config: { feedUrl: "https://www.apple.com/newsroom/rss-feed.rss" } },
  { id: "claude_code_releases", name: "Claude Code releases", kind: "rss", config: { feedUrl: "https://github.com/anthropics/claude-code/releases.atom" } },
  { id: "openai_codex_github_releases", name: "Codex releases", kind: "rss", config: { feedUrl: "https://github.com/openai/codex/releases.atom" } },
  { id: "antigravity_changelog", name: "Antigravity changelog", kind: "web_list", config: { url: "https://antigravity.google/docs/changelog.md", parseMode: "antigravity_changelog", publishedAtUtcOffset: "+00:00" } },
];

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function oldNine() {
  const articles = JSON.parse(readFileSync("docs/own-pipeline/sample-restore-v16/articles.json", "utf8")) as Array<{ id: string; url: string; body_text: string | null }>;
  const judgments = JSON.parse(readFileSync("docs/own-pipeline/sample-restore-v16/judgments.json", "utf8")) as Array<{ article_id: string; origin: string }>;
  const ids = new Set(judgments.filter((row) => row.origin === "file").map((row) => row.article_id));
  const rows = articles.filter((row) => ids.has(row.id));
  return {
    urls: new Set(rows.map((row) => row.url)),
    bodies: new Set(rows.filter((row) => row.body_text).map((row) => sha256(row.body_text!))),
  };
}

function precision(value: string | null): "datetime" | "date_only" | "unknown" {
  if (!value) return "unknown";
  return value.length === 10 ? "date_only" : "datetime";
}

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
  const asOf = new Date().toISOString();
  const prior = oldNine();
  mkdirSync(`${PACK}/bytes`, { recursive: true });
  const requests = { listing: 0, detail: 0 };
  const sources = [];
  for (const spec of SOURCES) {
    const config = { ...spec.config, _aihot: { initialBackfillLimit: BATCH } };
    await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, interval_minutes, next_fetch_at)
      VALUES (${spec.id}, ${spec.name}, ${spec.kind}, 'isolated', ${sql.json(config)}, false, 1440, '2100-01-01')
      ON CONFLICT (id) DO NOTHING`;
    const collected = await collectSource(spec.id, { force: true });
    requests.listing += 1;
    const [run] = await sql<{ response: Buffer | null; raw_sha: string | null; http_status: number | null; reqs: number | null }[]>`
      SELECT response, detail->'response'->>'rawSha256' AS raw_sha,
        (detail->'response'->>'httpStatus')::int AS http_status,
        (detail->'response'->>'requests')::int AS reqs
      FROM fetch_runs WHERE source_id = ${spec.id} ORDER BY id DESC LIMIT 1`;
    const listing = run?.response ?? null;
    const listingSha = listing ? sha(listing) : null;
    const listingMatch = listingSha !== null && listingSha === run?.raw_sha;
    if (listing) writeFileSync(`${PACK}/bytes/${listingSha}.bin`, listing);
    const batch = await sql<{ id: string; url: string; title: string; publication_time: string | null; body_text: string | null; body_status: string; raw: { timeSource?: string; publicationPrecision?: string; updated?: string | null } }[]>`
      SELECT id, url, title, publication_time, body_text, body_status, raw FROM articles WHERE source_id = ${spec.id} ORDER BY discovered_at, id`;
    const considered = batch.map((row) => {
      const bodySha = sha256(row.body_text ?? "");
      const overlap = prior.urls.has(row.url) ? "url" : row.body_text && prior.bodies.has(bodySha) ? "identical_body" : null;
      return { ...row, bodySha, overlap };
    });
    const chosen = considered.find((row) => !row.overlap) ?? null;
    let detail: Record<string, unknown> | null = null;
    if (chosen) {
      const source: SourceRow = {
        id: spec.id, name: spec.name, kind: spec.kind, tier: "C", participation_mode: "isolated", uses: [],
        interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0, config,
      };
      requests.detail += 1;
      try {
        const got = await fetchDetail(chosen.url, source, { date: true, title: false, summary: true, body: true });
        const bytes = got.response?.bytes ?? null;
        const detailSha = bytes ? sha(bytes) : null;
        if (bytes && detailSha) writeFileSync(`${PACK}/bytes/${detailSha}.bin`, bytes);
        const section = got.body?.text ?? null;
        const wholePage = !section || got.response?.truncated === true || section.length > WHOLE_PAGE;
        const boundBody = !wholePage ? section : (chosen.body_text || null);
        const boundBytes = !wholePage && bytes ? bytes : listing;
        const boundSha = boundBytes ? sha(boundBytes) : null;
        const boundRole = !wholePage && bytes ? "detail_section" : chosen.body_text && listing ? "listing_section" : "unbound";
        let evidence = null;
        if (boundBytes && boundSha && boundBody) {
          const written = await appendControlledEvidence({
            sourceId: spec.id, url: chosen.url, title: chosen.title,
            raw: { role: boundRole, responseSha256: boundSha, timeSource: chosen.raw?.timeSource ?? "unknown" },
            bodyText: boundBody,
            rawFileBase64: boundBytes.toString("base64"),
            rawFileSha256: boundSha,
          });
          const [check] = await sql<{ file_sha: string; body_len: number }[]>`
            SELECT encode(sha256(raw_file), 'hex') AS file_sha, length(body_text)::int AS body_len
            FROM own_evidence_versions WHERE article_id = ${written.articleId} AND version = ${written.evidenceVersion}`;
          evidence = {
            version: written.evidenceVersion, evidenceHash: written.evidenceHash, articleRevision: written.articleRevision,
            fileSha256: check?.file_sha ?? null, matchesResponse: check?.file_sha === boundSha, bodyLength: check?.body_len ?? 0,
          };
        }
        detail = {
          url: chosen.url, status: got.response?.status ?? null, finalUrl: got.response?.url ?? null,
          requests: got.response?.requests ?? 1, byteLength: bytes?.length ?? 0, sha256: detailSha,
          truncated: got.response?.truncated ?? null, sectionLength: section?.length ?? 0,
          sectionUsedAsBody: boundRole === "detail_section", wholePageRejected: wholePage,
          publicationTime: got.publicationTime, publicationPrecision: precision(got.publicationTime),
        };
        sources.push(itemReport(spec, collected, listingSha, listingMatch, run?.reqs ?? null, considered, chosen, boundRole, evidence, detail));
        continue;
      } catch (error) {
        const status = error instanceof HttpStatusError ? error.status : null;
        detail = { url: chosen.url, status, requests: 1, error: error instanceof Error ? error.message.slice(0, 300) : String(error), sectionUsedAsBody: false };
      }
    }
    sources.push(itemReport(spec, collected, listingSha, listingMatch, run?.reqs ?? null, considered, chosen, chosen?.body_text && listing ? "listing_only" : "none", null, detail));
  }
  await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL WHERE processing_state = 'new'`;
  const manifest = {
    asOf, database: new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""),
    program: "selection-rubric-draft-v2",
    programTarSha256: "66eb9f80d3e374e255e22335b2d034b12c8710e26c394fc2b6afbf7cb3a636f0",
    scores: null, decisions: null, labels: null,
    workerStarted: false, modelCalls: 0, socialDataUsd: 0, paid: false,
    requests, batchCap: BATCH, fullHistory: false,
    priorNineExcludedBy: "url or identical body",
    sources,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  writeFileSync(`${PACK}/MANIFEST.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, asOf, requests, sources: sources.map((row) => ({ id: row.source, found: row.foundInResponse, batch: row.denominator.length, new: row.newItems, detail: row.detailStatus, bound: row.bodyBoundTo, match: row.evidence?.matchesResponse ?? null })) }));
}

function itemReport(spec: { id: string }, collected: { status: string; found: number; error?: string }, listingSha: string | null, listingMatch: boolean, listingRequests: number | null, considered: Array<{ url: string; title: string; publication_time: string | null; body_status: string; body_text: string | null; overlap: string | null; raw: { timeSource?: string; publicationPrecision?: string } }>, chosen: { url: string; publication_time: string | null; body_status: string; body_text: string | null; raw: { timeSource?: string; publicationPrecision?: string } } | null, boundRole: string, evidence: { version: number; evidenceHash: string; articleRevision: number; fileSha256: string | null; matchesResponse: boolean; bodyLength: number } | null, detail: Record<string, unknown> | null) {
  return {
    source: spec.id,
    collectStatus: collected.status,
    foundInResponse: collected.found,
    notFullHistory: true,
    listingSha256: listingSha,
    listingHashMatchesStoredRun: listingMatch,
    listingRequests,
    denominator: considered.map((row) => ({
      url: row.url, title: row.title, publicationTime: row.publication_time, publicationPrecision: row.raw?.publicationPrecision ?? precision(row.publication_time),
      timeSource: row.raw?.timeSource ?? "unknown", bodyStatus: row.body_status, bodyLength: row.body_text?.length ?? 0, overlap: row.overlap,
    })),
    overlapExcluded: considered.filter((row) => row.overlap).length,
    newItems: considered.filter((row) => !row.overlap).length,
    sampleUrl: chosen?.url ?? null,
    bodyBoundTo: boundRole,
    evidence,
    detailStatus: detail?.status ?? null,
    detail,
    releaseBodyIsTheReleaseNotAProductUpdate: spec.id.endsWith("releases") || spec.id === "antigravity_changelog",
    fullPaper: false,
  };
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => undefined);
  await closeDb();
}
