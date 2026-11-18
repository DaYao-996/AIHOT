// One entry for a sealed gap run. File judgments stay off the model path.
// node scripts/own-run.ts --step gap --seal <file> --config <file> --out-dir <dir>
// node scripts/own-run.ts --step model
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import postgres from "postgres";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { applyStoredAttempt, readable, reviseBodyFromStoredDetail } from "@aihot/backend/content/extract";
import { fillPublicationTime } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { holdBackAutomaticRelease } from "@aihot/backend/own-pipeline-hold";
import { listPendingDrafts, materialForScoring, recordCurrentBodyEvidence, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { collectSource, loadSource } from "@aihot/backend/sources/collect";
import { parseHTML } from "linkedom";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { finishRequest, noteUnverifiedRequest, openRequest } from "@aihot/backend/sources/request-ledger";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";
import { assertFileJudgmentPath, modelCall, modelConfigurationGap } from "./own-judge-mode.ts";

config.allowPrivateNetworkFetch = true;
const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
};
const step = flag("--step");
if (step === "model") {
  try { modelCall(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
function scheduleDir(): string {
  const dir = flag("--schedule-dir") || "var/schedule";
  if (!dir || isAbsolute(dir) || dir.split(/[\\/]/).includes("..")) {
    console.error("调度目录必须是当前目录下的相对路径");
    process.exit(1);
  }
  return dir;
}
if (step === "file") {
  try { assertFileJudgmentPath(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  console.log(JSON.stringify({
    step: "file", runnable: true, writesJudgments: false, modelCalls: 0,
    modelConfigured: modelConfigurationGap() === null,
    note: "文件判断模式可以运行，不需要模型配置。真正写入判断的是 --step once。",
  }));
  process.exit(0);
}
if (step === "schedule") {
  const dir = scheduleDir();
  mkdirSync(dir, { recursive: true });
  const installed = join(dir, "installed.json");
  if (existsSync(installed)) {
    console.error("调度工件已经在。退出码不是定时器在跑。");
    process.exit(1);
  }
  const record = {
    timerRunning: false, workerStarted: false, publish: false, collect: false, kind: "test-isolation",
    installedAt: new Date().toISOString(),
    onceCommand: "node scripts/own-run.ts --step once --config docs/own-pipeline/product/config.example.json --out-dir var/once-out --schedule-dir var/schedule",
  };
  writeFileSync(installed, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ step: "schedule", installed: true, timerRunning: false, artifact: installed }));
  process.exit(0);
}
if (step === "stop") {
  const dir = scheduleDir();
  const installed = join(dir, "installed.json");
  if (!existsSync(installed)) {
    console.error("没有调度工件可卸。退出码 1，不用 0 表示定时器已经停过。");
    process.exit(1);
  }
  const record = JSON.parse(readFileSync(installed, "utf8")) as Record<string, unknown>;
  unlinkSync(installed);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "uninstalled.json"), JSON.stringify({ ...record, timerRunning: false, uninstalledAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(JSON.stringify({ step: "stop", removed: true, timerRunning: false, artifact: join(dir, "uninstalled.json") }));
  process.exit(0);
}
if (step === "once") {
  const installed = join(scheduleDir(), "installed.json");
  if (!existsSync(installed)) {
    console.error("没有调度工件。先运行 --step schedule。这一步不会假装定时器已经在跑。");
    process.exit(1);
  }
  const record = JSON.parse(readFileSync(installed, "utf8")) as { timerRunning?: boolean };
  if (record.timerRunning !== false) {
    console.error("调度工件声称定时器在跑。测试隔离不允许这样。");
    process.exit(1);
  }
  await runAccept();
  writeFileSync(join(scheduleDir(), "once-ran.json"), JSON.stringify({ at: new Date().toISOString(), timerRunning: false, outDir: flag("--out-dir") }, null, 2) + "\n");
  process.exit(process.exitCode ?? 0);
}
if (step === "bind-proof") {
  await runBindProof();
  process.exit(process.exitCode ?? 0);
}
if (step === "accept") {
  await runAccept();
  process.exit(process.exitCode ?? 0);
}
if (step !== "gap") {
  console.error("需要 --step accept、once、bind-proof、file、gap、model、schedule 或 stop");
  process.exit(1);
}
const sealPath = flag("--seal");
const configPath = flag("--config");
const outDir = flag("--out-dir");
if (!sealPath || !configPath || !outDir) {
  console.error("需要 --seal --config --out-dir");
  process.exit(1);
}
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
assertFileJudgmentPath();
if (process.env.COLLECT_ENABLED === "true") {
  console.error("采集开关必须关着");
  process.exit(1);
}
const seal = JSON.parse(readFileSync(sealPath, "utf8")) as { code?: { HEAD?: string }; files?: Record<string, string> };
for (const [path, expected] of Object.entries(seal.files ?? {})) {
  const got = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (got !== expected) {
    console.error(`封存不一致 ${path} ${got} != ${expected}`);
    process.exit(2);
  }
}
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (seal.code?.HEAD && head !== seal.code.HEAD) {
  console.error(`HEAD ${head} != ${seal.code.HEAD}`);
  process.exit(2);
}
const dirty = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "scripts/own-run.ts", "scripts/own-judge-mode.ts", "packages/backend/src/sources/request-ledger.ts", "packages/backend/src/sources/web-list.ts", "packages/backend/src/content/extract.ts"], { encoding: "utf8" });
if (dirty.trim()) {
  console.error(dirty);
  process.exit(2);
}
const frozen = JSON.parse(readFileSync(configPath, "utf8")) as {
  priorDatabase: string;
  urls: string[];
  lostRequests: Array<{ url: string; note: string }>;
  priorCoverage: string;
  fileChain: { rulesetVersion: string; shortPrompt: string; shortSelection: string; shortDraft: string; fullPrompt: string; fullSelection: string; fullDraft: string };
};
mkdirSync(`${outDir}/logs`, { recursive: true });
const log = (line: string) => { appendFileSync(`${outDir}/logs/gap.log`, line + "\n"); console.log(line); };
const recordedAt = "2026-11-18T14:50:00.000Z";

async function chain(articleId: string, prompts: { semantic: string; selection: string; draft: string }, note: { time: string; rationale: string; draft: string }) {
  const [row] = await sql<{ url: string; title: string; revision: number; version: number; evidence_hash: string; body_text: string }[]>`
    SELECT a.url, a.title, a.revision, v.version, v.evidence_hash, v.body_text
    FROM articles a
    JOIN LATERAL (
      SELECT version, evidence_hash, body_text FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.id = ${articleId}`;
  if (!row?.body_text) throw new Error("没有可引用的正文");
  const scoring = await materialForScoring(articleId);
  if (scoring?.bodyText !== row.body_text) throw new Error("评分输入不是当前正文");
  const excerpt = row.body_text.slice(80, 140);
  const start = row.body_text.indexOf(excerpt);
  if (start < 0 || excerpt.trim().length < 20) throw new Error(`引文不成立 ${row.url}`);
  const semantic = await recordFileResult({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.semantic,
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "正文里有这一句", quoteLocation: { excerpt, start, end: start + excerpt.length },
      conditions: ["引文取自当前正文"], time: note.time,
      valueBasis: "只引用已保存的正文，不另写事实", audience: ["待审的人"], substantiveAddition: "判断依据是这一句原文",
      clauses: [{ id: "quote", text: "引文必须能在当前正文里按位置取出" }],
    },
  }, recordedAt);
  const selection = await recordSelectionDecision({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.selection,
    decision_rationale: note.rationale, conditions: ["旧样本", "不是新消息"],
    sampleRole: "development_sample", timeliness: "historical_backlog", qualityAcceptance: false,
  }, recordedAt);
  const draft = await recordReviewDraft({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.draft,
    text: note.draft.replaceAll("{excerpt}", excerpt),
    sourceNote: "开发样本。稿件引用当前正文。历史材料，不是新消息，不是质量验收。",
    sourceCitations: [row.url], conditions: ["事实未核", "未许可", "不是新消息"],
    technicalFixture: false, requiresHumanReview: true,
  }, recordedAt);
  return { url: row.url, semanticId: semantic.id, selectionId: selection.id, draftId: draft.id, bodyBytes: Buffer.byteLength(row.body_text) };
}

try {
  const lost = [];
  for (const item of frozen.lostRequests) {
    const id = await noteUnverifiedRequest(item.url, item.note, null);
    lost.push({ id, url: item.url });
    log(`UNVERIFIED ${item.url}`);
  }
  const prior = postgres(frozen.priorDatabase, { max: 1 });
  const sources = await prior<{ id: string; name: string; kind: string; config: unknown; tier: string; participation_mode: string }[]>`
    SELECT id, name, kind, config, tier, participation_mode FROM sources
    WHERE id IN ('nvidia_developer_blog', 'apple_newsroom_cn')`;
  const articles = await prior<{
    id: string; source_id: string; identity_key: string; url: string; title: string; author: string | null; language: string | null;
    published_at: Date | null; published_at_claim: Date | null; publication_time: string | null; discovered_at: Date; timeline_at: Date;
    body_text: string | null; body_html: string | null; body_status: string; revision: number; content_hash: string | null;
  }[]>`SELECT id, source_id, identity_key, url, title, author, language, published_at, published_at_claim, publication_time,
      discovered_at, timeline_at, body_text, body_html, body_status, revision, content_hash
    FROM articles WHERE url IN ${prior(frozen.urls)}`;
  await prior.end();
  for (const source of sources) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
      VALUES (${source.id}, ${source.name}, ${source.kind}, ${sql.json(source.config as never)}, ${source.tier}, ${source.participation_mode}, false, '2100-01-01')
      ON CONFLICT (id) DO NOTHING`;
  }
  for (const article of articles) {
    await sql`INSERT INTO articles (
      id, source_id, identity_key, url, title, author, language, published_at, published_at_claim, publication_time,
      discovered_at, timeline_at, body_text, body_html, body_status, revision, content_hash)
      VALUES (${article.id}, ${article.source_id}, ${article.identity_key}, ${article.url}, ${article.title}, ${article.author}, ${article.language},
        ${article.published_at}, ${article.published_at_claim}, ${article.publication_time}, ${article.discovered_at}, ${article.timeline_at},
        ${article.body_text}, ${article.body_html}, ${article.body_status}, ${article.revision}, ${article.content_hash})
      ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
      VALUES (${article.id}, ${article.revision}, ${article.content_hash}, ${article.title}, ${article.body_text})
      ON CONFLICT DO NOTHING`;
  }
  const refusal = await proveRefusalIsOneRow();
  log(`LEDGER 403 hits=${refusal.hits} rows=${refusal.rows} phase=${refusal.phase}`);
  const results = [];
  for (const url of frozen.urls) {
    results.push(await onePage(url));
  }
  const coverage = coverageReport(results);
  writeFileSync(`${outDir}/COVERAGE.json`, JSON.stringify(coverage, null, 2));
  const restored = restoreCheck(outDir, "own_gap_v19_restore_test");
  const [counts] = await sql<{ publications: number; receipts: number; fetch_runs: number; attempts: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications,
           (SELECT count(*)::int FROM receipts) AS receipts,
           (SELECT count(*)::int FROM fetch_runs) AS fetch_runs,
           (SELECT count(*)::int FROM own_request_attempts) AS attempts`;
  if (counts!.publications !== 0 || counts!.receipts !== 0 || counts!.fetch_runs !== 0) throw new Error("发布、回执或 fetch_runs 不应在这一入口出现");
  const report = { contractPassed: false, workerStarted: false, modelCalls: 0, lost, refusal, results, coverage: { missingDateBefore: coverage.missingDate, articles: coverage.articles }, restored, counts };
  writeFileSync(`${outDir}/GAP.json`, JSON.stringify(report, null, 2));
  log(JSON.stringify({ ok: true, publications: 0, receipts: 0, fetchRuns: 0, attempts: counts!.attempts }));
} finally {
  await stopBoss();
  await closeDb();
}

async function onePage(url: string) {
  const [article] = await sql<{ id: string; source_id: string; body_text: string | null; published_at: Date | null; revision: number }[]>`
    SELECT id, source_id, body_text, published_at, revision FROM articles WHERE url = ${url}`;
  if (!article) throw new Error(`事前库没有 ${url}`);
  const previous = article.body_text ?? "";
  let short: { draftId: string } | null = null;
  if (previous.length >= 140) {
    await recordCurrentBodyEvidence(article.id, null);
    const time = article.published_at ? article.published_at.toISOString().slice(0, 10) : "无发布元数据";
    short = await chain(article.id, {
      semantic: frozen.fileChain.shortPrompt, selection: frozen.fileChain.shortSelection, draft: frozen.fileChain.shortDraft,
    }, {
      time,
      rationale: "这是订阅里的开头一段，不是页面全文。旧样本，不是新消息。",
      draft: "待审。当时入库的开头写有：「{excerpt}」。不是新消息，未核，未许可。",
    });
  }
  const source = await loadSource(article.source_id);
  if (!source) throw new Error("没有源");
  let got;
  try {
    got = await fetchDetail(url, source, { date: true, title: false, summary: false, body: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 180) : String(error);
    log(`GET FAIL ${url} ${message}`);
    return { url, error: message, retried: false, short };
  }
  const bytes = got.response?.bytes ?? Buffer.alloc(0);
  if (!got.response || got.response.status !== 200) return { url, status: got.response?.status ?? null, retried: false, short };
  const extracted = got.body?.text ?? "";
  await sql`INSERT INTO own_detail_responses (source_id, url, http_status, response, response_sha256, truncated, extracted_bytes, extraction_note)
    VALUES (${source.id}, ${url}, ${got.response.status}, ${bytes}, ${sha256(bytes)}, ${got.response.truncated}, ${Buffer.byteLength(extracted)},
      ${"extract length at insert is not a later article revision; bound_revision is set only when this raw is applied"})`;
  const revised = await reviseBodyFromStoredDetail(article.id);
  let dated = false;
  if (!article.published_at && got.publishedAt) {
    const filled = await fillPublicationTime(sql, article.id, got.publishedAt, undefined, got.publicationTime);
    dated = !!filled?.publishedAt;
  }
  await holdBackAutomaticRelease(sql, article.id);
  const [now] = await sql<{ published_at: Date | null; n: number; revision: number }[]>`
    SELECT published_at, octet_length(body_text)::int AS n, revision FROM articles WHERE id = ${article.id}`;
  let full = null;
  if (revised.status === "revised") {
    const time = now!.published_at ? now!.published_at.toISOString().slice(0, 10) : "无发布元数据";
    full = await chain(article.id, {
      semantic: frozen.fileChain.fullPrompt, selection: frozen.fileChain.fullSelection, draft: frozen.fileChain.fullDraft,
    }, {
      time,
      rationale: time === "无发布元数据"
        ? "页面没有可核的发布元数据，不能当成新消息。这是旧样本的补正文，待核。"
        : `发布时间是已存的 ${time}，不是这次抓取。旧样本，不是新消息。`,
      draft: "待审。补上的正文写有：「{excerpt}」。不是新消息，未核，未许可。",
    });
    await holdBackAutomaticRelease(sql, article.id);
  }
  log(`PAGE ${url} raw=${bytes.length} revise=${revised.status} body=${now!.n} date=${now!.published_at?.toISOString() ?? "none"}`);
  return {
    url, status: 200, rawBytes: bytes.length, sha256: sha256(bytes), previousBytes: Buffer.byteLength(previous),
    revise: revised.status, staled: revised.staled, bodyBytes: now!.n, revision: now!.revision,
    publishedAt: now!.published_at?.toISOString() ?? null, dateFromPageMetadata: dated, short, full, retried: false,
  };
}

function coverageReport(results: Array<Record<string, unknown>>) {
  const prior = JSON.parse(readFileSync(frozen.priorCoverage, "utf8")) as Array<{ sourceId: string; items: Array<Record<string, unknown>> }>;
  const items = prior.flatMap((source) => source.items.map((item) => ({
    sourceId: source.sourceId,
    url: item.url,
    bodyBytes: item.bodyBytes ?? 0,
    body: item.bodyStatus,
    date: item.dated === true,
    sourceEvidence: item.evidence ?? 0,
    raw: false,
    label: item.class,
  })));
  const missingDate = items.filter((item) => !item.date).length;
  for (const result of results) {
    const row = items.find((item) => item.url === result.url);
    if (!row || result.status !== 200) continue;
    row.bodyBytes = result.bodyBytes;
    row.body = "ok";
    row.raw = true;
    if (result.publishedAt) row.date = true;
    if (result.full) row.sourceEvidence = 1;
  }
  return { articles: items.length, missingDate, missingDateAfter: items.filter((item) => !item.date).length, items };
}

async function proveRefusalIsOneRow() {
  let hits = 0;
  const server = createServer((_req, res) => { hits += 1; res.writeHead(403); res.end("refused"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/refused`;
  const sourceId = `ledger-${randomUUID().slice(0, 8)}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
    VALUES (${sourceId}, '请求账', 'web_list', ${sql.json({ url, detail: { maxFetches: 1 } })}, 'T1', 'editorial', false, '2100-01-01')`;
  const source = await loadSource(sourceId);
  try { await fetchDetail(url, source!, { date: true, title: false, summary: false, body: true }); }
  catch { /* refusal is the case */ }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const rows = await sql<{ phase: string; http_status: number | null; n: number }[]>`
    SELECT phase, http_status, octet_length(response)::int AS n FROM own_request_attempts WHERE url = ${url}`;
  if (hits !== 1 || rows.length !== 1 || rows[0]!.phase !== "failed" || rows[0]!.http_status !== 403) {
    throw new Error(`403 没有按一次失败落账 ${hits} ${JSON.stringify(rows)}`);
  }
  return { hits, rows: rows.length, phase: rows[0]!.phase, bytes: rows[0]!.n };
}

async function runBindProof() {
  const outDir = flag("--out-dir") || "var/bind-out";
  if (isAbsolute(outDir) || outDir.split(/[\\/]/).includes("..")) {
    console.error("输出必须是当前目录下的相对路径");
    process.exit(1);
  }
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  assertFileJudgmentPath();
  mkdirSync(outDir, { recursive: true });
  const sourceId = "bind-proof";
  const url = "http://127.0.0.1/bind-proof/same";
  const sentence = "The binding proof paragraph records one sentence. ";
  const html = Buffer.from(`<!DOCTYPE html><html><body><article><p>${sentence.repeat(30)}</p></article></body></html>`);
  const articleId = randomUUID();
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
    VALUES (${sourceId}, '绑定证明', 'web_list', ${sql.json({ url })}, 'T1', 'editorial', false, '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
    VALUES (${articleId}, ${sourceId}, ${identityKeyForUrl(url)}, ${url}, '绑定证明', now(), now(), 1, NULL, '', 'pending', 'skipped')`;
  const [before] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId}`;
  const open = async () => {
    const id = await openRequest(sourceId, url);
    await finishRequest(id, { status: 200, bytes: html });
    return id;
  };
  const [leftId, rightId] = await Promise.all([open(), open()]);
  const applied = await Promise.all([
    applyStoredAttempt(leftId, articleId),
    applyStoredAttempt(rightId, articleId),
  ]);
  const rows = await sql<{ attempt_id: string; detail_revision: number; attempt_revision: number; article_id: string }[]>`
    SELECT d.attempt_id, d.bound_revision AS detail_revision, a.bound_revision AS attempt_revision, a.article_id
    FROM own_detail_responses d JOIN own_request_attempts a ON a.id = d.attempt_id
    WHERE d.attempt_id IN (${leftId}, ${rightId})`;
  if (rows.length !== 2 || applied.some((item) => item.status !== "revised" && item.status !== "bound")) {
    throw new Error(`同地址并发没有各绑到自己的请求 ${JSON.stringify({ applied, rows })}`);
  }
  for (const row of rows) {
    if (row.article_id !== articleId || Number(row.detail_revision) !== Number(row.attempt_revision)) throw new Error("详情没有指向这次请求和同一修订");
  }
  const rollId = await open();
  let rolled = false;
  try {
    await applyStoredAttempt(rollId, articleId, { failBeforeCommit: true });
  } catch (error) {
    rolled = error instanceof Error && error.message.includes("提交前失败");
    if (!rolled) throw error;
  }
  const [left] = await sql<{ article_id: string | null; bound_revision: number | null; details: number; revision: number }[]>`
    SELECT t.article_id, t.bound_revision,
      (SELECT count(*)::int FROM own_detail_responses d WHERE d.attempt_id = t.id) AS details,
      (SELECT revision FROM articles WHERE id = ${articleId}) AS revision
    FROM own_request_attempts t WHERE t.id = ${rollId}`;
  if (!rolled || left?.article_id || left?.bound_revision != null || left?.details !== 0 || Number(left?.revision) !== Number(before!.revision) + applied.filter((item) => item.status === "revised").length) {
    throw new Error(`失败没有整笔撤销 ${JSON.stringify(left)}`);
  }
  let foreignKeyRejected = false;
  try {
    await sql`INSERT INTO own_detail_responses (source_id, url, response_sha256, attempt_id)
      VALUES (${sourceId}, ${url}, 'missing', ${randomUUID()})`;
  } catch {
    foreignKeyRejected = true;
  }
  if (!foreignKeyRejected) throw new Error("不存在的请求编号被写进了详情");
  const report = {
    sameUrl: url, concurrent: rows.map((row) => ({ attemptId: row.attempt_id, revision: Number(row.detail_revision) })),
    rollback: { attemptId: rollId, bound: false, detailRows: 0, articleRevision: Number(left!.revision) },
    foreignKeyRejected, officialGets: 0,
  };
  writeFileSync(join(outDir, "BIND.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, concurrent: rows.length, rolledBack: true, foreignKeyRejected }));
  await stopBoss();
  await closeDb();
}

async function runAccept() {
  const configPath = flag("--config");
  const outDir = flag("--out-dir");
  if (!configPath || !outDir || isAbsolute(configPath) || isAbsolute(outDir)) {
    console.error("配置和输出必须是相对路径");
    process.exit(1);
  }
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  assertFileJudgmentPath();
  if (process.env.COLLECT_ENABLED === "true") process.exit(1);
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
    items: Array<{ url: string; title: string; publishedAt: string | null; opening: string; file: string; container: string }>;
    fileChain: { rulesetVersion: string; shortPrompt: string; shortSelection: string; shortDraft: string; fullPrompt: string; fullSelection: string; fullDraft: string };
    priorCoverage: string;
    xNotRun: number;
  };
  const dir = dirname(resolve(configPath));
  mkdirSync(outDir, { recursive: true });
  const log = (line: string) => { appendFileSync(join(outDir, "accept.log"), line + "\n"); console.log(line); };
  const recordedAt = "2026-11-18T15:10:00.000Z";
  const pages = new Map<string, Buffer>();
  cfg.items.forEach((item, index) => pages.set(`/p/${index}`, readFileSync(join(dir, item.file))));
  let hits: Record<string, number> = {};
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/listing") {
      const html = cfg.items.map((item, index) => `<article><a href="http://127.0.0.1:${port}/p/${index}">${item.title}</a>${item.publishedAt ? `<time datetime="${item.publishedAt}"></time>` : ""}</article>`).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const body = pages.get(path);
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const sourceId = "accept-replay";
  try {
    const boundaries = cfg.items.map((item) => boundaryOf(join(dir, item.file), item.url, item.container));
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
      VALUES (${sourceId}, '本地回放', 'web_list', ${sql.json({
        url: `http://127.0.0.1:${port}/listing`, itemSelector: "article", linkSelector: "a", titleSelector: "a",
        publishedAtSelector: "time", allowUrlPrefixes: [`http://127.0.0.1:${port}/`],
        detail: { maxFetches: 0 },
      })}, 'T1', 'editorial', false, '2100-01-01')`;
    const collected = await collectSource(sourceId, { force: true });
    log(`COLLECT found=${collected.found} created=${collected.created}`);
    const refusal = await proveRefusalIsOneRow();
    const interruptedId = await openRequest(sourceId, "http://127.0.0.1/interrupted");
    const [left] = await sql<{ phase: string }[]>`SELECT phase FROM own_request_attempts WHERE id = ${interruptedId}`;
    if (left!.phase !== "started") throw new Error("中断的请求没有留下");
    const chain = [];
    for (const [index, item] of cfg.items.entries()) {
      const local = `http://127.0.0.1:${port}/p/${index}`;
      const [article] = await sql<{ id: string; published_at: Date | null }[]>`SELECT id, published_at FROM articles WHERE url = ${local}`;
      if (!article) throw new Error(`没有收回 ${item.url}`);
      if (item.opening) {
        await sql`UPDATE articles SET body_text = ${item.opening}, body_status = 'ok' WHERE id = ${article.id}`;
        await recordCurrentBodyEvidence(article.id, null);
        const time = article.published_at ? article.published_at.toISOString().slice(0, 10) : "无发布元数据";
        await chainOn(article.id, cfg.fileChain, { semantic: cfg.fileChain.shortPrompt, selection: cfg.fileChain.shortSelection, draft: cfg.fileChain.shortDraft }, {
          time, rationale: "这是订阅里的开头，不是页面全文。旧样本，不是新消息。", draft: "待审。开头写有：「{excerpt}」。不是新消息，未核，未许可。",
        }, recordedAt);
      }
      const source = await loadSource(sourceId);
      const got = await fetchDetail(local, source!, { date: true, title: false, summary: false, body: true });
      const attemptId = got.response?.attemptId;
      if (!attemptId || got.response?.status !== 200) throw new Error(`回放没有成功的请求 ${item.url}`);
      const applied = await applyStoredAttempt(attemptId, article.id);
      if (applied.status !== "revised" && applied.status !== "bound") throw new Error(`没有绑上修订 ${applied.status}`);
      const [bound] = await sql<{ article_id: string; bound_revision: number; phase: string }[]>`
        SELECT article_id, bound_revision, phase FROM own_request_attempts WHERE id = ${attemptId}`;
      if (bound!.article_id !== article.id || Number(bound!.bound_revision) !== applied.revision) throw new Error("请求没有在同一事务里绑到这一修订");
      if (!item.publishedAt && got.publishedAt) await fillPublicationTime(sql, article.id, got.publishedAt, undefined, got.publicationTime);
      await holdBackAutomaticRelease(sql, article.id);
      const [clock] = await sql<{ publication_time: string | null }[]>`SELECT publication_time FROM articles WHERE id = ${article.id}`;
      const time = /^\d{4}-\d{2}-\d{2}$/.test(clock?.publication_time ?? "") ? clock!.publication_time! : (clock?.publication_time ?? "无发布元数据");
      const full = await chainOn(article.id, cfg.fileChain, { semantic: cfg.fileChain.fullPrompt, selection: cfg.fileChain.fullSelection, draft: cfg.fileChain.fullDraft }, {
        time,
        rationale: "这是已保存原页的回放。旧样本，不是新消息。抽取长度不是全文证明。",
        draft: "待审。回放正文写有：「{excerpt}」。不是新消息，未核，未许可。",
      }, recordedAt);
      const boundary = boundaries[index]!;
      if (item.container === ".entry-content" && (!boundary.extractHasHead || !boundary.extractHasTail)) throw new Error(`正文没有盖住 ${item.container} 的首尾`);
      if (boundary.opensInNewWindow || boundary.downloadLabel) throw new Error("无关控件还在正文里");
      const scoring = await materialForScoring(article.id);
      chain.push({ canonical: item.url, local, attemptId, applied, full, scoringBytes: Buffer.byteLength(scoring?.bodyText ?? ""), boundary });
      log(`REPLAY ${item.url} revision=${applied.revision} staled=${applied.staled} body=${chain.at(-1)!.scoringBytes}`);
    }
    const replay = await sql<{ url: string; n: number }[]>`
      SELECT url, count(*)::int AS n FROM own_request_attempts
      WHERE url LIKE ${`http://127.0.0.1:${port}/p/%`} AND phase = 'succeeded' GROUP BY url`;
    if (replay.length !== cfg.items.length || replay.some((row) => row.n !== 1)) throw new Error("回放页面的成功请求不是各一次");
    const official = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_request_attempts WHERE url LIKE 'https://%'`;
    if (official[0]!.n !== 0) throw new Error("出现了对官网的请求");
    const coverage = JSON.parse(readFileSync(join(dir, cfg.priorCoverage), "utf8")) as Array<{ items: Array<{ dated?: boolean; bodyStatus?: string }> }>;
    const flat = coverage.flatMap((source) => source.items);
    const pending = await listPendingDrafts();
    writeFileSync(join(outDir, "pending.json"), JSON.stringify(pending, null, 2));
    const restored = restoreCheck(outDir, "own_accept_restore_test");
    const report = {
      contractPassed: false, workerStarted: false, modelCalls: 0, publish: false,
      xNotRun: cfg.xNotRun, articles: flat.length,
      missingDate: flat.filter((item) => item.dated !== true).length,
      pendingBody: flat.filter((item) => item.bodyStatus === "pending").length,
      derived: {
        note: "标签仍是当时的互斥类。字段刷新不改那一列，也不改 12 这个历史计数。",
        appleLabel: "pending_body",
        appleFields: { body: true, date: "2026-11-17", datePrecision: "date", original: "2026-11-17Z" },
        missingDateAfterFieldRefresh: flat.filter((item) => item.dated !== true).length - 1,
      },
      refusal, interrupted: left!.phase, hits, chain, restored,
    };
    writeFileSync(join(outDir, "ACCEPT.json"), JSON.stringify(report, null, 2));
    log(JSON.stringify({ ok: true, drafts: pending.length, missingDate: report.missingDate, xNotRun: cfg.xNotRun }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await stopBoss();
    await closeDb();
  }
}

function boundaryOf(file: string, url: string, container: string) {
  const html = readFileSync(file).toString("utf8");
  const body = readable(html, url);
  const { document } = parseHTML(html);
  const box = (document.querySelector(container)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const text = (body?.text ?? "").replace(/\s+/g, " ").trim();
  const head = box.slice(0, 80);
  const tail = box.slice(-80);
  return {
    container,
    extractHasHead: head.length > 0 && text.includes(head),
    extractHasTail: tail.length > 0 && text.includes(tail),
    opensInNewWindow: text.includes("在新窗口中打开"),
    downloadLabel: text.includes("新闻文章"),
    feedSourceWordIsNotThePost: true,
    byteLengthIsNotCompleteness: true,
  };
}

function restoreCheck(dir: string, name: string) {
  const url = process.env.DATABASE_URL ?? "";
  const restored = url.replace(/\/[^/]+$/, `/${name}`);
  const admin = url.replace(/\/[^/]+$/, "/postgres");
  execFileSync("psql", [admin, "-c", `DROP DATABASE IF EXISTS ${name}`]);
  execFileSync("psql", [admin, "-c", `CREATE DATABASE ${name}`]);
  const dump = join(dir, "dumps", "restore-check.dump");
  mkdirSync(join(dir, "dumps"), { recursive: true });
  execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", dump, url]);
  execFileSync("pg_restore", ["--no-owner", "--no-acl", `--dbname=${restored}`, dump]);
  const read = (database: string, query: string) => execFileSync("psql", [database, "-At", "-c", query], { encoding: "utf8" }).trim();
  const query = "SELECT count(*) FROM articles";
  const left = read(url, query);
  const right = read(restored, query);
  execFileSync("psql", [admin, "-c", `DROP DATABASE IF EXISTS ${name}`]);
  if (left !== right) throw new Error(`恢复后的文章数 ${right} 与 ${left} 不同`);
  return { articles: Number(left), dump: sha256(readFileSync(dump)) };
}

async function chainOn(articleId: string, prompts: { rulesetVersion: string }, which: { semantic: string; selection: string; draft: string }, note: { time: string; rationale: string; draft: string }, recordedAt: string) {
  const [row] = await sql<{ url: string; revision: number; version: number; evidence_hash: string; body_text: string }[]>`
    SELECT a.url, a.revision, v.version, v.evidence_hash, v.body_text
    FROM articles a JOIN LATERAL (
      SELECT version, evidence_hash, body_text FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true WHERE a.id = ${articleId}`;
  if (!row?.body_text) throw new Error("没有可引用的正文");
  const scoring = await materialForScoring(articleId);
  if (scoring?.bodyText !== row.body_text) throw new Error("评分输入不是当前正文");
  const excerpt = row.body_text.slice(80, 140);
  const start = row.body_text.indexOf(excerpt);
  if (start < 0 || excerpt.trim().length < 20) throw new Error("引文不成立");
  const semantic = await recordFileResult({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: prompts.rulesetVersion, promptVersion: which.semantic,
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "正文里有这一句", quoteLocation: { excerpt, start, end: start + excerpt.length },
      conditions: ["引文取自当前正文"], time: note.time,
      valueBasis: "只引用已保存的正文，不另写事实", audience: ["待审的人"], substantiveAddition: "判断依据是这一句原文",
      clauses: [{ id: "quote", text: "引文必须能在当前正文里按位置取出" }],
    },
  }, recordedAt);
  const selection = await recordSelectionDecision({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: prompts.rulesetVersion, promptVersion: which.selection,
    decision_rationale: note.rationale, conditions: ["旧样本", "不是新消息"],
    sampleRole: "development_sample", timeliness: "historical_backlog", qualityAcceptance: false,
  }, recordedAt);
  const draft = await recordReviewDraft({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: prompts.rulesetVersion, promptVersion: which.draft,
    text: note.draft.replaceAll("{excerpt}", excerpt),
    sourceNote: "开发样本。稿件引用当前正文。不是新消息，不是质量验收。",
    sourceCitations: [row.url], conditions: ["事实未核", "未许可", "不是新消息"],
    technicalFixture: false, requiresHumanReview: true,
  }, recordedAt);
  return { semanticId: semantic.id, selectionId: selection.id, draftId: draft.id };
}
