// Runnable contract entry. Reads the frozen config. Does not enable disabled roles or fetch X.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { HttpStatusError, guardedFetch } from "@aihot/backend/lib/http-fetch";
import { collectSource } from "@aihot/backend/sources/collect";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const FROZEN = new Set([
  "own_public_sample_v6_test", "own_public_sample_v9_test", "own_public_sample_v9_change_test",
  "own_chain_aside_v10_test", "own_chain_store_v11_test", "own_chain_bind_v12_test",
  "own_collect_branches_v13_test", "own_contract_run_v13_test", "own_review_hold_v14_test",
]);
type Row = Record<string, unknown>;
type Connect = {
  sourceId: string; role: string; intervalMinutes?: number; kind?: "web_list";
  action?: string; url?: string; missing?: string[]; listingScope?: string; listingDates?: string;
  config?: Record<string, unknown>;
};

const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unset").pathname.replace(/^\//, "");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (FROZEN.has(database)) throw new Error("这是已冻结的库");
if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") throw new Error("开关开着");
const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const configPath = arg("--config", "docs/own-pipeline/contract-run-v14/CONFIG.json");
const contractPath = arg("--contract", "/tmp/source-contract/SOURCE_CONTRACT_v1.json");
const priorPath = arg("--prior", "docs/own-pipeline/contract-run-v14/PRIOR17.json");
const outDir = arg("--out-dir", "docs/own-pipeline/contract-run-v14");
mkdirSync(`${outDir}/logs`, { recursive: true });
const logPath = `${outDir}/logs/entry.log`;
const log = (line: string) => { appendFileSync(logPath, line + "\n"); console.log(line); };
const frozen = JSON.parse(readFileSync(configPath, "utf8")) as { doNotEnableRoles: string[]; connect: Connect[] };
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as { sources: Row[] };
const prior = JSON.parse(readFileSync(priorPath, "utf8")) as Row[];

function qualify(input: { articles: number; bodyOk: number; pending: number; unconfirmed: number; evidence: number; found?: number }) {
  const listingOnly = input.articles > 0 && input.bodyOk === 0;
  const evidenceBound = input.evidence > 0;
  let reason = "bounded_sample_not_full_pool";
  if (input.articles === 0) reason = "no_items_stored";
  else if (input.unconfirmed > 0 && input.bodyOk === 0) reason = "page_unconfirmed_not_pool";
  else if (listingOnly) reason = "listing_only_not_pool";
  else if (input.bodyOk > 0 && input.evidence === 0) reason = "body_present_evidence_not_bound";
  else if (input.bodyOk < input.articles || input.evidence < input.bodyOk) reason = "partial_body_or_evidence_not_pool";
  else if ((input.found ?? input.articles) > input.articles) reason = "capped_sample_not_full_pool";
  return { poolEntered: false, listingOnly, evidenceBound, reason };
}

function retryable(error: string) {
  return /429|5\d\d|timeout|ECONN|fetch failed/i.test(error) && !/403|401/.test(error);
}

async function counts(sourceId: string) {
  const [row] = await sql<{ articles: number; dated: number; bodyOk: number; pending: number; unconfirmed: number; evidence: number; attempts: number; detailErrors: number }[]>`
    SELECT (SELECT count(*)::int FROM articles WHERE source_id = ${sourceId}) AS articles,
           (SELECT count(*)::int FROM articles WHERE source_id = ${sourceId} AND published_at IS NOT NULL) AS dated,
           (SELECT count(*)::int FROM articles WHERE source_id = ${sourceId} AND body_status = 'ok') AS "bodyOk",
           (SELECT count(*)::int FROM articles WHERE source_id = ${sourceId} AND body_status = 'pending') AS pending,
           (SELECT count(*)::int FROM articles WHERE source_id = ${sourceId} AND body_status = 'unconfirmed') AS unconfirmed,
           (SELECT count(*)::int FROM own_evidence_versions v JOIN articles a2 ON a2.id = v.article_id WHERE a2.source_id = ${sourceId}) AS evidence,
           coalesce((SELECT (detail->>'detailAttempts')::int FROM fetch_runs WHERE source_id = ${sourceId} ORDER BY id DESC LIMIT 1), 0) AS attempts,
           coalesce((SELECT jsonb_array_length(COALESCE(detail->'detailErrors', '[]'::jsonb)) FROM fetch_runs WHERE source_id = ${sourceId} ORDER BY id DESC LIMIT 1), 0) AS "detailErrors"`;
  return row!;
}

try {
  const connected = [];
  const inserted: string[] = [];
  for (const source of frozen.connect) {
    if (frozen.doNotEnableRoles.includes(source.role)) throw new Error(`角色不能自动启用 ${source.sourceId}`);
    if (source.action === "unverified") {
      connected.push({ sourceId: source.sourceId, role: source.role, action: "unverified", requests: 0, retryable: false, missing: source.missing, poolEntered: false, reason: "no_http_endpoint" });
      log(`UNVERIFIED ${source.sourceId} ${source.missing?.join("; ")}`);
      continue;
    }
    if (source.action === "one_get") {
      let status: number | null = null;
      let error = "";
      try {
        const res = await guardedFetch(source.url!, { timeoutMs: 20_000, maxBytes: 4096 });
        status = res.status;
      } catch (caught) {
        status = caught instanceof HttpStatusError ? caught.status : null;
        error = caught instanceof Error ? caught.message.slice(0, 180) : String(caught);
      }
      const forbidden = status === 403 || status === 401 || /403|401/.test(error);
      const tooLarge = /too large/i.test(error);
      connected.push({ sourceId: source.sourceId, role: source.role, action: "one_get", requests: 1, httpStatus: status, error, retryable: false, bypassed403: false, poolEntered: false, reason: forbidden ? "http_forbidden" : tooLarge ? "response_too_large_not_bypassed" : "page_not_stored" });
      log(`GET ${source.sourceId} status=${status} error=${error}`);
      continue;
    }
    const config = source.config!;
    await sql`INSERT INTO sources (id, name, kind, participation_mode, config, enabled, interval_minutes, site_fulltext, syndicate_fulltext, next_fetch_at)
      VALUES (${source.sourceId}, ${source.sourceId}, ${source.kind!}, 'editorial', ${sql.json(config)}, false, ${source.intervalMinutes ?? 1440}, false, false, '2100-01-01')`;
    inserted.push(source.sourceId);
    let result = await collectSource(source.sourceId, { force: true });
    let attempts = 1;
    if (result.status === "failed" && retryable(result.error ?? "")) {
      result = await collectSource(source.sourceId, { force: true });
      attempts = 2;
    }
    const remainder = await collectSource(source.sourceId, { force: true });
    await sql`UPDATE sources SET enabled = true WHERE id = ${source.sourceId}`;
    const settled = await collectSource(source.sourceId);
    await sql`UPDATE sources SET enabled = false, next_fetch_at = '2100-01-01' WHERE id = ${source.sourceId}`;
    const stored = await counts(source.sourceId);
    const gate = qualify({ ...stored, found: result.found });
    connected.push({
      sourceId: source.sourceId, role: source.role, action: "collect", status: result.status, httpError: result.error ?? null,
      requests: attempts, retryUsed: attempts > 1, found: result.found, created: result.created,
      backfillRemainderCreated: remainder.created, settledCreated: settled.created, settledRevised: settled.revised,
      listingScope: source.listingScope ?? null, listingDates: source.listingDates ?? null,
      ...stored, ...gate, requestSuccessIsPool: false,
    });
    log(`COLLECT ${source.sourceId} status=${result.status} found=${result.found} created=${result.created} body=${stored.bodyOk} evidence=${stored.evidence} detail=${stored.attempts} remainder=${remainder.created} settled=${settled.created} reason=${gate.reason}`);
  }
  if (inserted.length) {
    const ids = inserted.flatMap((id) => id);
    await sql`DELETE FROM pgboss.job WHERE name IN ('content.analyze', 'content.extract-body', 'events.group', 'notify.selected')
      AND state IN ('created', 'retry') AND data->>'articleId' IN (SELECT id FROM articles WHERE source_id IN ${sql(ids)})`;
    await sql`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL WHERE source_id IN ${sql(inserted)} AND processing_state = 'new'`;
  }
  const x = contract.sources.filter((row) => row.roster_family === "X174_historical");
  const disabled = contract.sources.filter((row) => row.roster_family !== "X174_historical" && frozen.doNotEnableRoles.includes(String(row.historical_role ?? "")));
  const priorQualified = prior.map((row) => ({ ...row, refetched: false, ...qualify({
    articles: Number(row.articles), bodyOk: Number(row.bodyOk), pending: Number(row.pending),
    unconfirmed: Number(row.unconfirmed), evidence: Number(row.evidenceRows), found: Number(row.found),
  }) }));
  const report = {
    database, config: configPath, paidX: false, modelCalls: 0, workerStarted: false,
    x: { total: x.length, daily132: x.filter((row) => row.in_frozen_daily132 === true).length, nonDaily: x.filter((row) => row.in_frozen_daily132 !== true).length, fetched: 0, reason: "no_free_x_api" },
    disabledNotEnabled: disabled.length,
    prior17: priorQualified,
    connected,
  };
  writeFileSync(`${outDir}/LEDGER.json`, JSON.stringify(report, null, 2));
  log(JSON.stringify({ ok: true, x: report.x, disabledNotEnabled: report.disabledNotEnabled, connected: connected.map((row) => ({ id: row.sourceId, reason: row.reason })) }));
} finally {
  await stopBoss();
  await closeDb();
}
