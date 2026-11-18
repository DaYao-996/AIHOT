// Re-read a stored detail response. No second GET for that page.
// A longer extract that still begins with the stored body becomes a new revision and stales the old judgments.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { reviseBodyFromStoredDetail } from "@aihot/backend/content/extract";
import { fillPublicationTime } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { holdBackAutomaticRelease } from "@aihot/backend/own-pipeline-hold";
import { materialForScoring, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { collectSource, loadSource } from "@aihot/backend/sources/collect";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

config.allowPrivateNetworkFetch = true;
const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`需要 ${name}`);
  return process.argv[index + 1]!;
};
const sealPath = flag("--seal");
const configPath = flag("--config");
const outDir = flag("--out-dir");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") {
  throw new Error("采集和模型开关必须关着");
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
const dirty = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "scripts/own-body-boundary.ts", "packages/backend/src/content/extract.ts", "packages/backend/src/own-pipeline-store.ts"], { encoding: "utf8" });
if (dirty.trim()) {
  console.error(dirty);
  process.exit(2);
}
const frozen = JSON.parse(readFileSync(configPath, "utf8")) as {
  earningsUrl: string;
  supplyUrl: string;
  fableUrl: string;
  unchangedDrafts: Array<{ url: string; draftId: string }>;
  fileChain: {
    rulesetVersion: string;
    truncatedPrompt: string; truncatedSelection: string; truncatedDraft: string;
    closingPrompt: string; closingSelection: string; closingDraft: string;
    fixturePrompt: string; fixtureSelection: string; fixtureDraft: string;
  };
};
mkdirSync(`${outDir}/logs`, { recursive: true });
const log = (line: string) => { appendFileSync(`${outDir}/logs/boundary.log`, line + "\n"); console.log(line); };
const recordedAt = "2026-11-18T14:40:00.000Z";

async function analyzeJobs(articleId: string) {
  const rows = await sql<{ state: string; n: number }[]>`
    SELECT state, count(*)::int AS n FROM pgboss.job
    WHERE name = 'content.analyze' AND data->>'articleId' = ${articleId}
    GROUP BY state`;
  return rows;
}

async function writeChain(articleId: string, prompts: { semantic: string; selection: string; draft: string }, note: {
  time: string; rationale: string; draft: string; technicalFixture: boolean; conditions: string[];
  quoteFrom: "added" | "stored"; previousBody?: string;
}) {
  const [row] = await sql<{ url: string; title: string; revision: number; version: number; evidence_hash: string; body_text: string }[]>`
    SELECT a.url, a.title, a.revision, v.version, v.evidence_hash, v.body_text
    FROM articles a
    JOIN LATERAL (
      SELECT version, evidence_hash, body_text FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true
    WHERE a.id = ${articleId}`;
  if (!row) throw new Error("没有当前证据");
  const scoring = await materialForScoring(articleId);
  if (scoring?.bodyText !== row.body_text) throw new Error("评分输入不是当前正文");
  const region = note.quoteFrom === "added" && note.previousBody ? row.body_text.slice(note.previousBody.length) : row.body_text;
  const excerpt = region.slice(80, 140);
  const start = row.body_text.indexOf(excerpt);
  if (start < 0 || excerpt.trim().length < 20) throw new Error(`引文不成立 ${row.url}`);
  const semantic = await recordFileResult({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.semantic,
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "正文里有这一句", quoteLocation: { excerpt, start, end: start + excerpt.length },
      conditions: note.conditions, time: note.time,
      valueBasis: "只引用已保存的正文，不另写事实", audience: ["待审的人"], substantiveAddition: "判断依据是这一句原文",
      clauses: [{ id: "quote", text: "引文必须能在当前正文里按位置取出" }],
    },
  }, recordedAt);
  const again = await recordFileResult({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.semantic,
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "正文里有这一句", quoteLocation: { excerpt, start, end: start + excerpt.length },
      conditions: note.conditions, time: note.time,
      valueBasis: "只引用已保存的正文，不另写事实", audience: ["待审的人"], substantiveAddition: "判断依据是这一句原文",
      clauses: [{ id: "quote", text: "引文必须能在当前正文里按位置取出" }],
    },
  }, recordedAt);
  if (!again.idempotent || again.id !== semantic.id) throw new Error("同一文件语义再次写入不是幂等");
  const selection = await recordSelectionDecision({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.selection,
    decision_rationale: note.rationale, conditions: note.conditions,
    sampleRole: note.technicalFixture ? "local_fixture" : "development_sample",
    qualityAcceptance: false,
  }, recordedAt);
  const draft = await recordReviewDraft({
    articleId, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
    rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: prompts.draft,
    text: note.draft.replaceAll("{excerpt}", excerpt), sourceNote: note.technicalFixture
      ? "本机夹具。稿件引用夹具正文，不是官网选题。"
      : "开发样本。稿件引用当前正文，不采用选题理由，不是质量验收。",
    sourceCitations: [row.url], conditions: ["事实未核", "未许可"], technicalFixture: note.technicalFixture, requiresHumanReview: true,
  }, recordedAt);
  return { url: row.url, semanticId: semantic.id, selectionId: selection.id, draftId: draft.id, idempotent: again.idempotent, excerpt, bodyBytes: Buffer.byteLength(row.body_text) };
}

const report: Record<string, unknown> = { contractPassed: false, workerStarted: false, modelCalls: 0 };
try {
  const kept = [];
  for (const item of frozen.unchangedDrafts) {
    const [row] = await sql<{ stale: boolean; fact_status: string; release_status: string }[]>`
      SELECT stale, fact_status, release_status FROM own_judgments WHERE id = ${item.draftId}`;
    if (!row || row.stale || row.fact_status !== "unchecked" || row.release_status !== "not_licensed") {
      throw new Error(`已有稿件被改动 ${item.draftId}`);
    }
    kept.push(item);
  }
  report.unchangedDrafts = kept;
  log(`UNCHANGED drafts ${kept.length}`);

  const [earnings] = await sql<{ id: string; body_text: string; published_at: Date | null; revision: number }[]>`
    SELECT id, body_text, published_at, revision FROM articles WHERE url = ${frozen.earningsUrl}`;
  if (!earnings) throw new Error("没有财报文章");
  const previousBody = earnings.body_text;
  const previousRevision = Number(earnings.revision);
  const truncated = await writeChain(earnings.id, {
    semantic: frozen.fileChain.truncatedPrompt, selection: frozen.fileChain.truncatedSelection, draft: frozen.fileChain.truncatedDraft,
  }, {
    time: "无发布元数据", quoteFrom: "stored",
    rationale: "这一判断读的是当时已入库的短正文。没有发布元数据，不能当成新消息。开发样本，不是质量验收。",
    draft: "待审。当时入库的正文写有：「{excerpt}」。没有发布元数据，未核，未许可。",
    technicalFixture: false,
    conditions: ["引文取自修订前的正文", "没有发布元数据"],
  });
  const revised = await reviseBodyFromStoredDetail(earnings.id);
  if (revised.status !== "revised" || revised.staled < 3) throw new Error(`修订没有替换短正文 ${JSON.stringify(revised)}`);
  const [after] = await sql<{ body_text: string; published_at: Date | null; revision: number }[]>`
    SELECT body_text, published_at, revision FROM articles WHERE id = ${earnings.id}`;
  const about = after!.body_text.split("About NVIDIA").length - 1;
  if (!after!.body_text.startsWith(previousBody) || about !== 1 || after!.body_text.includes("NVIDIA Partner Network") || after!.published_at) {
    throw new Error("修订后的正文边界不对，或写入了发布时间");
  }
  if (!after!.body_text.includes("world leader in AI") || !after!.body_text.includes("Non-GAAP operating expenses")) {
    throw new Error("修订后的正文缺收束或展望表");
  }
  const [staleRow] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${truncated.draftId}`;
  if (!staleRow?.stale) throw new Error("短正文上的待审稿没有失效");
  const again = await reviseBodyFromStoredDetail(earnings.id);
  if (again.status !== "unchanged" || again.revision !== revised.revision) throw new Error("同一份原页再次读取不是幂等");
  const closing = await writeChain(earnings.id, {
    semantic: frozen.fileChain.closingPrompt, selection: frozen.fileChain.closingSelection, draft: frozen.fileChain.closingDraft,
  }, {
    time: "无发布元数据", quoteFrom: "added", previousBody,
    rationale: "这篇没有发布元数据，不能当成新消息。多出来的是同一稿件的收束，不是页脚导航。开发样本，不是留出质量验收。",
    draft: "待审。修订后的正文另写有：「{excerpt}」。没有发布元数据，未核，未许可。",
    technicalFixture: false,
    conditions: ["引文取自原页收束", "没有发布元数据"],
  });
  report.earnings = {
    previousBytes: Buffer.byteLength(previousBody), previousRevision, revised, closing,
    publishedAt: null, about, footerIncluded: false, secondRead: again.status,
  };
  log(`EARNINGS ${previousRevision} -> ${revised.revision} bytes ${Buffer.byteLength(previousBody)} -> ${revised.bodyBytes} staled ${revised.staled}`);

  const fixture = await runFixture();
  report.fixture = fixture;
  log(`FIXTURE analyze ${fixture.analyzeBefore.map((row) => row.state + ":" + row.n).join(",")} -> ${fixture.analyzeAfter.length}`);

  report.supply = await oneOfficial(frozen.supplyUrl);
  report.fable = await oneOfficial(frozen.fableUrl);
  const [counts] = await sql<{ publications: number; receipts: number; judgments: number; stale: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications,
           (SELECT count(*)::int FROM receipts) AS receipts,
           (SELECT count(*)::int FROM own_judgments) AS judgments,
           (SELECT count(*)::int FROM own_judgments WHERE stale) AS stale`;
  report.publications = counts!.publications;
  report.receipts = counts!.receipts;
  report.judgments = counts!.judgments;
  report.staleJudgments = counts!.stale;
  if (counts!.publications !== 0 || counts!.receipts !== 0) throw new Error("出现了发布或回执");
  writeFileSync(`${outDir}/BOUNDARY.json`, JSON.stringify(report, null, 2));
  log(JSON.stringify({ ok: true, publications: 0, receipts: 0, judgments: counts!.judgments, stale: counts!.stale }));
} finally {
  await stopBoss();
  await closeDb();
}

async function oneOfficial(url: string) {
  const [article] = await sql<{ id: string; source_id: string; body_text: string; published_at: Date | null }[]>`
    SELECT id, source_id, body_text, published_at FROM articles WHERE url = ${url}`;
  if (!article) throw new Error(`没有文章 ${url}`);
  const source = await loadSource(article.source_id);
  if (!source) throw new Error(`没有源 ${article.source_id}`);
  try {
    const got = await fetchDetail(url, source, { date: true, title: false, summary: false, body: true });
    const bytes = got.response?.bytes ?? Buffer.alloc(0);
    const extracted = got.body?.text ?? "";
    const note = `stored response; extractedBytes=${Buffer.byteLength(extracted)} rawBytes=${bytes.length}; not a completeness claim`;
    await sql`INSERT INTO own_detail_responses (source_id, url, http_status, response, response_sha256, truncated, extracted_bytes, extraction_note)
      VALUES (${source.id}, ${url}, ${got.response?.status ?? null}, ${bytes}, ${sha256(bytes)}, ${got.response?.truncated ?? false}, ${Buffer.byteLength(extracted)}, ${note})`;
    const revised = await reviseBodyFromStoredDetail(article.id);
    if (revised.status === "revised") await holdBackAutomaticRelease(sql, article.id);
    let dated = false;
    if (!article.published_at && got.publishedAt) {
      const filled = await fillPublicationTime(sql, article.id, got.publishedAt, undefined, got.publicationTime);
      dated = !!filled?.publishedAt;
    }
    const [now] = await sql<{ published_at: Date | null; n: number }[]>`
      SELECT published_at, octet_length(body_text)::int AS n FROM articles WHERE id = ${article.id}`;
    log(`GET ${url} status=${got.response?.status} raw=${bytes.length} revise=${revised.status} dated=${dated}`);
    return {
      url, status: got.response?.status ?? null, rawBytes: bytes.length, sha256: sha256(bytes),
      extractedBytes: Buffer.byteLength(extracted), revise: revised.status, bodyBytes: now!.n,
      publishedAt: now!.published_at?.toISOString() ?? null, dateFromPageMetadata: dated, retried: false,
    };
  } catch (error) {
    const status = error instanceof HttpStatusError ? error.status : null;
    const message = error instanceof Error ? error.message.slice(0, 180) : String(error);
    await sql`INSERT INTO fetch_runs (source_id, status, finished_at, found_count, new_count, error, detail)
      VALUES (${article.source_id}, 'failed', now(), 0, 0, ${message}, ${sql.json({ requests: 1, httpStatus: status, retryable: false, bypassed403: false })})`;
    log(`GET FAIL ${url} status=${status} ${message}`);
    return { url, status, error: message, retried: false, bypassed403: false };
  }
}

async function runFixture() {
  const pages = new Map<string, string>();
  const listings = new Map<string, Array<{ url: string; title: string; date: string | null }>>();
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const page = pages.get(path);
    if (page !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    const listing = listings.get(path);
    if (!listing) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(listing.map((item) => `<article><a href="${item.url}">${item.title}</a>${item.date ? `<time datetime="${item.date}"></time>` : ""}</article>`).join(""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const sourceId = "local-fixture-v18";
  const freshPath = "/article/local-fixture-v18/recovered";
  const freshUrl = `${base}${freshPath}`;
  pages.set(freshPath, `<html><head><meta name="original-publication" content="2026-11-17"></head><body><article><p>${"A full article paragraph. ".repeat(40)}</p><p>See <a href="https://example.org/paper.pdf">the paper</a>.</p></article></body></html>`);
  const listingPath = "/listing/local-fixture-v18";
  const known = { url: `${base}/article/local-fixture-v18/known`, title: "本地夹具已知条目", date: "2026-11-17T00:00:00.000Z" };
  listings.set(listingPath, [known]);
  try {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
      VALUES (${sourceId}, '本地夹具', 'web_list', ${sql.json({
        url: base + listingPath, itemSelector: "article", linkSelector: "a", titleSelector: "a",
        publishedAtSelector: "time", publishedAtUtcOffset: "+08:00",
        allowUrlPrefixes: [`${base}/`],
        detail: { maxFetches: 0 },
        _aihot: { initialBackfillLimit: 1 },
      })}, 'T1', 'editorial', '2100-01-01')`;
    const first = await collectSource(sourceId, { force: true });
    listings.set(listingPath, [{ url: freshUrl, title: "本地夹具离榜条目", date: null }, known]);
    const held = await collectSource(sourceId, { force: true });
    const [notStored] = await sql`SELECT id FROM articles WHERE url = ${freshUrl}`;
    if (notStored || held.created !== 0) throw new Error("无日期夹具在补详情前就被写成文章");
    listings.set(listingPath, [known]);
    await sql`UPDATE sources SET config = jsonb_set(config, '{detail}', ${sql.json({ maxFetches: 1, publishedAtSelector: 'meta[name="original-publication"]', publishedAtUtcOffset: "+08:00" })}) WHERE id = ${sourceId}`;
    const opened = await collectSource(sourceId, { force: true });
    const [saved] = await sql<{ id: string; published_at: Date | null; body_status: string }[]>`
      SELECT id, published_at, body_status FROM articles WHERE url = ${freshUrl}`;
    if (!saved || opened.created !== 1 || saved.body_status !== "ok" || !saved.published_at) throw new Error("夹具没有按页面日期收回");
    const published = saved.published_at.toISOString();
    if (published.slice(0, 10) === "2026-11-18") throw new Error("夹具把抓取当天写成了发布时间");
    const analyzeBefore = await analyzeJobs(saved.id);
    if (!analyzeBefore.some((row) => row.state === "created" && row.n > 0)) throw new Error("收回后没有停在 created 的分析作业");
    const chain = await writeChain(saved.id, {
      semantic: frozen.fileChain.fixturePrompt, selection: frozen.fileChain.fixtureSelection, draft: frozen.fileChain.fixtureDraft,
    }, {
      time: published.slice(0, 10), quoteFrom: "stored", technicalFixture: true,
      rationale: "这是本机夹具，不是官网选题。页面日期只说明技术链能接上，不构成真实选题。",
      draft: "待审夹具。正文写有：「{excerpt}」。这不是官网稿件。",
      conditions: ["本机夹具", "不是官网选题"],
    });
    const analyzeAfter = await analyzeJobs(saved.id);
    if (analyzeAfter.length !== 0) throw new Error("写上判断之后分析作业还在");
    const [state] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${saved.id}`;
    if (state!.processing_state !== "skipped") throw new Error("夹具判断没有离开自动分析");
    await sql`UPDATE sources SET enabled = false, next_fetch_at = '2100-01-01' WHERE id = ${sourceId}`;
    return {
      technicalFixture: true, officialTopic: false, created: first.created, recovered: opened.created,
      publishedAt: published, analyzeBefore, analyzeAfter, chain, processingState: state!.processing_state,
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
