// One regular read of each unique RSS endpoint in the 47 non-X draft.
// Kinds the stock collectors do not implement are recorded and not fetched.
// No worker, no model, no Jina, no SocialData. Sources stay disabled.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { FeedHttpError, fetchRss } from "@aihot/backend/sources/rss";
import { listingEntries } from "@aihot/backend/sources/collect";
import { fetchDetail, fetchWebList } from "@aihot/backend/sources/web-list";
import { type SourceRow } from "@aihot/backend/sources/types";
import { UnavailablePageError } from "@aihot/backend/lib/page-content";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const PRIOR = new Set(["openai_news", "google_ai_blog", "huggingface_blog", "claude_platform_release_notes", "openai_codex_github_releases"]);
const OUT = process.argv[2] ?? "docs/own-pipeline/SOURCE_COVERAGE_v1.json";

function classifyFailure(status: number | null, message: string): string {
  const text = message.toLowerCase();
  if (status === 401 || status === 403) return "http_forbidden";
  if (status === 429) return "http_limited";
  if (/captcha|cloudflare|challenge|just a moment|attention required|access denied/.test(text)) return "challenge";
  if (/sign-in|login|unavailable-in-region|paywall/.test(text)) return "blocked_or_login";
  if (status && status >= 400) return `http_${status}`;
  if (/not an rss|parse error|no items matched/.test(text)) return "parse_failed";
  return "fetch_failed";
}

function sourceRow(id: string, name: string, kind: SourceRow["kind"], config: SourceRow["config"]): SourceRow {
  return {
    id, name, kind, tier: "C", participation_mode: "isolated", uses: [],
    interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0, config,
  };
}

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") {
    throw new Error("采集或模型开关开着，拒绝这次覆盖");
  }
  const draft = JSON.parse(readFileSync("docs/own-pipeline/SOURCE_DRAFT_v1.json", "utf8"));
  const rows = draft.nonx as Array<Record<string, unknown>>;
  if (rows.length !== 47) throw new Error(`草案非 X 不是 47 条：${rows.length}`);
  const seenEndpoint = new Map<string, string>();
  let freeGets = 0;
  const report = [];
  for (const row of rows) {
    const id = String(row.source_id);
    const endpoint = String(row.endpoint ?? "").trim();
    const kind = String(row.kind_hint ?? "");
    const base = {
      source_id: id, name: row.name, kind_hint: kind, endpoint: endpoint || null,
      historical_availability: row.availability, duplicate_endpoint: row.duplicate_endpoint === true,
      prior_five: PRIOR.has(id), enabled: false, requests: 0, stored: null, detail: null,
    };
    if (row.availability === "excluded_do_not_enable") {
      report.push({ ...base, live_class: "excluded", fetched: false, basis: "草案标明不要接通，这次不读" });
      continue;
    }
    if (!endpoint || row.availability === "missing_endpoint") {
      report.push({ ...base, live_class: "no_endpoint", fetched: false, basis: "没有可请求的公开地址" });
      continue;
    }
    if (kind !== "rss" && kind !== "markdown-changelog") {
      report.push({
        ...base, live_class: "adapter_pending", fetched: false,
        basis: `${kind} 没有现成的 rss / web_list / json_list 配置。不另写抓取脚本。`,
      });
      continue;
    }
    const owner = seenEndpoint.get(endpoint);
    if (owner) {
      report.push({ ...base, live_class: "duplicate_endpoint", fetched: false, shared_with: owner, basis: "同一地址只读一次" });
      continue;
    }
    seenEndpoint.set(endpoint, id);
    await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, interval_minutes, next_fetch_at)
      VALUES (${id}, ${String(row.name)}, ${kind === "rss" ? "rss" : "web_list"}, 'isolated', ${sql.json(kind === "rss" ? { feedUrl: endpoint } : { url: endpoint, parseMode: "markdown_changelog" })}, false, 1440, '2100-01-01')
      ON CONFLICT (id) DO NOTHING`;
    const source = sourceRow(id, String(row.name), kind === "rss" ? "rss" : "web_list", kind === "rss" ? { feedUrl: endpoint } : { url: endpoint, parseMode: "markdown_changelog" });
    freeGets += 1;
    let failure: { type: string; status: number | null; message: string; rawSha256: string | null; byteLength: number | null } | null = null;
    let read: { candidates: Awaited<ReturnType<typeof listingEntries>>; trace: { httpStatus: number; rawSha256: string | null; byteLength: number | null; responseUrl: string; contentType: string | null; fetchedAt: string } } | null = null;
    try {
      if (kind === "rss") {
        const rss = await fetchRss(source, { force: true });
        read = { candidates: await listingEntries(source, rss.candidates), trace: rss.trace };
      } else {
        const candidates = await listingEntries(source, await fetchWebList(source));
        read = { candidates, trace: { httpStatus: 200, rawSha256: null, byteLength: null, responseUrl: endpoint, contentType: null, fetchedAt: new Date().toISOString() } };
      }
    } catch (error) {
      const trace = error instanceof FeedHttpError ? error.trace : null;
      const status = error instanceof HttpStatusError ? error.status : trace?.httpStatus ?? null;
      failure = {
        type: classifyFailure(status, error instanceof Error ? error.message : String(error)),
        status, message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        rawSha256: trace?.rawSha256 ?? null, byteLength: trace?.byteLength ?? null,
      };
    }
    if (!read) {
      report.push({ ...base, requests: 1, fetched: true, live_class: failure?.type ?? "fetch_failed", failure, basis: "现有适配器读了一次，没有入库" });
      continue;
    }
    const dated = read.candidates.filter((item) => item.publishedAt);
    const withBody = read.candidates.filter((item) => item.bodyStatus === "ok" && (item.bodyText?.length ?? 0) > 0);
    const sample = withBody[0] ?? dated[0] ?? read.candidates[0] ?? null;
    let stored = null;
    if (sample) {
      const saved = await upsertMaterial({ ...sample, sourceId: id, via: "fetch" });
      await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL WHERE id = ${saved.articleId} AND processing_state = 'new'`;
      const [article] = await sql<{ revision: number; body_status: string; body_len: number | null; publication_time: string | null }[]>`
        SELECT revision, body_status, length(body_text) AS body_len, publication_time FROM articles WHERE id = ${saved.articleId}`;
      stored = { articleId: saved.articleId, created: saved.created, url: sample.url, title: sample.title, bodyStatus: article?.body_status, bodyLength: article?.body_len ?? 0, publicationTime: article?.publication_time ?? null, revision: article?.revision };
    }
    let detail = null;
    if (sample && sample.bodyStatus !== "ok") {
      freeGets += 1;
      try {
        const got = await fetchDetail(sample.url, source, { date: false, title: false, summary: true, body: true });
        const bodyLength = got.body?.text?.length ?? 0;
        detail = { url: sample.url, requests: 1, status: 200, bodyLength, bodyClass: bodyLength > 280 ? "detail_text" : bodyLength > 0 ? "detail_short" : "detail_no_body" };
      } catch (error) {
        const status = error instanceof HttpStatusError ? error.status : null;
        const message = error instanceof UnavailablePageError ? `${error.message} sign-in` : error instanceof Error ? error.message : String(error);
        detail = { url: sample.url, requests: 1, status, failure: classifyFailure(status, message), message: message.slice(0, 300) };
      }
    }
    const live = !dated.length ? "no_verifiable_date" : !withBody.length ? "title_or_summary_only" : "listing_has_body";
    report.push({
      ...base, requests: 1, fetched: true, live_class: live,
      response: read.trace, listing_items: read.candidates.length, dated_items: dated.length, body_items: withBody.length,
      stored_sample: stored, detail, history: "one_response_not_full_history",
      basis: "一次列表响应里的计数。入库的是一条小样本，不是整段历史。",
    });
  }
  const [states] = await sql<{ articles: number; queued: number }[]>`
    SELECT count(*)::int AS articles, count(*) FILTER (WHERE processing_queued_at IS NOT NULL)::int AS queued FROM articles`;
  const body = {
    generated_at: new Date().toISOString(),
    database: new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""),
    draft: "docs/own-pipeline/SOURCE_DRAFT_v1.json",
    workerStarted: false, modelCalls: 0, socialDataUsd: 0, jinaReads: 0, freeGets,
    sourcesEnabled: false, articles: states?.articles ?? 0, queued: states?.queued ?? 0,
    note: "feed HTTP 200 不是正文完整。停止于一条样本不是频道覆盖完成。",
    counts: report.reduce((acc: Record<string, number>, row) => {
      const key = String((row as { live_class: string }).live_class);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    rows: report,
  };
  mkdirSync("docs/own-pipeline", { recursive: true });
  writeFileSync(OUT, JSON.stringify(body, null, 2));
  console.log(JSON.stringify({ ok: true, freeGets, counts: body.counts, articles: body.articles, out: OUT }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { await closeDb(); }
