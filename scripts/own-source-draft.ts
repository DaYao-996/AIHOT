// Offline draft of frozen X132 and non-X 47 rows. Does not enable collection or talk to the network.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const outDir = process.argv[3] ?? "docs/own-pipeline";
if (!root) throw new Error("usage: node scripts/own-source-draft.ts <SOURCE_MIGRATION_INPUTS dir> [out dir]");

function readJson(rel: string): any {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
}

const zipNote = "SOURCE_MIGRATION_INPUTS_v1 sha256 a7177acd1acbd1f60eda49ddeed11f302a9caea898d92f35a725c331b2e333ec";
const schedule = readJson("config/X132_EFFECTIVE_SCHEDULE.json");
const contracts = readJson("config/X132_QUERY_CONTRACTS.json");
const nonx = readJson("config/NONX47_CHANNEL_MAP_HISTORICAL.json");
const nonxStatus = readJson("evidence/NONX47_ROUND2_STATUS.json");
const freqText = readFileSync(path.join(root, "rules/05_SOURCE_FREQUENCY_MATCHED_X132.csv"), "utf8").replace(/^\uFEFF/, "");
const freqRows = freqText.trim().split("\n").slice(1).map((line) => {
  const [user_id, handle, group, priority, tier, frequency, daily, source] = line.split(",");
  return { user_id, handle, group, priority, tier, frequency, daily, source };
});
const freqByHandle = new Map(freqRows.map((row) => [row.handle.toLowerCase(), row]));
const contractBySource = new Map(contracts.tasks.map((task: any) => [task.source_id, task]));
const statusBySource = new Map(nonxStatus.sources.map((row: any) => [row.source_id, row]));

if (schedule.sources.length !== 132 || contracts.tasks.length !== 132) throw new Error("X rows are not 132");
if (nonx.sources.length !== 47 || nonxStatus.sources.length !== 47) throw new Error("non-X rows are not 47");
if (freqRows.length !== 120) throw new Error("doc05 matched rows are not 120");

const x = schedule.sources.map((row: any) => {
  const task = contractBySource.get(`x:${row.handle}`) ?? contractBySource.get(row.source_id);
  if (!task) throw new Error(`missing query contract for ${row.handle}`);
  const doc = freqByHandle.get(String(row.handle).toLowerCase()) ?? null;
  const query = task?.query ?? "";
  const dropsSelfThread = /-filter:replies\b/i.test(query) && !/self_threads/i.test(query);
  return {
    handle: row.handle,
    user_id: row.user_id,
    source_id: task?.source_id ?? `x:${row.handle}`,
    historical: true,
    production: false,
    enabled: false,
    auto_dispatch: false,
    availability: "frozen_config_only",
    kind_draft: "x_search",
    participation_mode_draft: "editorial",
    participation_reason: "agreed daily channel; editorial is the path that reuses analysis. Not enabled. Not a hot-signal or isolated source.",
    schedule_minutes: row.schedule_minutes,
    historical_tier: row.tier,
    doc05_tier: row.doc05_tier ?? null,
    selection_tier: null,
    selection_tier_reason: "source frequency tier is not an AIHOT selection threshold",
    query,
    query_contract_sha256: task?.query_contract_sha256 ?? null,
    request_excludes_replies: task?.request_excludes_replies ?? null,
    local_filter: task?.local_filter ?? null,
    query_rewrite: "forbidden",
    drops_self_thread_if_rewritten_to_filter_replies: true,
    frozen_query_already_drops_self_thread: dropsSelfThread,
    doc05: doc ? { tier: doc.tier, frequency: doc.frequency, priority: doc.priority, daily: doc.daily } : null,
    gaps: [
      ...(doc ? [] : ["no_doc05_row"]),
      "not_a_live_connection",
      "window_coverage_unproven",
    ],
  };
});
const missingDoc = x.filter((row: any) => row.gaps.includes("no_doc05_row")).map((row: any) => row.handle);
if (missingDoc.length !== 12) throw new Error(`expected 12 handles without doc05, got ${missingDoc.length}`);

function nonxAvailability(row: any, status: any): { availability: string; reason: string } {
  const endpoint = String(row.endpoint ?? "").trim();
  const registry = String(row.status ?? "");
  const round = String(status?.status ?? "");
  if (registry === "do_not_connect" || row.source_role === "excluded") return { availability: "excluded_do_not_enable", reason: "registry says do not connect or the role is excluded" };
  if (!endpoint || round === "no_concrete_public_url_in_registry") return { availability: "missing_endpoint", reason: "no concrete public URL" };
  if (round === "fetch_failed") return { availability: "fetch_failed_historical", reason: status?.note || "historical fetch failed" };
  if (round === "blocked_or_challenge_or_login") return { availability: "blocked_or_login", reason: status?.note || "historical block or login wall" };
  if (round === "parse_failed") return { availability: "parse_failed_historical", reason: status?.note || "historical parse failed" };
  if (round === "html_snapshot_saved_not_a_dated_feed") return { availability: "html_not_a_feed", reason: "saved HTML is not a dated feed" };
  if (String(row.source_type).startsWith("manual") || row.source_type === "none") return { availability: "manual_or_no_feed", reason: "not a runnable feed" };
  if (round === "ingested_feed_snapshot") return { availability: "historical_snapshot_not_enabled", reason: "a snapshot was ingested; that is not a live connection" };
  return { availability: "unverified", reason: round || registry || "not claimed runnable" };
}

const endpointCounts = new Map<string, number>();
for (const row of nonx.sources) {
  const endpoint = String(row.endpoint ?? "").trim();
  if (endpoint) endpointCounts.set(endpoint, (endpointCounts.get(endpoint) ?? 0) + 1);
}
const channels = nonx.sources.map((row: any) => {
  const status = statusBySource.get(row.source_id) ?? null;
  const decided = nonxAvailability(row, status);
  const endpoint = String(row.endpoint ?? "").trim();
  const duplicate = endpoint ? (endpointCounts.get(endpoint) ?? 0) > 1 : false;
  const mode = decided.availability === "excluded_do_not_enable" || decided.availability === "manual_or_no_feed"
    ? "isolated" : "editorial";
  return {
    source_id: row.source_id,
    name: row.name,
    historical: true,
    production: false,
    enabled: false,
    live_enabled_historical: row.live_enabled ?? null,
    availability: decided.availability,
    availability_reason: decided.reason,
    kind_hint: row.source_type,
    endpoint: endpoint || null,
    duplicate_endpoint: duplicate,
    participation_mode_draft: mode,
    participation_reason: mode === "editorial"
      ? "operational feed candidate; editorial would reuse analysis later. Not enabled."
      : "not an analyze feed; isolated so it is not sent through the default analysis chain. Not enabled.",
    baseline_freq_minutes: row.baseline_freq_minutes ?? null,
    current_freq_minutes: row.current_freq_minutes ?? null,
    selection_tier: null,
    round2_status: status?.status ?? null,
    items_in_window: status?.items_in_window ?? null,
    raw_sha256: status?.raw_sha256 ?? status?.sha256 ?? null,
    gaps: [decided.availability, ...(duplicate ? ["duplicate_endpoint"] : [])],
  };
});

const runnableLooking = channels.filter((row: any) => row.availability === "historical_snapshot_not_enabled" && row.kind_hint === "rss" && !row.duplicate_endpoint);
const draft = {
  generated_from: zipNote,
  historical_not_production: true,
  enabled: false,
  collect_enabled: false,
  model_calls_enabled: false,
  counts: {
    x: x.length,
    x_without_doc05: missingDoc.length,
    nonx: channels.length,
    nonx_nonempty_endpoint: channels.filter((row: any) => row.endpoint).length,
    nonx_unique_endpoints: endpointCounts.size,
    nonx_by_availability: Object.fromEntries(channels.reduce((map: Map<string, number>, row: any) => map.set(row.availability, (map.get(row.availability) ?? 0) + 1), new Map())),
  },
  x_handles_without_doc05: missingDoc,
  next_small_batch: {
    not_started: true,
    x_paid_search: "do not start; vendor actual balance unknown; 2.06 USD is an estimate, not a bill",
    free_http_candidates: runnableLooking.slice(0, 5).map((row: any) => ({ source_id: row.source_id, endpoint: row.endpoint, estimate: "plain HTTP GET if the endpoint is still public; no SocialData and no model; not enabled" })),
  },
  x,
  nonx: channels,
};
const body = JSON.stringify(draft, null, 2);
writeFileSync(path.join(outDir, "SOURCE_DRAFT_v1.json"), body + "\n");
const lines = [
  "# 源配置草案 v1",
  "",
  "历史封存配置，不是正在运行的生产配置。全部 `enabled: false`。没有启动采集、worker 或模型。",
  "",
  `- 来源包：${zipNote}`,
  `- X ${draft.counts.x} 条。doc05 对不上的 handle ${draft.counts.x_without_doc05} 个：${missingDoc.join(", ")}。不猜频率。`,
  `- 非 X ${draft.counts.nonx} 条。非空 endpoint ${draft.counts.nonx_nonempty_endpoint}，唯一 endpoint ${draft.counts.nonx_unique_endpoints}。不是 47 条可运行 feed。`,
  `- 状态计数：${JSON.stringify(draft.counts.nonx_by_availability)}`,
  "",
  "源频率档位没有写成精选 T 档。冻结查询是 `-filter:retweets`，不能改写成单独的 `-filter:replies`，否则会丢掉作者自己的续帖。",
  "",
  "下一小批只列出最多 5 个历史上有 RSS 快照、endpoint 不重复的候选，仍然不启用。付费 X 搜索不在这批里。估算 2.06 美元不是厂商实扣。",
  "",
];
writeFileSync(path.join(outDir, "SOURCE_DRAFT_v1.md"), lines.join("\n"));
console.log(JSON.stringify({ wrote: true, counts: draft.counts, sha256: createHash("sha256").update(body).digest("hex") }));
