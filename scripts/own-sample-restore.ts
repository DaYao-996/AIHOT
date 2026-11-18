// Rebuild the isolated 15-article sample into an empty temporary database. No fetch and no model call.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import { runMigrations } from "./migrate.ts";
import { assertThrowawayDatabase, cliEntryAllowed } from "../site/own-pipeline.ts";

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag >= 0 ? process.argv[dirFlag + 1] : "";

function readJson(name: string) {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  if (!dir) throw new Error("usage: node scripts/own-sample-restore.ts --dir <pack>");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new Error(`外发或模型开关打开，拒绝恢复：${gate.outboundIfWorker.join(",")}`);
  const manifest = readJson("MANIFEST.json");
  await runMigrations(sql, REPO_ROOT);
  const [existing] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE url IN ${sql(manifest.urls)}`;
  if (existing!.n > 0) throw new Error("目标库里已经有这批 url，拒绝覆盖");
  const sources = readJson("sources.json") as Record<string, unknown>[];
  for (const source of sources) {
    await sql`INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, interval_minutes, site_fulltext, syndicate_fulltext, enabled, health, fail_count, uses)
      VALUES (${source.id as string}, ${source.name as string}, ${source.kind as string}, ${sql.json(source.config as never)},
        ${sql.array((source.tags as string[]) ?? [])}::text[], ${source.tier as string}, ${source.participation_mode as string}, ${source.interval_minutes as number},
        ${source.site_fulltext as boolean}, ${source.syndicate_fulltext as boolean}, false, 'unknown', 0, ${sql.array((source.uses as string[]) ?? [])}::text[])`;
  }
  const articles = readJson("articles.json") as Record<string, unknown>[];
  for (const article of articles) {
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, author, language, published_at, published_at_claim, discovered_at,
        source_updated_at, timeline_at, backfill, backfill_reason, revision, content_hash, excerpt, body_text, body_html, body_status, media, x_post, raw,
        created_at, updated_at, processing_state, processing_attempts, grouping_status, publication_time, cover)
      VALUES (${article.id as string}, ${article.source_id as string}, ${article.identity_key as string}, ${article.url as string}, ${article.title as string},
        ${article.author as string | null}, ${article.language as string | null}, ${article.published_at as string | null}, ${article.published_at_claim as string | null},
        ${article.discovered_at as string}, ${article.source_updated_at as string | null}, ${article.timeline_at as string}, ${article.backfill as boolean},
        ${article.backfill_reason as string | null}, ${article.revision as number}, ${article.content_hash as string | null}, ${article.excerpt as string | null},
        ${article.body_text as string | null}, ${article.body_html as string | null}, ${article.body_status as string}, ${sql.json(article.media as never)},
        ${article.x_post ? sql.json(article.x_post as never) : null}, ${article.raw ? sql.json(article.raw as never) : null}, ${article.created_at as string},
        ${article.updated_at as string}, ${article.processing_state as string}, ${article.processing_attempts as number}, ${article.grouping_status as string},
        ${article.publication_time as string | null}, ${article.cover ? sql.json(article.cover as never) : null})`;
  }
  for (const revision of readJson("article_revisions.json") as Record<string, unknown>[]) {
    await sql`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text, created_at)
      VALUES (${revision.article_id as string}, ${revision.revision as number}, ${revision.content_hash as string}, ${revision.title as string},
        ${revision.body_text as string | null}, ${revision.created_at as string})`;
  }
  const evidence = readFileSync(path.join(dir, "evidence.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const row of evidence) {
    const fileSha = row.raw_file_sha256 as string | null;
    const bytes = fileSha ? readFileSync(path.join(dir, "bytes", `${fileSha}.bin`)) : null;
    if (bytes && sha256(bytes) !== fileSha) throw new Error(`原件哈希不符：${fileSha}`);
    await sql`INSERT INTO own_evidence_versions (article_id, version, article_revision, raw, body_text, quoted_text, x_post, evidence_hash, created_at, raw_identity, raw_file, body_gate)
      VALUES (${row.article_id as string}, ${row.version as number}, ${row.article_revision as number}, ${row.raw ? sql.json(row.raw as never) : null},
        ${row.body_text as string | null}, ${row.quoted_text as string | null}, ${row.x_post ? sql.json(row.x_post as never) : null}, ${row.evidence_hash as string},
        ${row.created_at as string}, ${row.raw_identity ? sql.json(row.raw_identity as never) : null}, ${bytes}, ${row.body_gate ? sql.json(row.body_gate as never) : null})`;
  }
  for (const row of readJson("judgments.json") as Record<string, unknown>[]) {
    await sql`INSERT INTO own_judgments (id, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
        information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons, recorded_at, created_at, stale, comparison, model_receipt_id)
      VALUES (${row.id as string}, ${row.article_id as string}, ${row.input_revision as number}, ${row.evidence_hash as string}, ${row.ruleset_version as string},
        ${row.prompt_version as string}, ${row.model_version as string}, ${row.information_type_id as string | null}, ${row.content_line as string | null},
        ${row.material_status as string}, ${row.fact_status as string}, ${row.value_status as string}, ${row.release_status as string}, ${row.origin as string},
        ${sql.json(row.reasons as never)}, ${row.recorded_at as string}, ${row.created_at as string}, ${row.stale as boolean},
        ${row.comparison ? sql.json(row.comparison as never) : null}, ${row.model_receipt_id as number | null})`;
  }
  const expected = (readJson("judgments.json") as { origin?: string; stale?: boolean }[]).reduce((acc, row) => {
    if (row.origin === "file" && row.stale) acc.stale += 1;
    else if (row.origin === "file") acc.live += 1;
    return acc;
  }, { live: 0, stale: 0 });
  const check = await sql<{ articles: number; evidence: number; live_file: number; stale_file: number; publications: number; bad_files: number }[]>`
    WITH sample AS (SELECT id FROM articles WHERE url IN ${sql(manifest.urls)})
    SELECT (SELECT count(*)::int FROM sample) AS articles,
      (SELECT count(*)::int FROM own_evidence_versions WHERE article_id IN (SELECT id FROM sample)) AS evidence,
      (SELECT count(*)::int FROM own_judgments WHERE article_id IN (SELECT id FROM sample) AND origin = 'file' AND stale = false) AS live_file,
      (SELECT count(*)::int FROM own_judgments WHERE article_id IN (SELECT id FROM sample) AND origin = 'file' AND stale = true) AS stale_file,
      (SELECT count(*)::int FROM publications WHERE article_id IN (SELECT id FROM sample)) AS publications,
      (SELECT count(*)::int FROM own_evidence_versions WHERE article_id IN (SELECT id FROM sample) AND raw_file IS NOT NULL AND encode(sha256(raw_file), 'hex') IS DISTINCT FROM raw_identity->>'fileSha256' AND raw_identity->>'fileSha256' IS NOT NULL) AS bad_files`;
  const hashes = await sql<{ evidence_hash: string }[]>`SELECT evidence_hash FROM own_evidence_versions WHERE evidence_hash IN (
    '2218f60dd21c55a73a114dc306dde755f1d4147e0203a2cc0daf117e899eae08',
    '21703cd0976fc9f5ed7a513777dcc12b60ca258cfb19eb2a0de88da680bfbc53',
    'ccf86ee64a4fd770be2dddc35d29800550a40fc0c4bce540710ae957c60eaf10',
    '56aaaa234b339551a95ba231083ead7b029c0179d470bb8608b213d91449a843')`;
  const jobs = await sql<{ n: number | null }[]>`SELECT to_regclass('public.pgboss.job') IS NOT NULL AS n`.catch(() => [{ n: null }]);
  console.log(JSON.stringify({
    ok: check[0]!.articles === manifest.counts.articles && check[0]!.evidence === manifest.counts.evidence && check[0]!.live_file === expected.live && check[0]!.stale_file === expected.stale && check[0]!.publications === 0 && check[0]!.bad_files === 0,
    ...check[0],
    boundHashesFound: hashes.length,
    queueTable: jobs[0]?.n ?? null,
    fetched: false,
    modelCalled: false,
    notRecovered: manifest.notRecovered,
  }));
}

try { await main(); } finally { await closeDb(); }
