// Temporary acceptance probe. Not part of the repository. Throwaway database only.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NODE = process.env.PROBE_NODE ?? process.execPath;
const ROOT = "/workspace";
const URL = "postgres://own_audit:own_audit@127.0.0.1:5432/own_probe_v6_test";
process.env.DATABASE_URL = URL;
process.env.COLLECT_ENABLED = "false";
process.env.MODEL_CALLS_ENABLED = "false";
process.env.FEISHU_CONTENT_PUSH_ENABLED = "false";
process.env.DINGTALK_CONTENT_PUSH_ENABLED = "false";
process.env.FEISHU_INTERNAL_ENABLED = "false";
process.env.INDEXNOW_SUBMIT_ENABLED = "false";
process.env.BAIDU_PUSH_ENABLED = "false";
delete process.env.INDEXNOW_KEY;
delete process.env.BAIDU_PUSH_TOKEN;
delete process.env.DAJIALA_KEY;

const quiet = {
  ...process.env,
  DATABASE_URL: URL,
  COLLECT_ENABLED: "false",
  MODEL_CALLS_ENABLED: "false",
  FEISHU_CONTENT_PUSH_ENABLED: "false",
  DINGTALK_CONTENT_PUSH_ENABLED: "false",
  FEISHU_INTERNAL_ENABLED: "false",
  INDEXNOW_SUBMIT_ENABLED: "false",
  BAIDU_PUSH_ENABLED: "false",
};

const findings: Record<string, unknown>[] = [];
function note(id: string, data: Record<string, unknown>) {
  findings.push({ id, ...data });
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runNode(args: string[], env: NodeJS.ProcessEnv = quiet) {
  return spawnSync(NODE, args, { cwd: ROOT, encoding: "utf8", env });
}

const migrate1 = runNode(["scripts/own-migrate.ts"]);
const migrate2 = runNode(["scripts/own-migrate.ts"]);
note("migrate", {
  firstStatus: migrate1.status,
  firstStdout: migrate1.stdout.trim(),
  firstStderr: migrate1.stderr.trim(),
  secondStatus: migrate2.status,
  secondStdout: migrate2.stdout.trim(),
  secondStderr: migrate2.stderr.trim(),
});

const safety = runNode(["scripts/own-safety-check.ts"]);
note("safety-default", { status: safety.status, stdout: safety.stdout.trim(), stderr: safety.stderr.trim() });

const { closeDb, sql } = await import("@aihot/backend/db");
const { sha256, stableJson } = await import("@aihot/backend/lib/ids");
const {
  HISTORICAL_RULESET,
  cliEntryAllowed,
  cumulativeEvidenceHash,
  mapControlledImport,
  parseImportDocument,
} = await import("/workspace/site/own-pipeline.ts");
const { JudgmentConflict, appendControlledEvidence, commitControlledLoop, recordJudgment } = await import("@aihot/backend/own-pipeline-store");

const SOURCE = "own-probe-src";
await sql`INSERT INTO sources (id, name, kind, participation_mode, next_fetch_at)
  VALUES (${SOURCE}, 'Own audit probe', 'external', 'isolated', '2100-01-01')`;

const binding = { rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null };
const dir = mkdtempSync(path.join(tmpdir(), "own-probe-"));
let n = 0;
const url = () => `https://example.com/probe-${++n}`;

function file(name: string, body: unknown): string {
  const target = path.join(dir, name);
  writeFileSync(target, JSON.stringify(body));
  return target;
}

function cli(filePath: string, env: NodeJS.ProcessEnv = quiet) {
  const result = runNode(["scripts/own-import.ts", "--file", filePath], env);
  let parsed: unknown = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), json: parsed as any };
}

function rawDoc(sourceId: string, item: Record<string, unknown>, rawSha?: string) {
  return { sourceId, items: [{ ...item, ...(rawSha === undefined ? {} : { rawSha256: rawSha }) }] };
}

const canonicalOf = (raw: unknown) => sha256(stableJson(raw));

// --- hash semantics ---
const rawObj = { b: 1, aa: 2, text: "中文原件" };
const fileBytes = Buffer.from('{"b":1,"aa":2,"text":"\\u4e2d\\u6587\\u539f\\u4ef6"}', "utf8");
const parsed = JSON.parse(fileBytes.toString("utf8"));
const byteHash = sha256Bytes(fileBytes);
const canonicalHash = canonicalOf(parsed);
const prettyBytes = Buffer.from(JSON.stringify(rawObj, null, 2), "utf8");
note("hash-semantics-before-db", {
  byteHash,
  canonicalHash,
  prettyByteHash: sha256Bytes(prettyBytes),
  byteEqualsCanonical: byteHash === canonicalHash,
  prettyEqualsCanonical: sha256Bytes(prettyBytes) === canonicalHash,
  stableJson: stableJson(parsed),
  fileText: fileBytes.toString("utf8"),
});

const byteFile = file("byte-hash.json", rawDoc(SOURCE, {
  url: url(), title: "字节哈希", raw: parsed,
}, byteHash));
const byteRun = cli(byteFile);
note("cli-rejects-file-byte-hash", { status: byteRun.status, json: byteRun.json, stderr: byteRun.stderr });

const canonUrl = url();
const canonFile = file("canon.json", rawDoc(SOURCE, {
  url: canonUrl, title: "规范哈希", raw: parsed,
}, canonicalHash));
const canon1 = cli(canonFile);
const canon2 = cli(canonFile);
const [stored] = await sql<{ raw_text: string; raw: unknown; body_text: string | null }[]>`
  SELECT raw::text AS raw_text, raw, body_text FROM articles WHERE url = ${canonUrl}`;
note("cli-canonical-hash-and-jsonb", {
  first: canon1.json,
  secondCounts: canon2.json?.counts,
  secondStatus: canon2.status,
  storedRawText: stored?.raw_text ?? null,
  storedEqualsFile: stored?.raw_text === fileBytes.toString("utf8"),
  storedEqualsStable: stored ? stableJson(stored.raw) === stableJson(parsed) : false,
  bodyText: stored?.body_text ?? null,
  reportedRawSha: canon1.json?.items?.[0]?.rawSha256 ?? null,
  reportedEqualsByte: canon1.json?.items?.[0]?.rawSha256 === byteHash,
  reportedEqualsCanonical: canon1.json?.items?.[0]?.rawSha256 === canonicalHash,
});

// --- incomplete idempotency, no judgment ---
const missUrl = url();
const missRaw = { kind: "miss", text: "只在原件里的正文" };
const missFile = file("miss.json", rawDoc(SOURCE, { url: missUrl, title: "缺正文", raw: missRaw }, canonicalOf(missRaw)));
const miss1 = cli(missFile);
const miss2 = cli(missFile);
const [missJudged] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM own_judgments j JOIN articles a ON a.id = j.article_id WHERE a.url = ${missUrl}`;
const missVersions = await sql<{ version: number; raw: unknown; body_text: string | null }[]>`
  SELECT v.version, v.raw, v.body_text FROM own_evidence_versions v
  JOIN articles a ON a.id = v.article_id WHERE a.url = ${missUrl} ORDER BY v.version`;
note("cli-incomplete-idempotent", {
  first: miss1.json?.counts, second: miss2.json?.counts, secondStatus: miss2.status,
  judgments: missJudged?.n, versions: missVersions.map((row) => ({ version: row.version, body: row.body_text, hasRaw: row.raw !== null })),
  rawTextNotPromoted: missVersions[0] ? stableJson(missVersions[0].raw) === stableJson(missRaw) && missVersions[0].body_text === null : false,
});

// --- complete body writes a deterministic reference_only row ---
const scoredUrl = url();
const scoredRaw = { kind: "body", text: "原件里的另一段" };
const scoredItem = { url: scoredUrl, title: "有正文", raw: scoredRaw, bodyText: "显式正文", rawSha256: canonicalOf(scoredRaw) };
const scoredFile = file("scored.json", { sourceId: SOURCE, items: [scoredItem] });
const scored1 = cli(scoredFile);
const scored2 = cli(scoredFile);
const articleId = scored1.json?.items?.[0]?.articleId as string;
const [placeholder] = await sql<{
  stale: boolean; origin: string; value_status: string; material_status: string; fact_status: string;
  release_status: string; reasons: string[]; prompt_version: string; model_version: string; ruleset_version: string;
  input_revision: number; recorded_at: string;
}[]>`SELECT stale, origin, value_status, material_status, fact_status, release_status, reasons, prompt_version, model_version,
      ruleset_version, input_revision, recorded_at::text FROM own_judgments WHERE article_id = ${articleId}`;
const [articleRow] = await sql<{ revision: number; processing_state: string; queued: Date | null; publications: number; deliveries: number; analyses: number }[]>`
  SELECT revision, processing_state, processing_queued_at AS queued,
    (SELECT count(*)::int FROM publications p WHERE p.article_id = articles.id) AS publications,
    (SELECT count(*)::int FROM deliveries d WHERE d.subject_id = articles.id) AS deliveries,
    (SELECT count(*)::int FROM analyses an WHERE an.article_id = articles.id) AS analyses
  FROM articles WHERE id = ${articleId}`;
let conflict = "";
try {
  await recordJudgment({
    articleId, inputRevision: placeholder!.input_revision, evidenceHash: scored1.json.items[0].evidenceHash,
    rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null,
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "deterministic", reasons: ["真正对照之后的理由"],
  }, "2026-11-18T08:00:00.000Z");
} catch (error) {
  conflict = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
const [afterConflict] = await sql<{ reasons: string[]; recorded_at: string; n: number }[]>`
  SELECT reasons, recorded_at::text, count(*) OVER ()::int AS n FROM own_judgments WHERE article_id = ${articleId}`;
note("cli-complete-placeholder-judgment", {
  firstCounts: scored1.json?.counts,
  firstItem: scored1.json?.items?.[0],
  secondCounts: scored2.json?.counts,
  secondStatus: scored2.status,
  row: placeholder,
  article: articleRow,
  laterRealReason: conflict,
  reasonsAfterConflict: afterConflict?.reasons,
  recordedAtUnchanged: afterConflict?.recorded_at === placeholder?.recorded_at,
  rowCount: afterConflict?.n,
});

// mapped evidence hash is not the stored hash
const mapped = mapControlledImport({ sourceId: SOURCE, url: scoredUrl, title: "有正文", raw: scoredRaw, bodyText: "显式正文" });
const mappedOtherRaw = mapControlledImport({ sourceId: SOURCE, url: scoredUrl, title: "有正文", raw: { ...scoredRaw, extra: 1 }, bodyText: "显式正文" });
let mappedBind = "";
try {
  await recordJudgment({
    articleId, inputRevision: articleRow!.revision, evidenceHash: mapped.evidenceHash,
    ...binding,
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "deterministic", reasons: ["用映射哈希"],
  }, "2026-11-18T08:01:00.000Z");
} catch (error) {
  mappedBind = error instanceof Error ? error.message : String(error);
}
note("two-evidence-hashes", {
  stored: scored1.json?.items?.[0]?.evidenceHash,
  mapped: mapped.evidenceHash,
  mappedIgnoresRawChange: mapped.evidenceHash === mappedOtherRaw.evidenceHash,
  bindWithMappedHash: mappedBind,
});

// model origin with unchecked fact and reference_only is accepted when versions are non-empty
const modelRow = await recordJudgment({
  articleId, inputRevision: placeholder!.input_revision, evidenceHash: scored1.json.items[0].evidenceHash,
  rulesetVersion: HISTORICAL_RULESET, promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
}, {
  informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
  valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "model", reasons: ["未调用模型，只填了版本字符串"],
}, "2026-11-18T08:02:00.000Z");
note("model-origin-without-a-call", { id: modelRow.id, origin: modelRow.body.origin, value: modelRow.body.valueStatus, fact: modelRow.body.factStatus, idempotent: modelRow.idempotent });

let emptyModel = "";
try {
  await recordJudgment({
    articleId, inputRevision: placeholder!.input_revision, evidenceHash: scored1.json.items[0].evidenceHash,
    rulesetVersion: "other", promptVersion: "  ", modelVersion: null,
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "model", reasons: ["空版本"],
  }, "2026-11-18T08:03:00.000Z");
} catch (error) {
  emptyModel = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
let sqlModel = "";
try {
  await sql`INSERT INTO own_judgments (id, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
    material_status, fact_status, value_status, release_status, origin, reasons, recorded_at)
    VALUES (${`sql-${sha256("empty-model")}`}, ${articleId}, ${placeholder!.input_revision}, ${scored1.json.items[0].evidenceHash},
      'sql-rules', '', '', 'complete', 'unchecked', 'reference_only', 'not_licensed', 'model', ${sql.json(["绕过应用"] as never)}, now())`;
} catch (error) {
  sqlModel = error instanceof Error ? error.message : String(error);
}
note("empty-model-version-rejected", { application: emptyModel, database: sqlModel });

// --- title change desynchronises revision ---
const titleUrl = url();
const titleRaw = { kind: "title", n: 1 };
const titleBase = { url: titleUrl, title: "标题甲", raw: titleRaw, bodyText: "同一正文", rawSha256: canonicalOf(titleRaw) };
const title1 = cli(file("title1.json", { sourceId: SOURCE, items: [titleBase] }));
const title2 = cli(file("title2.json", { sourceId: SOURCE, items: [{ ...titleBase, title: "标题乙" }] }));
const title3 = cli(file("title2.json", { sourceId: SOURCE, items: [{ ...titleBase, title: "标题乙" }] }));
const [titleArticle] = await sql<{ id: string; revision: number; title: string; processing_state: string }[]>`
  SELECT id, revision, title, processing_state FROM articles WHERE url = ${titleUrl}`;
const titleEvidence = await sql<{ version: number; article_revision: number; evidence_hash: string; body_text: string | null }[]>`
  SELECT version, article_revision, evidence_hash, body_text FROM own_evidence_versions WHERE article_id = ${titleArticle!.id} ORDER BY version`;
const titleJudgments = await sql<{ stale: boolean; input_revision: number; evidence_hash: string; reasons: string[] }[]>`
  SELECT stale, input_revision, evidence_hash, reasons FROM own_judgments WHERE article_id = ${titleArticle!.id} ORDER BY created_at`;
note("cli-title-change-breaks-binding", {
  firstStatus: title1.status, firstCounts: title1.json?.counts,
  secondStatus: title2.status, secondCounts: title2.json?.counts, secondItem: title2.json?.items?.[0],
  retryStatus: title3.status, retryCounts: title3.json?.counts, retryItem: title3.json?.items?.[0],
  article: titleArticle, evidence: titleEvidence, judgments: titleJudgments,
});

// commitControlledLoop rolls the same mismatch back
const loopUrl = url();
const loopItem = { sourceId: SOURCE, url: loopUrl, title: "循环甲", raw: { kind: "loop" }, bodyText: "循环正文" };
const loopBody = {
  informationTypeId: null, contentLine: null, materialStatus: "complete" as const, factStatus: "unchecked" as const,
  valueStatus: "reference_only" as const, releaseStatus: "not_licensed" as const, origin: "deterministic" as const, reasons: ["未评分"],
};
const loopFirst = await commitControlledLoop(loopItem, loopBody, "2026-11-18T09:00:00.000Z", binding);
let loopError = "";
try {
  await commitControlledLoop({ ...loopItem, title: "循环乙" }, loopBody, "2026-11-18T09:01:00.000Z", binding);
} catch (error) {
  loopError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
const [loopArticle] = await sql<{ revision: number; title: string }[]>`SELECT revision, title FROM articles WHERE id = ${loopFirst.evidence.articleId}`;
note("library-title-change-rolls-back", { error: loopError, article: loopArticle, firstRevision: loopFirst.evidence.articleRevision });

// publishedAt addition also bumps revision without a new evidence hash
const dateUrl = url();
const dateRaw = { kind: "date" };
const dateBase = { url: dateUrl, title: "补时间", raw: dateRaw, bodyText: "补时间正文", rawSha256: canonicalOf(dateRaw) };
const date1 = cli(file("date1.json", { sourceId: SOURCE, items: [dateBase] }));
const date2 = cli(file("date2.json", { sourceId: SOURCE, items: [{ ...dateBase, publishedAt: "2024-01-15T00:00:00.000Z" }] }));
const [dateArticle] = await sql<{ id: string; revision: number; published_at: Date | null }[]>`
  SELECT id, revision, published_at FROM articles WHERE url = ${dateUrl}`;
const dateEvidence = await sql<{ version: number; article_revision: number }[]>`
  SELECT version, article_revision FROM own_evidence_versions WHERE article_id = ${dateArticle!.id} ORDER BY version`;
const dateJudgments = await sql<{ stale: boolean; input_revision: number }[]>`
  SELECT stale, input_revision FROM own_judgments WHERE article_id = ${dateArticle!.id}`;
note("cli-published-at-breaks-binding", {
  firstStatus: date1.status, secondStatus: date2.status, secondCounts: date2.json?.counts, secondItem: date2.json?.items?.[0],
  article: { id: dateArticle!.id, revision: dateArticle!.revision, publishedAt: dateArticle!.published_at?.toISOString() ?? null },
  evidence: dateEvidence, judgments: dateJudgments,
});

// --- supplement quote / second raw / resubmit old raw / null quote ---
const supUrl = url();
const rawA = { kind: "A", text: "第一份原件" };
const rawB = { kind: "B", text: "第二份原件" };
const sup = await appendControlledEvidence({ sourceId: SOURCE, url: supUrl, title: "补充", raw: rawA, bodyText: "正文一", quotedText: "引用一" });
const supJudgment = await recordJudgment({
  articleId: sup.articleId, inputRevision: sup.articleRevision, evidenceHash: sup.evidenceHash, ...binding,
}, loopBody, "2026-11-18T10:00:00.000Z");
const supBody = await appendControlledEvidence({ sourceId: SOURCE, url: supUrl, title: "补充", raw: rawA, bodyText: "正文二", quotedText: "引用一" });
const [staleAfterBody] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${supJudgment.id}`;
const supQuote = await appendControlledEvidence({ sourceId: SOURCE, url: supUrl, title: "补充", raw: rawA, bodyText: "正文二", quotedText: "引用二" });
const supNewRaw = await appendControlledEvidence({ sourceId: SOURCE, url: supUrl, title: "补充", raw: rawB, bodyText: "正文二", quotedText: "引用二" });
const supResubmit = await appendControlledEvidence({ sourceId: SOURCE, url: supUrl, title: "补充", raw: rawA, bodyText: "正文二", quotedText: "引用二" });
const supNullQuote = await appendControlledEvidence({ sourceId: SOURCE, url: supUrl, title: "补充", raw: rawB, bodyText: "正文三", quotedText: null });
const versions = await sql<{ version: number; raw: unknown; body_text: string | null; quoted_text: string | null; article_revision: number; evidence_hash: string }[]>`
  SELECT version, raw, body_text, quoted_text, article_revision, evidence_hash FROM own_evidence_versions
  WHERE article_id = ${sup.articleId} ORDER BY version`;
const [articleRaw] = await sql<{ raw: unknown; revision: number }[]>`SELECT raw, revision FROM articles WHERE id = ${sup.articleId}`;
const active = await sql<{ evidence_hash: string; stale: boolean }[]>`
  SELECT evidence_hash, stale FROM own_judgments WHERE article_id = ${sup.articleId} AND origin = 'deterministic' AND model_version = ''`;
note("evidence-versions", {
  hashes: { first: sup.evidenceHash, body: supBody.evidenceHash, quote: supQuote.evidenceHash, newRaw: supNewRaw.evidenceHash, resubmit: supResubmit.evidenceHash, nullQuote: supNullQuote.evidenceHash },
  idempotentFlags: { resubmit: supResubmit.idempotent, nullQuote: supNullQuote.idempotent },
  firstJudgmentStaleAfterBody: staleAfterBody?.stale,
  articleRawIsFirst: stableJson(articleRaw!.raw) === stableJson(rawA),
  articleRevision: articleRaw!.revision,
  versions: versions.map((row) => ({ version: row.version, revision: row.article_revision, body: row.body_text, quote: row.quoted_text, raw: row.raw, hash: row.evidence_hash })),
  deterministicJudgments: active,
});

// explicit null xPost clears; null quote above did not
const xUrl = url();
const xPost = { tweetId: "2117095432526700766", authorName: "A", handle: "someone", text: "帖子" };
const x1 = await appendControlledEvidence({ sourceId: SOURCE, url: xUrl, title: "帖", raw: { kind: "x" }, bodyText: "帖子", xPost });
const x2 = await appendControlledEvidence({ sourceId: SOURCE, url: xUrl, title: "帖", raw: { kind: "x" }, bodyText: "帖子", xPost: null });
const xVersions = await sql<{ version: number; x_post: unknown; evidence_hash: string }[]>`
  SELECT version, x_post, evidence_hash FROM own_evidence_versions WHERE article_id = ${x1.articleId} ORDER BY version`;
note("null-xpost-clears", {
  hashChanged: x1.evidenceHash !== x2.evidenceHash,
  idempotent: x2.idempotent,
  versions: xVersions.map((row) => ({ version: row.version, hasPost: row.x_post !== null })),
});

// quote supplement invalidates, and a new judgment can bind
const qUrl = url();
const q1 = await commitControlledLoop(
  { sourceId: SOURCE, url: qUrl, title: "引用", raw: { kind: "q" }, bodyText: "正文" },
  { ...loopBody, reasons: ["尚无引用"] }, "2026-11-18T11:00:00.000Z", binding,
);
const q2 = await commitControlledLoop(
  { sourceId: SOURCE, url: qUrl, title: "引用", raw: { kind: "q" }, bodyText: "正文", quotedText: "新引用" },
  { ...loopBody, reasons: ["补了引用"] }, "2026-11-18T11:01:00.000Z", binding,
);
const qRows = await sql<{ stale: boolean; evidence_hash: string; reasons: string[] }[]>`
  SELECT stale, evidence_hash, reasons FROM own_judgments WHERE article_id = ${q1.evidence.articleId} AND model_version = '' ORDER BY created_at`;
const qVersions = await sql<{ version: number; raw: unknown; quoted_text: string | null }[]>`
  SELECT version, raw, quoted_text FROM own_evidence_versions WHERE article_id = ${q1.evidence.articleId} ORDER BY version`;
note("quote-supplement-stales", {
  oldStale: qRows[0]?.stale, newStale: qRows[1]?.stale,
  hashesDiffer: q1.evidence.evidenceHash !== q2.evidence.evidenceHash,
  oldRawKept: qVersions[0] ? stableJson(qVersions[0].raw) === stableJson({ kind: "q" }) : false,
  newRawNull: qVersions[1]?.raw === null,
  quotes: qVersions.map((row) => row.quoted_text),
});

// other ruleset stays fresh when evidence is unchanged
const other = await recordJudgment({ ...q2.judgment.identity, rulesetVersion: "other-ruleset" }, { ...loopBody, reasons: ["另一规则"] }, "2026-11-18T11:02:00.000Z");
const [oldRule] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${q2.judgment.id}`;
note("no-db-stale-matching", { otherStale: other.stale, originalRuleStale: oldRule?.stale, storeExportsStaleMatching: false });

// concurrent first insert and conflicting reasons
const raceUrl = url();
const raceEv = await appendControlledEvidence({ sourceId: SOURCE, url: raceUrl, title: "并发", raw: { n: 1 }, bodyText: "并发正文" });
const raceIdentity = { articleId: raceEv.articleId, inputRevision: raceEv.articleRevision, evidenceHash: raceEv.evidenceHash, ...binding };
const raceBody = { ...loopBody, reasons: ["并发赢家"] };
const firstWrites = await Promise.allSettled(Array.from({ length: 8 }, () => recordJudgment(raceIdentity, raceBody, "2026-11-18T12:00:00.000Z")));
const [raceCount] = await sql<{ n: number; reasons: string[] }[]>`
  SELECT count(*)::int AS n, (array_agg(reasons))[1] AS reasons FROM own_judgments WHERE article_id = ${raceEv.articleId}`;
const conflicts = await Promise.allSettled([
  recordJudgment(raceIdentity, { ...raceBody, reasons: ["冲突甲"] }, "2026-11-18T12:00:01.000Z"),
  recordJudgment(raceIdentity, { ...raceBody, reasons: ["冲突乙"] }, "2026-11-18T12:00:01.000Z"),
  recordJudgment(raceIdentity, raceBody, "2026-11-18T12:00:01.000Z"),
]);
const [afterRace] = await sql<{ n: number; reasons: string[] }[]>`
  SELECT count(*)::int AS n, reasons FROM own_judgments WHERE article_id = ${raceEv.articleId} GROUP BY reasons`;
note("concurrency-and-reason-conflict", {
  firstWrites: firstWrites.map((row) => row.status === "fulfilled" ? { ok: true, idempotent: row.value.idempotent, id: row.value.id } : { ok: false, reason: row.reason instanceof Error ? row.reason.message : String(row.reason) }),
  rowCount: raceCount?.n,
  conflictResults: conflicts.map((row) => row.status === "fulfilled" ? "stored" : (row.reason instanceof Error ? row.reason.name : "reject")),
  surviving: afterRace,
});

// concurrent distinct raws
const bothUrl = url();
const both = await Promise.allSettled([
  appendControlledEvidence({ sourceId: SOURCE, url: bothUrl, title: "两份", raw: { side: "left" }, bodyText: "左" }),
  appendControlledEvidence({ sourceId: SOURCE, url: bothUrl, title: "两份", raw: { side: "right" }, bodyText: "右" }),
]);
const bothRows = await sql<{ version: number; raw: unknown; body_text: string | null }[]>`
  SELECT v.version, v.raw, v.body_text FROM own_evidence_versions v JOIN articles a ON a.id = v.article_id
  WHERE a.url = ${bothUrl} ORDER BY v.version`;
note("concurrent-distinct-raws", {
  results: both.map((row) => row.status === "fulfilled" ? { ok: true, version: row.value.evidenceVersion, hash: row.value.evidenceHash } : { ok: false, reason: row.reason instanceof Error ? row.reason.message : String(row.reason) }),
  versions: bothRows.map((row) => ({ version: row.version, body: row.body_text, raw: row.raw })),
});

// gates
const blocked = cli(missFile, { ...quiet, COLLECT_ENABLED: "true" });
const blockedModel = cli(missFile, { ...quiet, MODEL_CALLS_ENABLED: "true" });
const beforeBlock = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE url = ${missUrl}`;
const unknown = cli(file("unknown.json", { sourceId: SOURCE, items: [{ url: "https://example.com/nope", title: "坏", raw: { a: 1 }, score: 9 }] }));
const missingSource = cli(file("nosrc.json", rawDoc("missing-source", { url: "https://example.com/no-source", title: "无源", raw: { a: 1 } })));
const dry = runNode(["scripts/own-import.ts", "--file", missFile, "--dry-run"]);
let storeDespiteSwitch = "";
process.env.COLLECT_ENABLED = "true";
process.env.MODEL_CALLS_ENABLED = "true";
try {
  const sneaky = await appendControlledEvidence({ sourceId: SOURCE, url: url(), title: "开关挡不住库", raw: { sneaky: true } });
  storeDespiteSwitch = `wrote ${sneaky.articleId} v${sneaky.evidenceVersion}`;
} catch (error) {
  storeDespiteSwitch = error instanceof Error ? error.message : String(error);
}
process.env.COLLECT_ENABLED = "false";
process.env.MODEL_CALLS_ENABLED = "false";
note("gates", {
  collectBlocked: { status: blocked.status, stderr: blocked.stderr, stdout: blocked.stdout },
  modelBlocked: { status: blockedModel.status, stderr: blockedModel.stderr },
  incompleteArticleStillOne: beforeBlock?.[0]?.n,
  unknownStatus: unknown.status,
  missingSource: missingSource.json ?? missingSource.stderr,
  dryStatus: dry.status,
  dryStdout: dry.stdout.trim(),
  cliAllowsWhenRetentionWouldArm: cliEntryAllowed({}).ok,
  localDeleteIfWorker: cliEntryAllowed({}).localDeleteIfWorker,
  storeIgnoresSwitches: storeDespiteSwitch,
});

const schemas = await sql<{ nspname: string }[]>`SELECT nspname FROM pg_namespace WHERE nspname ILIKE '%boss%' OR nspname = 'public' ORDER BY 1`;
let jobs = "schema-absent";
const boss = schemas.find((row) => row.nspname === "pgboss");
if (boss) {
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job`;
  jobs = String(count?.n ?? 0);
}
const [targets] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notify_targets`;
const [sources] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources`;
const constraints = await sql<{ name: string; validated: boolean; def: string }[]>`
  SELECT conname AS name, convalidated AS validated, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE conname LIKE 'own_judgments%' ORDER BY 1`;
const states = await sql<{ processing_state: string; queued: boolean; n: number }[]>`
  SELECT processing_state, processing_queued_at IS NOT NULL AS queued, count(*)::int AS n
  FROM articles GROUP BY 1, 2 ORDER BY 1`;
const evidenceCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_evidence_versions`;
const judgmentCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_judgments`;
note("side-effects", {
  schemas: schemas.map((row) => row.nspname),
  pgbossJobs: jobs,
  notifyTargets: targets?.n,
  sources: sources?.n,
  constraints,
  processing: states,
  evidenceRows: evidenceCount[0]?.n,
  judgmentRows: judgmentCount[0]?.n,
  cumulativeIncludesRaw: cumulativeEvidenceHash({ rawVersions: [rawA], bodyText: "正文", quotedText: null, xPost: null })
    !== cumulativeEvidenceHash({ rawVersions: [rawA, rawB], bodyText: "正文", quotedText: null, xPost: null }),
});

const doc = parseImportDocument({ sourceId: "src_1", items: [{ url: "https://example.com/a", title: "标题", raw: parsed }] });
note("parser-names-canonical-hash-rawSha256", {
  rawSha256: doc.items[0]!.rawSha256,
  equalsCanonical: doc.items[0]!.rawSha256 === canonicalHash,
  equalsFileBytes: doc.items[0]!.rawSha256 === byteHash,
});

await closeDb();
console.log(JSON.stringify({ database: "own_probe_v6_test", findings }, null, 2));
