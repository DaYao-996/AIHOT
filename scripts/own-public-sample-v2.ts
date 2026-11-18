// Detail reads for the 32 public-v1 rows that had no detail. Does not rewrite that pack.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { type SourceRow } from "@aihot/backend/sources/types";
import { appendControlledEvidence } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const V1 = "docs/own-pipeline/PUBLIC_SAMPLE_v1.json";
const OUT = "docs/own-pipeline/PUBLIC_SAMPLE_v2.json";
const PACK = "/tmp/public-sample-v2";
const WHOLE_PAGE = 20000;

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function slug(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.get("version")) return `version:${u.searchParams.get("version")}`;
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? url;
  } catch {
    return url;
  }
}

function seriesOf(source: string, url: string): string | null {
  if (source === "claude_code_releases") return "claude-code-releases";
  if (source === "openai_codex_github_releases") return "codex-releases";
  if (source === "antigravity_changelog") return "antigravity-changelog";
  return null;
}

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
  const v1 = JSON.parse(readFileSync(V1, "utf8"));
  const asOf = new Date().toISOString();
  mkdirSync(`${PACK}/bytes`, { recursive: true });
  let detailRequests = 0;
  const items = [];
  for (const source of v1.sources) {
    for (const row of source.denominator) {
      const base = {
        source: source.source, url: row.url, title: row.title,
        listingPublicationTime: row.publicationTime, listingTimeSource: row.timeSource,
        listingPublicationPrecision: row.publicationPrecision, listingBodyStatus: row.bodyStatus,
        listingBodyLength: row.bodyLength, overlap: row.overlap,
        alsoInSampleV16: row.alsoInSampleV16 ?? false, alsoIn0815StoredRows: row.alsoIn0815StoredRows ?? false,
        eventKey: slug(row.url), series: seriesOf(source.source, row.url),
      };
      if (row.url === source.sampleUrl) {
        items.push({ ...base, detailFrom: "v1", v2Request: false, bodyBound: source.bodyBoundTo, evidence: source.evidence, detail: source.detail });
        continue;
      }
      detailRequests += 1;
      const githubRelease = row.url.includes("github.com/") && row.url.includes("/releases/tag/");
      const config = githubRelease ? { detail: { bodySelector: ".markdown-body" } } : {};
      const sourceRow = {
        id: source.source, name: source.source, kind: "rss", tier: "C", participation_mode: "isolated", uses: [],
        interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0, config,
      } as SourceRow;
      try {
        const got = await fetchDetail(row.url, sourceRow, { date: true, title: false, summary: false, body: true });
        const bytes = got.response?.bytes ?? null;
        const fileSha = bytes ? sha(bytes) : null;
        if (bytes && fileSha) writeFileSync(`${PACK}/bytes/${fileSha}.bin`, bytes);
        const via = got.body?.via ?? null;
        const section = got.body?.text ?? null;
        const wholePage = via !== "text" && (!section || got.response?.truncated === true || section.length > WHOLE_PAGE);
        const sourceShort = via === "text" && !!section && section.length < 200;
        let evidence = null;
        let revision: { before: number | null; after: number | null } | null = null;
        if (!wholePage && section && bytes && fileSha) {
          const [before] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE url = ${row.url} AND source_id = ${source.source}`;
          const written = await appendControlledEvidence({
            sourceId: source.source, url: row.url, title: row.title,
            raw: { role: via === "text" ? "detail_selector" : "detail_section", responseSha256: fileSha },
            bodyText: section, rawFileBase64: bytes.toString("base64"), rawFileSha256: fileSha,
          });
          const [check] = await sql<{ file_sha: string; revision: number }[]>`
            SELECT encode(sha256(v.raw_file), 'hex') AS file_sha, a.revision
            FROM own_evidence_versions v JOIN articles a ON a.id = v.article_id
            WHERE v.article_id = ${written.articleId} AND v.version = ${written.evidenceVersion}`;
          revision = { before: before?.revision ?? null, after: check?.revision ?? null };
          evidence = {
            version: written.evidenceVersion, evidenceHash: written.evidenceHash, articleRevision: written.articleRevision,
            fileSha256: check?.file_sha ?? null, matchesResponse: check?.file_sha === fileSha, bodyLength: section.length,
          };
        }
        items.push({
          ...base, detailFrom: "v2", v2Request: true, status: got.response?.status ?? null,
          finalUrl: got.response?.url ?? null, requests: got.response?.requests ?? 1,
          byteLength: bytes?.length ?? 0, sha256: fileSha, truncated: got.response?.truncated ?? false,
          sectionLength: section?.length ?? 0, sectionVia: via, wholePageRejected: wholePage, sourceShort,
          publicationTime: got.publicationTime, publicationPrecision: !got.publicationTime ? "unknown" : got.publicationTime.length === 10 ? "date_only" : "datetime",
          bodyBound: evidence ? (via === "text" ? "detail_selector" : "detail_section") : "none",
          evidence, revision,
        });
      } catch (error) {
        const status = error instanceof HttpStatusError ? error.status : null;
        items.push({
          ...base, detailFrom: "v2", v2Request: true, status, requests: 1,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          bodyBound: "none", evidence: null, wholePageRejected: false, sourceShort: false,
        });
      }
    }
  }
  const events = new Map<string, string[]>();
  for (const item of items) {
    if (!String(item.source).startsWith("apple_newsroom_")) continue;
    const list = events.get(item.eventKey) ?? [];
    list.push(`${item.source} ${item.url}`);
    events.set(item.eventKey, list);
  }
  const sameEvents = [...events.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ eventKey: key, rows }));
  const manifest = {
    asOf, basedOn: "public-sample-v1", v1AsOf: v1.asOf, frozenV1Unchanged: true,
    database: new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""),
    scores: null, decisions: null, labels: null, workerStarted: false, modelCalls: 0, socialDataUsd: 0, paid: false,
    denominator: items.length, v2DetailRequests: detailRequests,
    boundBodies: items.filter((item) => item.evidence).length,
    failedOrEmpty: items.filter((item) => item.detailFrom === "v2" && !item.evidence).length,
    sameEvents, items,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  writeFileSync(`${PACK}/MANIFEST.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    ok: true, asOf, denominator: items.length, requests: detailRequests,
    bound: manifest.boundBodies, unbound: manifest.failedOrEmpty, sameEvents: sameEvents.length,
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
