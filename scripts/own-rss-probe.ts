// One public GET per drafted RSS endpoint, parsed by fetchRss and stored with upsertMaterial.
// No worker, no model, no Jina, no SocialData. Sources stay disabled.
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { FeedHttpError, fetchRss } from "@aihot/backend/sources/rss";
import { listingEntries } from "@aihot/backend/sources/collect";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { type SourceRow } from "@aihot/backend/sources/types";
import { UnavailablePageError } from "@aihot/backend/lib/page-content";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const IDS = ["openai_news", "google_ai_blog", "huggingface_blog", "claude_platform_release_notes", "openai_codex_github_releases"];
const OUT = process.argv[2] ?? "docs/own-pipeline/RSS_PROBE_v9.json";

function classifyFailure(status: number | null, message: string): string {
  const text = message.toLowerCase();
  if (status === 401 || status === 403) return "http_forbidden";
  if (status === 429) return "http_limited";
  if (/captcha|cloudflare|challenge|just a moment|attention required|access denied/.test(text)) return "challenge";
  if (/sign-in|login|unavailable-in-region|paywall/.test(text)) return "blocked_or_login";
  if (status && status >= 400) return `http_${status}`;
  if (/not an rss|parse error|feedurl/.test(text)) return "parse_failed";
  return "fetch_failed";
}

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") {
    throw new Error("采集或模型开关开着，拒绝这次公开对照");
  }
  const draft = JSON.parse(readFileSync("docs/own-pipeline/SOURCE_DRAFT_v1.json", "utf8"));
  const listed = new Map(draft.next_small_batch.free_http_candidates.map((row: { source_id: string; endpoint: string }) => [row.source_id, row.endpoint]));
  const rows = draft.nonx.filter((row: { source_id: string }) => IDS.includes(row.source_id));
  if (rows.length !== IDS.length) throw new Error(`草案里没有这 ${IDS.length} 个源`);
  const sources = IDS.map((id) => {
    const row = rows.find((item: { source_id: string }) => item.source_id === id);
    const endpoint = String(row.endpoint ?? "");
    if (!endpoint || listed.get(id) !== endpoint) throw new Error(`${id} 的地址不在草案的同一处`);
    return row;
  });

  const report: Record<string, unknown>[] = [];
  for (const row of sources) {
    const id = row.source_id as string;
    await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, interval_minutes, next_fetch_at)
      VALUES (${id}, ${row.name}, 'rss', 'editorial', ${sql.json({ feedUrl: row.endpoint })}, false, ${row.current_freq_minutes ?? 1440}, '2100-01-01')
      ON CONFLICT (id) DO NOTHING`;
    const config = {
      feedUrl: row.endpoint,
      // Release-note entries are sections of one page. The stock flag keeps the fragment in the identity.
      ...(id === "claude_platform_release_notes" ? { preserveUrlFragment: true } : {}),
    };
    await sql`UPDATE sources SET config = ${sql.json(config)} WHERE id = ${id}`;
    const source: SourceRow = {
      id, name: row.name, kind: "rss", tier: "C", participation_mode: "editorial", uses: [],
      interval_minutes: row.current_freq_minutes ?? 1440, enabled: false, cursor: null, fail_count: 0,
      config,
    };
    const started = Date.now();
    let read: Awaited<ReturnType<typeof fetchRss>> | null = null;
    let failure: { type: string; status: number | null; message: string; rawSha256: string | null; byteLength: number | null; responseUrl: string | null } | null = null;
    try {
      read = await fetchRss(source, { force: true });
    } catch (error) {
      const trace = error instanceof FeedHttpError ? error.trace : null;
      const status = error instanceof HttpStatusError ? error.status : trace?.httpStatus ?? null;
      const message = error instanceof Error ? error.message : String(error);
      failure = {
        type: classifyFailure(status, message), status, message,
        rawSha256: trace?.rawSha256 ?? null, byteLength: trace?.byteLength ?? null, responseUrl: trace?.responseUrl ?? null,
      };
    }
    const elapsedMs = Date.now() - started;
    if (!read) {
      report.push({
        source_id: id, endpoint: row.endpoint, enabled: false, elapsedMs, failure,
        items: 0, feed_text: 0, summary_only: 0, details: [], replay: null,
        history: "not_fetched", quality: "unverified",
      });
      continue;
    }
    const items = await listingEntries(source, read.candidates);
    const feedText = items.filter((item) => item.bodyStatus === "ok").length;
    const summaryOnly = items.filter((item) => item.bodyStatus !== "ok").length;
    let created = 0;
    let revised = 0;
    for (const item of items) {
      const saved = await upsertMaterial({ ...item, sourceId: id, via: "fetch" });
      if (saved.created) created += 1;
      if (saved.revised) revised += 1;
    }
    let replayCreated = 0;
    let replayRevised = 0;
    for (const item of items) {
      const saved = await upsertMaterial({ ...item, sourceId: id, via: "fetch" });
      if (saved.created) replayCreated += 1;
      if (saved.revised) replayRevised += 1;
    }
    await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL
      WHERE source_id = ${id} AND processing_state = 'new'`;
    const pending = items.filter((item) => item.bodyStatus !== "ok").slice(0, 3);
    const detailSource: SourceRow = { ...source, config: { ...source.config, detail: { summarySelector: "meta[name='description']" } } };
    const details = [];
    for (const item of pending) {
      const detailStarted = Date.now();
      try {
        const got = await fetchDetail(item.url, detailSource, { date: false, title: false, summary: true, body: true });
        const bodyLength = got.body?.text?.length ?? 0;
        details.push({
          url: item.url, elapsedMs: Date.now() - detailStarted, status: 200,
          listing: item.bodyStatus === "ok" ? "feed_text" : "summary_only",
          excerptLength: item.excerpt?.length ?? 0,
          detailBodyLength: bodyLength,
          detailClass: bodyLength > 280 ? "detail_text_unverified" : bodyLength > 0 ? "detail_short_unverified" : "detail_no_body",
          quality: "unverified",
        });
      } catch (error) {
        const status = error instanceof HttpStatusError ? error.status : null;
        const message = error instanceof Error ? error.message : String(error);
        details.push({
          url: item.url, elapsedMs: Date.now() - detailStarted, status,
          failure: classifyFailure(status, error instanceof UnavailablePageError ? `${message} sign-in` : message),
          message: message.slice(0, 300), quality: "unverified",
        });
      }
    }
    report.push({
      source_id: id, endpoint: row.endpoint, enabled: false, elapsedMs,
      httpStatus: read.trace.httpStatus, responseUrl: read.trace.responseUrl, contentType: read.trace.contentType,
      rawSha256: read.trace.rawSha256, byteLength: read.trace.byteLength, fetchedAt: read.trace.fetchedAt,
      items: items.length, feed_text: feedText, summary_only: summaryOnly,
      stored: { created, revised }, replay: { created: replayCreated, revised: replayRevised, idempotent: replayCreated === 0 && replayRevised === 0 },
      details, failure: null, history: "snapshot_not_complete", quality: "unverified",
    });
  }
  const [states] = await sql<{ skipped: number; queued: number }[]>`
    SELECT count(*) FILTER (WHERE processing_state = 'skipped')::int AS skipped,
           count(*) FILTER (WHERE processing_queued_at IS NOT NULL)::int AS queued
    FROM articles WHERE source_id IN ${sql(IDS)}`;
  const body = {
    generated_at: new Date().toISOString(),
    database: new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""),
    workerStarted: false, paidCalls: false, coverage: "five_public_feeds_not_the_channel_set",
    sources_enabled: false, processing: states, feeds: report,
  };
  writeFileSync(OUT, JSON.stringify(body, null, 2));
  console.log(JSON.stringify(body, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await closeDb();
}
