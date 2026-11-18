// Apply the reviewed source contract to a throwaway run. No new source research, no paid X or model calls.
import { writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { HttpStatusError, guardedFetch } from "@aihot/backend/lib/http-fetch";
import { collectSource, scheduleDueSources } from "@aihot/backend/sources/collect";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_v6_test", "own_public_sample_v9_test", "own_public_sample_v9_change_test",
  "own_chain_aside_v10_test", "own_chain_store_v11_test", "own_chain_bind_v12_test", "own_draft_first_v12_test",
]);

type Row = Record<string, unknown>;

function configFor(row: Row): { kind: "rss" | "web_list" | "json_list"; config: Record<string, unknown> } | null {
  const id = String(row.source_id ?? "");
  const endpoint = String(row.endpoint ?? "").trim();
  const type = String(row.source_type ?? "");
  if (!endpoint.startsWith("http")) return null;
  if (id === "antigravity_changelog") return { kind: "web_list", config: { url: endpoint, parseMode: "antigravity_changelog", publishedAtUtcOffset: "+00:00", _aihot: { initialBackfillLimit: 2 } } };
  if (type === "rss" || endpoint.endsWith(".xml") || endpoint.endsWith(".rss") || endpoint.includes("/rss") || endpoint.endsWith(".atom")) {
    return { kind: "rss", config: { feedUrl: endpoint, _aihot: { initialBackfillLimit: 2 } } };
  }
  if (id === "hf_models_trending") return { kind: "json_list", config: { url: endpoint, titlePaths: ["id"], urlTemplate: "https://huggingface.co/{id}", publishedAtPath: "createdAt", summaryPaths: ["pipeline_tag"], _aihot: { initialBackfillLimit: 2 } } };
  if (id === "hf_daily_papers") return { kind: "json_list", config: { url: endpoint, titlePaths: ["title"], urlTemplate: "https://huggingface.co/papers/{paper.id}", publishedAtPath: "publishedAt", summaryPaths: ["paper.summary"], _aihot: { initialBackfillLimit: 2 } } };
  if (type === "github-trending" || id.startsWith("github_trending")) return { kind: "web_list", config: { url: endpoint, parseMode: "html", itemSelector: "article.Box-row", linkSelector: "h2 a", titleSelector: "h2 a", _aihot: { initialBackfillLimit: 2 } } };
  return null;
}

function plan(row: Row): string {
  if (row.roster_family === "X174_historical") return "x_unverified_no_free_api";
  const role = String(row.historical_role ?? "");
  if (!["operational", "required"].includes(role)) return "role_not_auto_enabled";
  if (!String(row.endpoint ?? "").trim().startsWith("http")) return "no_endpoint";
  if (!configFor(row)) return "adapter_pending";
  return "collect";
}

const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unset").pathname.replace(/^\//, "");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (FROZEN.has(database)) throw new Error("这是已冻结的库");
if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
const contractPath = process.argv.includes("--contract") ? process.argv[process.argv.indexOf("--contract") + 1]! : "/tmp/source-contract/SOURCE_CONTRACT_v1.json";
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : "docs/own-pipeline/contract-run-v13/LEDGER.json";
const contract = JSON.parse(await (await import("node:fs")).readFileSync(contractPath, "utf8")) as { sources: Row[] };
const gaps = JSON.parse(await (await import("node:fs")).readFileSync("/tmp/source-contract/MINIMUM_ACTIONABLE_GAPS_v2.json", "utf8")) as {
  agreed_nonx_no_sample_proof_across_both_records: Array<{ source_id: string; meaning: string }>;
};
const priorGap = new Map(gaps.agreed_nonx_no_sample_proof_across_both_records.map((gap) => [gap.source_id, gap.meaning]));

try {
  const ledger = [];
  let replay: Record<string, unknown> | null = null;
  for (const row of contract.sources) {
    const id = String(row.source_id ?? row.handle ?? row.contract_id);
    const action = plan(row);
    const base = {
      sourceId: id, contractId: row.contract_id, role: row.historical_role, usage: row.upstream_usage,
      daily132: row.in_frozen_daily132 === true, intervalMinutes: row.frequency_minutes_historical ?? null,
      enabled: false, action, priorGap: priorGap.get(String(row.source_id ?? "")) ?? null,
    };
    if (action !== "collect") {
      ledger.push({ ...base, status: "not_run", requests: 0, found: 0, created: 0, bodyItems: 0, evidenceRows: 0, zeroReason: action, retryable: false });
      continue;
    }
    const mapped = configFor(row)!;
    const historicalInterval = Number(row.frequency_minutes_historical ?? 1440);
    const intervalMinutes = Math.min(1440, Math.max(1, historicalInterval));
    await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, interval_minutes, site_fulltext, syndicate_fulltext, next_fetch_at)
      VALUES (${id}, ${String(row.name ?? id)}, ${mapped.kind}, 'editorial', ${sql.json(mapped.config)}, false, ${intervalMinutes}, false, false, '2100-01-01')
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, kind = EXCLUDED.kind, participation_mode = 'editorial', enabled = false, site_fulltext = false`;
    let result: { status: string; found: number; created: number; revised: number; error?: string };
    try { result = await collectSource(id, { force: true }); }
    catch (error) { result = { status: "failed", found: 0, created: 0, revised: 0, error: error instanceof Error ? error.message.slice(0, 240) : String(error) }; }
    const [counts] = await sql<{ articles: number; bodies: number; evidence: number }[]>`
      SELECT count(*)::int AS articles,
             count(*) FILTER (WHERE length(body_text) > 0)::int AS bodies,
             (SELECT count(*)::int FROM own_evidence_versions v WHERE v.article_id IN (SELECT id FROM articles WHERE source_id = ${id})) AS evidence
      FROM articles WHERE source_id = ${id}`;
    const [run] = await sql<{ status: string; error: string | null; detail: Row | null }[]>`
      SELECT status, error, detail FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`;
    const httpStatus = run?.detail?.response && typeof run.detail.response === "object" ? (run.detail.response as Row).httpStatus ?? null : null;
    const detailAttempts = Number(run?.detail?.detailAttempts ?? 0);
    const detailRefused = Array.isArray(run?.detail?.detailErrors) ? (run!.detail!.detailErrors as unknown[]).length : 0;
    const retryable = /429|5\d\d|timeout|ECONN|fetch failed/i.test(result.error ?? "");
    const forbidden = /403|401/.test(`${result.error ?? ""} ${httpStatus ?? ""}`);
    const articles = counts?.articles ?? 0;
    const evidence = counts?.evidence ?? 0;
    ledger.push({
      ...base, status: result.status, httpStatus, detailAttempts, requests: 1 + detailAttempts, found: result.found, created: result.created, revised: result.revised,
      intervalStored: intervalMinutes, intervalClamped: historicalInterval !== intervalMinutes,
      error: result.error ?? null, articles, bodyItems: counts?.bodies ?? 0, evidenceRows: evidence,
      zeroReason: articles > 0 ? null : forbidden ? "http_forbidden" : result.status === "failed" ? "fetch_failed" : detailRefused ? "detail_refused" : "no_items",
      evidenceReason: evidence > 0 ? "aside_written_by_storeCollected" : articles === 0 ? null : detailAttempts === 0 ? "listing_had_no_page_read" : "page_read_had_no_aside",
      retryable: retryable && !forbidden,
    });
    if (!replay && result.status === "ok" && result.found > 0) {
      const second = await collectSource(id, { force: true });
      await sql`UPDATE sources SET enabled = true WHERE id = ${id}`;
      const settled = await collectSource(id);
      await sql`UPDATE sources SET enabled = false, next_fetch_at = '2100-01-01' WHERE id = ${id}`;
      const [again] = await sql<{ articles: number }[]>`SELECT count(*)::int AS articles FROM articles WHERE source_id = ${id}`;
      ledger[ledger.length - 1]!.articles = again?.articles ?? ledger[ledger.length - 1]!.articles;
      replay = {
        sourceId: id,
        backfillRemainder: { found: second.found, created: second.created, revised: second.revised, status: second.status },
        settled: { found: settled.found, created: settled.created, revised: settled.revised, status: settled.status },
      };
    }
  }
  for (const row of ledger) {
    if (row.action !== "collect") continue;
    const [pending] = await sql<{ id: string; url: string }[]>`
      SELECT id, url FROM articles WHERE source_id = ${String(row.sourceId)} AND body_status <> 'ok'
      ORDER BY published_at DESC NULLS LAST LIMIT 1`;
    if (!pending) {
      row.pageRead = null;
      if (Number(row.bodyItems) > 0 && Number(row.evidenceRows) === 0) row.evidenceReason = "feed_body_present_aside_not_attached";
      continue;
    }
    const page = await extractArticleBody(pending.id, { paidFallback: false });
    let pageStatus: number | null = null;
    if (page === "unconfirmed") {
      try {
        const res = await guardedFetch(pending.url, { timeoutMs: 15_000, maxBytes: 2048 });
        pageStatus = res.status;
      } catch (error) {
        pageStatus = error instanceof HttpStatusError ? error.status : null;
        row.pageError = error instanceof Error ? error.message.slice(0, 180) : String(error);
      }
    }
    const [after] = await sql<{ bodies: number; evidence: number; bodyLength: number }[]>`
      SELECT count(*) FILTER (WHERE length(body_text) > 0)::int AS bodies,
             (SELECT count(*)::int FROM own_evidence_versions v WHERE v.article_id IN (SELECT id FROM articles WHERE source_id = ${String(row.sourceId)})) AS evidence,
             coalesce((SELECT length(body_text) FROM articles WHERE id = ${pending.id}), 0)::int AS "bodyLength"
      FROM articles WHERE source_id = ${String(row.sourceId)}`;
    row.pageRead = { articleId: pending.id, url: pending.url, result: page, httpStatus: pageStatus, bodyLength: after?.bodyLength ?? 0, paidFallback: false };
    if (pageStatus === 401 || pageStatus === 403) row.retryable = false;
    if (page === "unconfirmed" && /too large/i.test(String(row.pageError ?? ""))) {
      row.evidenceReason = "response_too_large_not_bypassed";
      row.retryable = false;
    }
    row.bodyItems = after?.bodies ?? row.bodyItems;
    row.evidenceRows = after?.evidence ?? row.evidenceRows;
    row.requests = Number(row.requests ?? 0) + 1;
    if (page === "unconfirmed") row.zeroReason = row.articles ? null : "page_unconfirmed";
    row.evidenceReason = (after?.evidence ?? 0) > 0 ? "aside_written_by_extractArticleBody" : page === "unconfirmed" ? "page_unconfirmed_no_jina" : "page_had_no_aside";
    if ((after?.bodies ?? 0) > (after?.evidence ?? 0) && page !== "unconfirmed") row.feedBodiesWithoutAside = (after?.bodies ?? 0) - (after?.evidence ?? 0);
  }
  const runnable = ledger.find((row) => row.action === "collect" && row.status === "ok");
  let schedule: Record<string, unknown> | null = null;
  if (runnable) {
    await sql`UPDATE sources SET enabled = true, next_fetch_at = now() - interval '1 minute' WHERE id = ${String(runnable.sourceId)}`;
    const due = await scheduleDueSources();
    const [still] = await sql<{ enabled: number }[]>`SELECT count(*)::int AS enabled FROM sources WHERE enabled AND id <> ${String(runnable.sourceId)}`;
    schedule = { dueSource: runnable.sourceId, enqueued: due.enqueued, shards: due.shards, otherEnabled: still?.enabled ?? null, workerStarted: false };
    await sql`UPDATE sources SET enabled = false, next_fetch_at = '2100-01-01'`;
  }
  await sql`DELETE FROM pgboss.job`;
  await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL`;
  const [totals] = await sql<{ publications: number; deliveries: number; receipts: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications,
           (SELECT count(*)::int FROM deliveries) AS deliveries,
           (SELECT count(*)::int FROM receipts) AS receipts`;
  const report = {
    database, contract: "SOURCE_CONTRACT_v1", network: "free_public_only", paidX: false, modelCalls: 0,
    integration: "collectSource and collectXShard call storeCollected; scheduleDueSources only enqueues fetchSource. This run called collectSource and scheduleDueSources and did not start a worker. extractArticleBody now records the page aside through recordCollectedEvidence after the body commit. One unpaid page was read only when the listing had no body, with paid fallback off.",
    counts: {
      rows: ledger.length,
      dailyX: ledger.filter((row) => row.daily132).length,
      xUnverified: ledger.filter((row) => row.action === "x_unverified_no_free_api").length,
      notAuto: ledger.filter((row) => row.action === "role_not_auto_enabled").length,
      collected: ledger.filter((row) => row.action === "collect").length,
    },
    replay, schedule, publications: totals?.publications ?? null, deliveries: totals?.deliveries ?? null, receipts: totals?.receipts ?? null,
    rows: ledger,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, ...report.counts, replay, schedule, publications: report.publications }));
} finally {
  await stopBoss();
  await closeDb();
}
