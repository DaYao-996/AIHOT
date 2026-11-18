// One entry for a sealed gap run. File judgments stay off the model path.
// node scripts/own-run.ts --step gap --seal <file> --config <file> --out-dir <dir>
// node scripts/own-run.ts --step model
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import postgres from "postgres";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { reviseBodyFromStoredDetail } from "@aihot/backend/content/extract";
import { fillPublicationTime } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { holdBackAutomaticRelease } from "@aihot/backend/own-pipeline-hold";
import { materialForScoring, recordCurrentBodyEvidence, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { loadSource } from "@aihot/backend/sources/collect";
import { noteUnverifiedRequest } from "@aihot/backend/sources/request-ledger";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";
import { assertFileJudgmentPath, modelCall } from "./own-judge-mode.ts";

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
if (step !== "gap") {
  console.error("需要 --step gap 或 --step model");
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
  const restored = restoreCheck();
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

function restoreCheck() {
  const url = process.env.DATABASE_URL ?? "";
  const restored = url.replace(/\/[^/]+$/, "/own_gap_v19_restore_test");
  execFileSync("psql", [url.replace(/\/[^/]+$/, "/postgres"), "-c", "DROP DATABASE IF EXISTS own_gap_v19_restore_test"]);
  execFileSync("psql", [url.replace(/\/[^/]+$/, "/postgres"), "-c", "CREATE DATABASE own_gap_v19_restore_test"]);
  const dump = `${outDir}/dumps/restore-check.dump`;
  mkdirSync(`${outDir}/dumps`, { recursive: true });
  execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", dump, url]);
  execFileSync("pg_restore", ["--no-owner", "--no-acl", `--dbname=${restored}`, dump]);
  const read = (database: string, query: string) => execFileSync("psql", [database, "-At", "-c", query], { encoding: "utf8" }).trim();
  const query = "SELECT count(*) FROM articles";
  const left = read(url, query);
  const right = read(restored, query);
  execFileSync("psql", [url.replace(/\/[^/]+$/, "/postgres"), "-c", "DROP DATABASE IF EXISTS own_gap_v19_restore_test"]);
  if (left !== right) throw new Error(`恢复后的文章数 ${right} 与 ${left} 不同`);
  return { articles: Number(left), dump: sha256(readFileSync(dump)) };
}
