// Database loop for controlled import, evidence versions and own judgements.
// Unblinded public posts are gap checks only. They are not a new holdout.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stableJson } from "@aihot/backend/lib/ids";
import { HISTORICAL_RULESET, type JudgmentBody } from "../site/own-pipeline.ts";
import { sweepUnprocessed } from "../packages/backend/src/jobs/content.ts";
import { stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { contentHash } from "@aihot/backend/content/materials";
import { activeJudgment, JudgmentConflict, alignEvidenceToArticleRevision, appendControlledEvidence, appendLocatedSupplement, commitControlledLoop, listPendingDrafts, listPendingSelections, materialForScoring, recordDateOnly, recordFileResult, recordJudgment, recordReviewDraft, recordSelectionDecision } from "../packages/backend/src/own-pipeline-store.ts";

const SOURCE = `own-pipeline-${tag()}`;
const SAMPLES = process.env.OWN_PUBLIC_SAMPLES
  ?? "/tmp/review-evidence/AIHOT_独立审阅资料/evidence/public_revealed_examples";
const binding = { rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null };

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Own pipeline test', 'external', 'isolated', '2100-01-01')`;
});
after(async () => { await stopBoss(); await closeDb(); });

function gapBody(reasons: string[]): JudgmentBody {
  return {
    informationTypeId: null, contentLine: null, materialStatus: "missing_body", factStatus: "unchecked",
    valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "deterministic", reasons,
  };
}

function bodyOnly(reasons: string[]): JudgmentBody {
  return { ...gapBody(reasons), materialStatus: "missing_quote" };
}

function supplementedBody(reasons: string[]): JudgmentBody {
  return {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "deterministic", reasons,
  };
}

test("supplementing body and quote versions evidence without replacing the original raw", async () => {
  const url = `https://example.com/own-${tag()}`;
  const original = { kind: "synthetic-raw", text: "原件正文不该被提升", quote: { text: "原件里的引用" } };
  const first = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "合成材料", raw: original },
    gapBody(["缺正文，未评分"]), "2026-11-18T00:00:00.000Z", binding,
  );
  assert.equal(first.evidence.evidenceVersion, 1);
  assert.equal(first.evidence.articleRevision, 1);
  assert.equal(first.judgment.idempotent, false);
  assert.equal(first.judgment.body.releaseStatus, "not_licensed");

  const again = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "合成材料", raw: original },
    gapBody(["缺正文，未评分"]), "2026-11-18T00:00:01.000Z", binding,
  );
  assert.equal(again.evidence.idempotent, true);
  assert.equal(again.judgment.idempotent, true);
  assert.equal(again.judgment.id, first.judgment.id);

  const withBody = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "合成材料", raw: original, bodyText: "显式正文" },
    bodyOnly(["已补正文，仍未评分"]), "2026-11-18T00:01:00.000Z", binding,
  );
  assert.equal(withBody.evidence.evidenceVersion, 2);
  assert.equal(withBody.evidence.articleRevision, 2);
  assert.notEqual(withBody.evidence.evidenceHash, first.evidence.evidenceHash);
  assert.equal(withBody.judgment.idempotent, false);

  const withQuote = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "合成材料", raw: original, bodyText: "显式正文", quotedText: "显式引用" },
    supplementedBody(["已补引用，仍未评分"]), "2026-11-18T00:02:00.000Z", binding,
  );
  assert.equal(withQuote.evidence.articleRevision, 2);
  assert.equal(withQuote.evidence.evidenceVersion, 3);
  assert.notEqual(withQuote.evidence.evidenceHash, withBody.evidence.evidenceHash);

  const replacedRaw = { kind: "synthetic-raw", text: "后来的另一份原件" };
  const withNewRaw = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "合成材料", raw: replacedRaw, bodyText: "显式正文", quotedText: "显式引用" },
    supplementedBody(["新原件另存一版，仍未评分"]), "2026-11-18T00:03:00.000Z", binding,
  );
  assert.equal(withNewRaw.evidence.evidenceVersion, 4);

  const [article] = await sql<{ revision: number; raw: unknown; body_text: string | null; x_post: unknown; processing_queued_at: Date | null; processing_state: string }[]>`
    SELECT revision, raw, body_text, x_post, processing_queued_at, processing_state FROM articles WHERE id = ${first.evidence.articleId}`;
  assert.equal(article!.revision, 2);
  assert.equal(stableJson(article!.raw), stableJson(replacedRaw));
  assert.equal(article!.body_text, "显式正文");
  assert.equal(article!.x_post, null);
  assert.equal(article!.processing_queued_at, null);
  assert.equal(article!.processing_state, "skipped");
  const revisions = await sql<{ revision: number; body_text: string | null }[]>`
    SELECT revision, body_text FROM article_revisions WHERE article_id = ${first.evidence.articleId} ORDER BY revision`;
  assert.deepEqual(revisions.map((row) => row.revision), [1, 2]);

  const versions = await sql<{ version: number; raw: unknown; body_text: string | null; quoted_text: string | null }[]>`
    SELECT version, raw, body_text, quoted_text FROM own_evidence_versions
    WHERE article_id = ${first.evidence.articleId} ORDER BY version`;
  assert.equal(stableJson(versions[0]!.raw), stableJson(original));
  assert.equal(versions[0]!.body_text, null);
  assert.equal(stableJson(versions[1]!.raw), stableJson(original));
  assert.equal(versions[1]!.body_text, "显式正文");
  assert.equal(versions[2]!.quoted_text, "显式引用");
  assert.equal(stableJson(versions[2]!.raw), stableJson(original));
  assert.equal(stableJson(versions[3]!.raw), stableJson(replacedRaw));
  assert.equal(stableJson(versions[0]!.raw), stableJson(original));

  const judgements = await sql<{ stale: boolean; prompt_version: string; model_version: string; release_status: string }[]>`
    SELECT stale, prompt_version, model_version, release_status FROM own_judgments
    WHERE article_id = ${first.evidence.articleId} AND ruleset_version = ${HISTORICAL_RULESET}
      AND model_version = '' ORDER BY created_at`;
  assert.equal(judgements.length, 4);
  assert.deepEqual(judgements.map((row) => row.stale), [true, true, true, false]);
  assert.ok(judgements.every((row) => row.prompt_version === "" && row.release_status === "not_licensed"));

  const otherModel = await recordJudgment({
    ...withNewRaw.judgment.identity, modelVersion: "other-model",
  }, supplementedBody(["换模型，不碰原绑定"]), "2026-11-18T00:04:00.000Z");
  const otherRule = await recordJudgment({
    ...withNewRaw.judgment.identity, rulesetVersion: "other-ruleset",
  }, supplementedBody(["换规则，不碰原绑定"]), "2026-11-18T00:05:00.000Z");
  const [stillCurrent] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${withNewRaw.judgment.id}`;
  assert.equal(stillCurrent!.stale, false);
  assert.equal(otherModel.stale, false);
  assert.equal(otherRule.stale, false);

  await assert.rejects(
    () => recordJudgment(withNewRaw.judgment.identity, supplementedBody(["冲突的理由"]), "2026-11-18T00:06:00.000Z"),
    JudgmentConflict,
  );
  await assert.rejects(() => sql`
    INSERT INTO own_judgments (id, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
      material_status, fact_status, value_status, release_status, reasons, recorded_at)
    SELECT ${`race-${tag()}`}, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
      material_status, fact_status, value_status, release_status, reasons, recorded_at
    FROM own_judgments WHERE id = ${withNewRaw.judgment.id}`);

  const blank = await recordJudgment(
    { ...withNewRaw.judgment.identity, promptVersion: "  ", modelVersion: null },
    supplementedBody(["新原件另存一版，仍未评分"]), "2026-11-18T00:07:00.000Z",
  );
  assert.equal(blank.idempotent, true);
  assert.equal(blank.id, withNewRaw.judgment.id);

  const [published] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id = ${first.evidence.articleId}`;
  const [analysed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${first.evidence.articleId}`;
  assert.equal(published!.n, 0);
  assert.equal(analysed!.n, 0);
});

test("a failed judgement insert does not leave the previous row stale", async () => {
  const url = `https://example.com/own-rollback-${tag()}`;
  const saved = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "回滚", raw: { n: 1 } },
    gapBody(["待回滚"]), "2026-11-18T01:00:00.000Z", binding,
  );
  await assert.rejects(() => sql.begin(async (tx) => {
    await tx`UPDATE own_judgments SET stale = true WHERE id = ${saved.judgment.id}`;
    await tx`INSERT INTO own_judgments (id, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
      material_status, fact_status, value_status, release_status, reasons, recorded_at)
      VALUES (${`bad-${tag()}`}, ${saved.evidence.articleId}, 1, 'other-evidence', ${HISTORICAL_RULESET}, '', '',
        'missing_body', 'unchecked', 'incomplete_material', 'licensed', ${tx.json(["不行"] as never)}, now())`;
  }));
  const [row] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${saved.judgment.id}`;
  assert.equal(row!.stale, false);
});

test("concurrent repeats stay one row", async () => {
  const url = `https://example.com/own-race-${tag()}`;
  const saved = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "并发", raw: { n: 1 } },
    gapBody(["并发初写"]), "2026-11-18T02:00:00.000Z", binding,
  );
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    recordJudgment(saved.judgment.identity, gapBody(["并发初写"]), "2026-11-18T02:00:01.000Z")));
  assert.ok(results.every((row) => row.id === saved.judgment.id && row.idempotent));
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_judgments WHERE article_id = ${saved.evidence.articleId}`;
  assert.equal(count!.n, 1);
});

test("judgement hashes must be the current stored evidence, including under a concurrent supplement", async () => {
  const url = `https://example.com/own-bind-${tag()}`;
  const saved = await commitControlledLoop(
    { sourceId: SOURCE, url, title: "绑定", raw: { n: 1 } },
    gapBody(["初版"]), "2026-11-18T04:00:00.000Z", binding,
  );
  await assert.rejects(
    () => recordJudgment({ ...saved.judgment.identity, evidenceHash: "f".repeat(64) }, gapBody(["伪造"]), "2026-11-18T04:00:01.000Z"),
    /当前持久证据/,
  );
  await assert.rejects(
    () => recordJudgment(saved.judgment.identity, { ...gapBody(["模型空版本"]), origin: "model" }, "2026-11-18T04:00:02.000Z"),
    /可追溯/,
  );
  await assert.rejects(
    () => recordJudgment({
      ...saved.judgment.identity, promptVersion: "prefilter@abc", modelVersion: "stub-model",
    }, { ...gapBody(["只有版本字符串"]), origin: "model" }, "2026-11-18T04:00:03.000Z"),
    /回执/,
  );
  const tracedBody = { ...gapBody(["带来源"]), origin: "model" as const };
  const [receipt] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, response)
    VALUES (${`own-${tag()}`}, 'llm', 'stub-model', 'own-judgment', ${`article:${saved.evidence.articleId}`}, 'completed',
      ${sql.json({ articleId: saved.evidence.articleId, evidenceHash: saved.evidence.evidenceHash, promptVersion: "prefilter@abc" } as never)},
      ${sql.json({
        schema: "own-model-output-v1", articleId: saved.evidence.articleId, evidenceHash: saved.evidence.evidenceHash, promptVersion: "prefilter@abc",
        output: { materialStatus: tracedBody.materialStatus, factStatus: tracedBody.factStatus, valueStatus: tracedBody.valueStatus, releaseStatus: tracedBody.releaseStatus, reasons: tracedBody.reasons },
      } as never)})
    RETURNING id`;
  const traced = await recordJudgment({
    ...saved.judgment.identity, promptVersion: "prefilter@abc", modelVersion: "stub-model",
  }, { ...tracedBody, modelReceiptId: receipt!.id }, "2026-11-18T04:00:03.000Z");
  assert.equal(traced.idempotent, false);
  const raced = await Promise.allSettled([
    appendControlledEvidence({ sourceId: SOURCE, url, title: "绑定", raw: { n: 1 }, bodyText: "补上的正文" }),
    recordJudgment(saved.judgment.identity, gapBody(["初版"]), "2026-11-18T04:00:04.000Z"),
  ]);
  assert.equal(raced.length, 2);
  const [latest] = await sql<{ evidence_hash: string }[]>`
    SELECT evidence_hash FROM own_evidence_versions WHERE article_id = ${saved.evidence.articleId} ORDER BY version DESC LIMIT 1`;
  const active = await sql<{ evidence_hash: string }[]>`
    SELECT evidence_hash FROM own_judgments WHERE article_id = ${saved.evidence.articleId} AND stale = false`;
  assert.ok(active.every((row) => row.evidence_hash === latest!.evidence_hash));
  assert.equal(active.some((row) => row.evidence_hash === saved.evidence.evidenceHash), false);
  const [versions] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_evidence_versions WHERE article_id = ${saved.evidence.articleId}`;
  assert.equal(versions!.n, 2);
});

test("the import command is the supported entry and does not score incomplete material", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "own-import-"));
  const raw = { kind: "cli", text: "只在原件里" };
  const file = path.join(dir, "items.json");
  writeFileSync(file, JSON.stringify({
    sourceId: SOURCE,
    items: [{ url: `https://example.com/cli-${tag()}`, title: "命令导入", raw, rawCanonicalSha256: createHash("sha256").update(stableJson(raw)).digest("hex") }],
  }));
  const quiet: NodeJS.ProcessEnv = {
    ...process.env, DATABASE_URL: process.env.DATABASE_URL, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", DINGTALK_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false", BAIDU_PUSH_ENABLED: "false",
  };
  const run = (args: string[], env: NodeJS.ProcessEnv = quiet) => spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-import.ts"), ...args], {
    cwd: process.cwd(), encoding: "utf8", env,
  });
  const dry = run(["--file", file, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  const dryJson = JSON.parse(dry.stdout);
  assert.equal(dryJson.dryRun, true);
  assert.equal(dryJson.counts.evidenceAppended, 0);
  assert.equal(dryJson.items[0].valueJudgment, false);
  assert.equal(dryJson.items[0].completeness, "missing_body");
  const first = run(["--file", file]);
  assert.equal(first.status, 0, first.stderr);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.counts.evidenceAppended, 1);
  assert.equal(firstJson.counts.judgmentSkippedIncomplete, 1);
  assert.equal(firstJson.items[0].publicationRows, 0);
  assert.equal(firstJson.items[0].deliveryRows, 0);
  assert.equal(firstJson.workerStarted, false);
  const second = run(["--file", file]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).counts.idempotent, 1);
  const [judged] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_judgments WHERE article_id = ${firstJson.items[0].articleId}`;
  assert.equal(judged!.n, 0);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ sourceId: SOURCE, items: [{ url: "https://example.com/bad", title: "坏", raw, score: 1 }] }));
  const rejected = run(["--file", bad]);
  assert.notEqual(rejected.status, 0);
  const blocked = run(["--file", file], { ...process.env, COLLECT_ENABLED: "true", DATABASE_URL: process.env.DATABASE_URL });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /开关打开/);
  const safety = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-safety-check.ts")], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" },
  });
  assert.equal(safety.status, 0, safety.stderr);
  assert.equal(JSON.parse(safety.stdout).workerStarted, false);
  const importer = readFileSync(path.join(process.cwd(), "scripts/own-import.ts"), "utf8");
  assert.equal(/queueProcessing\s*\(/.test(importer), false);
  assert.equal(importer.includes("apps/worker"), false);
  assert.equal(importer.includes("DELETE FROM own_evidence"), false);
});

test("title and publishedAt stay in one evidence transaction, and a repeated raw is a new current state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "own-revise-"));
  const quiet: NodeJS.ProcessEnv = {
    ...process.env, DATABASE_URL: process.env.DATABASE_URL, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", DINGTALK_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false", BAIDU_PUSH_ENABLED: "false",
  };
  const run = (body: unknown) => {
    const file = path.join(dir, `${tag()}.json`);
    writeFileSync(file, JSON.stringify(body));
    return spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-import.ts"), "--file", file], {
      cwd: process.cwd(), encoding: "utf8", env: quiet,
    });
  };
  const url = `https://example.com/title-${tag()}`;
  const raw = { kind: "title" };
  const base = { url, title: "标题甲", raw, bodyText: "同一正文" };
  const first = run({ sourceId: SOURCE, items: [base] });
  assert.equal(first.status, 0, first.stderr);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.counts.judgmentRecorded, 0);
  assert.equal(firstJson.items[0].completeness, "missing_quote");
  assert.equal(firstJson.items[0].quality, "unverified");
  const second = run({ sourceId: SOURCE, items: [{ ...base, title: "标题乙" }] });
  assert.equal(second.status, 0, second.stderr);
  const secondJson = JSON.parse(second.stdout);
  assert.equal(secondJson.counts.evidenceAppended, 1);
  assert.equal(secondJson.counts.idempotent, 0);
  assert.equal(secondJson.counts.rejected, 0);
  const [article] = await sql<{ revision: number; title: string; processing_state: string }[]>`
    SELECT revision, title, processing_state FROM articles WHERE url = ${url}`;
  const evidence = await sql<{ version: number; article_revision: number }[]>`
    SELECT version, article_revision FROM own_evidence_versions WHERE article_id = ${firstJson.items[0].articleId} ORDER BY version`;
  assert.equal(article!.revision, 2);
  assert.equal(article!.title, "标题乙");
  assert.equal(article!.processing_state, "skipped");
  assert.deepEqual(evidence.map((row) => row.article_revision), [1, 2]);
  const [judged] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM own_judgments WHERE article_id = ${firstJson.items[0].articleId}`;
  assert.equal(judged!.n, 0);

  const dated = `https://example.com/date-${tag()}`;
  const dateRaw = { kind: "date" };
  const dateFirst = run({ sourceId: SOURCE, items: [{ url: dated, title: "补时间", raw: dateRaw, bodyText: "补时间正文" }] });
  assert.equal(dateFirst.status, 0, dateFirst.stderr);
  const dateSecond = run({ sourceId: SOURCE, items: [{ url: dated, title: "补时间", raw: dateRaw, bodyText: "补时间正文", publishedAt: "2024-01-15T00:00:00.000Z" }] });
  assert.equal(dateSecond.status, 0, dateSecond.stderr);
  const dateJson = JSON.parse(dateSecond.stdout);
  assert.equal(dateJson.counts.rejected, 0);
  assert.equal(dateJson.items[0].articleRevision, dateJson.items[0].evidenceVersion === 2 ? 2 : dateJson.items[0].articleRevision);
  const [dateArticle] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE url = ${dated}`;
  const dateEvidence = await sql<{ article_revision: number }[]>`
    SELECT article_revision FROM own_evidence_versions WHERE article_id = ${JSON.parse(dateFirst.stdout).items[0].articleId} ORDER BY version`;
  assert.equal(dateArticle!.revision, dateEvidence.at(-1)!.article_revision);

  const loopUrl = `https://example.com/loop-${tag()}`;
  const loopItem = { sourceId: SOURCE, url: loopUrl, title: "循环甲", raw: { kind: "loop" }, bodyText: "循环正文" };
  const loopFirst = await commitControlledLoop(loopItem, bodyOnly(["未评分"]), "2026-11-18T09:00:00.000Z", binding);
  const loopNext = await commitControlledLoop({ ...loopItem, title: "循环乙" }, bodyOnly(["未评分"]), "2026-11-18T09:01:00.000Z", binding);
  assert.equal(loopNext.evidence.articleRevision, 2);
  assert.equal(loopNext.judgment.identity.inputRevision, 2);
  assert.equal(loopNext.judgment.stale, false);
  const [loopOld] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${loopFirst.judgment.id}`;
  assert.equal(loopOld!.stale, true);
  const active = await activeJudgment(loopFirst.evidence.articleId, binding);
  assert.equal(active?.id, loopNext.judgment.id);
  const other = await recordJudgment(
    { ...loopNext.judgment.identity, rulesetVersion: "other-ruleset" },
    bodyOnly(["另一规则"]), "2026-11-18T09:02:00.000Z",
  );
  assert.equal((await activeJudgment(loopFirst.evidence.articleId, binding))?.id, loopNext.judgment.id);
  assert.equal((await activeJudgment(loopFirst.evidence.articleId, { ...binding, rulesetVersion: "other-ruleset" }))?.id, other.id);

  const rawUrl = `https://example.com/raw-${tag()}`;
  const rawA = { kind: "A" };
  const rawB = { kind: "B" };
  const a = await appendControlledEvidence({ sourceId: SOURCE, url: rawUrl, title: "回退", raw: rawA, bodyText: "正文一", quotedText: "引用一" });
  await appendControlledEvidence({ sourceId: SOURCE, url: rawUrl, title: "回退", raw: rawA, bodyText: "正文二", quotedText: "引用一" });
  await appendControlledEvidence({ sourceId: SOURCE, url: rawUrl, title: "回退", raw: rawA, bodyText: "正文二", quotedText: "引用二" });
  const atB = await appendControlledEvidence({ sourceId: SOURCE, url: rawUrl, title: "回退", raw: rawB, bodyText: "正文二", quotedText: "引用二" });
  const judgedB = await recordJudgment({
    articleId: atB.articleId, inputRevision: atB.articleRevision, evidenceHash: atB.evidenceHash, ...binding,
  }, supplementedBody(["停在 B"]), "2026-11-18T10:00:00.000Z");
  const back = await appendControlledEvidence({ sourceId: SOURCE, url: rawUrl, title: "回退", raw: rawA, bodyText: "正文二", quotedText: "引用二" });
  assert.equal(back.idempotent, false);
  assert.notEqual(back.evidenceHash, atB.evidenceHash);
  const cleared = await appendControlledEvidence({ sourceId: SOURCE, url: rawUrl, title: "回退", raw: rawA, bodyText: "正文三", quotedText: null });
  assert.equal(cleared.idempotent, false);
  const versions = await sql<{ version: number; raw: unknown; quoted_text: string | null }[]>`
    SELECT version, raw, quoted_text FROM own_evidence_versions WHERE article_id = ${a.articleId} ORDER BY version`;
  assert.equal(stableJson(versions[0]!.raw), stableJson(rawA));
  assert.equal(stableJson(versions.at(-2)!.raw), stableJson(rawA));
  assert.equal(versions.at(-1)!.quoted_text, null);
  const [currentRaw] = await sql<{ raw: unknown }[]>`SELECT raw FROM articles WHERE id = ${a.articleId}`;
  assert.equal(stableJson(currentRaw!.raw), stableJson(rawA));
  const [bJudgment] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${judgedB.id}`;
  assert.equal(bJudgment!.stale, true);

  const xUrl = `https://example.com/x-${tag()}`;
  const xPost = { tweetId: "2117095432526700999", authorName: "A", handle: "someone", text: "帖子" };
  const withPost = await appendControlledEvidence({ sourceId: SOURCE, url: xUrl, title: "帖", raw: { kind: "x" }, bodyText: "帖子", xPost });
  const withoutPost = await appendControlledEvidence({ sourceId: SOURCE, url: xUrl, title: "帖", raw: { kind: "x" }, bodyText: "帖子", xPost: null });
  assert.equal(withoutPost.articleId, withPost.articleId);
  const [rows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE url = ${xUrl}`;
  assert.equal(rows!.n, 1);
  const xVersions = await sql<{ x_post: unknown }[]>`
    SELECT x_post FROM own_evidence_versions WHERE article_id = ${withPost.articleId} ORDER BY version`;
  assert.equal(xVersions.at(-1)!.x_post, null);
  await assert.rejects(
    () => appendControlledEvidence({ sourceId: SOURCE, url: xUrl, title: "帖", raw: { kind: "x" }, xPost: { ...xPost, tweetId: "2117095432526700888" } }),
    /已绑定帖子身份/,
  );

  const bytes = Buffer.from('{"b":1,"aa":2}', "utf8");
  const byteUrl = `https://example.com/bytes-${tag()}`;
  const stored = await appendControlledEvidence({
    sourceId: SOURCE, url: byteUrl, title: "字节", raw: { aa: 2, b: 1 },
    rawFileBase64: bytes.toString("base64"), rawFileSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const [fileRow] = await sql<{ raw_file: Buffer; raw_text: string }[]>`
    SELECT raw_file, raw::text AS raw_text FROM own_evidence_versions WHERE article_id = ${stored.articleId} AND version = 1`;
  assert.equal(createHash("sha256").update(fileRow!.raw_file).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(fileRow!.raw_text, bytes.toString("utf8"));

  await sql`UPDATE articles SET created_at = now() - interval '10 minutes' WHERE source_id = ${SOURCE}`;
  const swept = await sweepUnprocessed();
  const [still] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles WHERE source_id = ${SOURCE} AND processing_state = 'new'`;
  assert.equal(still!.n, 0);
  assert.equal(swept.enqueued, 0);
});

test("a receipt must name this evidence, and checked facts need a human excerpt", async () => {
  const url = `https://example.com/bound-${tag()}`;
  const saved = await appendControlledEvidence({
    sourceId: SOURCE, url, title: "绑定回执", raw: { n: 1 }, bodyText: "显式正文里有这段可核的原句",
  });
  await assert.rejects(() => recordJudgment({
    articleId: saved.articleId, inputRevision: saved.articleRevision, evidenceHash: saved.evidenceHash, ...binding,
  }, {
    ...gapBody(["写成完整"]), materialStatus: "complete", factStatus: "checked",
  }, "2026-11-18T05:00:01.000Z"), /持久证据是missing_quote/);
  const withQuote = await appendControlledEvidence({
    sourceId: SOURCE, url, title: "绑定回执", raw: { n: 1 }, bodyText: "显式正文里有这段可核的原句", quotedText: "引用原句也在这里",
  });
  const algorithm = "sha256-evidence";
  const inputHash = createHash("sha256").update(stableJson({ algorithm, evidenceHash: withQuote.evidenceHash })).digest("hex");
  await assert.rejects(() => recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash, ...binding,
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "checked",
    valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "deterministic", reasons: ["假核对"],
    comparison: { algorithm: "none", inputHash: "ab".repeat(32) },
  }, "2026-11-18T05:00:02.000Z"), /可重算|事实已核/);
  const unchecked = await recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash, ...binding,
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "deterministic", reasons: ["未核可以留下"],
    comparison: { algorithm, inputHash },
  }, "2026-11-18T05:00:03.000Z");
  assert.equal(unchecked.body.factStatus, "unchecked");
  assert.equal(unchecked.body.releaseStatus, "not_licensed");
  const checked = await recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: "human-check", promptVersion: null, modelVersion: null,
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "checked",
    valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "deterministic", reasons: ["人核了摘录"],
    factCheck: { claim: "原句在正文里", sourceExcerpt: "这段可核的原句", by: "human" },
  }, "2026-11-18T05:00:04.000Z");
  assert.equal(checked.body.factStatus, "checked");
  const [forged] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, response)
    VALUES (${`forged-${tag()}`}, 'llm', 'stub-no-call', 'probe', 'unrelated-subject', 'completed',
      ${sql.json({ input: "not this article" } as never)}, ${sql.json({ output: "not a judgment" } as never)}) RETURNING id`;
  await assert.rejects(() => recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: HISTORICAL_RULESET, promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "model", reasons: ["无关回执"],
    modelReceiptId: forged!.id,
  }, "2026-11-18T05:00:05.000Z"), /没有绑到这篇文章的当前证据/);
  await assert.rejects(() => recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: "missing-receipt", promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "model", reasons: ["没有回执"],
    modelReceiptId: 999999,
  }, "2026-11-18T05:00:06.000Z"), /模型回执不存在/);
  const [pending] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, status)
    VALUES (${`pending-${tag()}`}, 'llm', 'stub-no-call', 'probe', 'pending') RETURNING id`;
  await assert.rejects(() => recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: "pending-receipt", promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
  }, {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "model", reasons: ["未完成"],
    modelReceiptId: pending!.id,
  }, "2026-11-18T05:00:07.000Z"), /尚未完成/);
  const accepted = {
    informationTypeId: null, contentLine: null, materialStatus: "complete" as const, factStatus: "unchecked" as const,
    valueStatus: "incomplete_material" as const, releaseStatus: "not_licensed" as const, origin: "model" as const, reasons: ["未核但回执对得上"],
  };
  const acceptedResponse = {
    schema: "own-model-output-v1", articleId: withQuote.articleId, evidenceHash: withQuote.evidenceHash, promptVersion: "prefilter@probe",
    output: { materialStatus: accepted.materialStatus, factStatus: accepted.factStatus, valueStatus: accepted.valueStatus, releaseStatus: accepted.releaseStatus, reasons: accepted.reasons },
  };
  const [bound] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, response)
    VALUES (${`bound-${tag()}`}, 'llm', 'stub-no-call', 'own-judgment', ${`article:${withQuote.articleId}`}, 'completed',
      ${sql.json({ articleId: withQuote.articleId, evidenceHash: withQuote.evidenceHash, promptVersion: "prefilter@probe" } as never)},
      ${sql.json(acceptedResponse as never)})
    RETURNING id`;
  const modelUnchecked = await recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: HISTORICAL_RULESET, promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
  }, { ...accepted, modelReceiptId: bound!.id }, "2026-11-18T05:00:08.000Z");
  assert.equal(modelUnchecked.body.factStatus, "unchecked");
  assert.equal(modelUnchecked.body.releaseStatus, "not_licensed");
  assert.equal(modelUnchecked.body.origin, "model");
  const [unrelated] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, response)
    VALUES (${`unrelated-response-${tag()}`}, 'llm', 'stub-no-call', 'own-judgment', ${`article:${withQuote.articleId}`}, 'completed',
      ${sql.json({ articleId: withQuote.articleId, evidenceHash: withQuote.evidenceHash, promptVersion: "prefilter@probe" } as never)},
      ${sql.json({ output: "not a judgment" } as never)})
    RETURNING id`;
  await assert.rejects(() => recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: "unrelated-response", promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
  }, { ...accepted, reasons: ["另一份"], modelReceiptId: unrelated!.id }, "2026-11-18T05:00:09.000Z"), /格式无法解析/);
  const tampered = { ...acceptedResponse, output: { ...acceptedResponse.output, reasons: ["被改过的输出"] } };
  const [tamperedRow] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, response)
    VALUES (${`tampered-${tag()}`}, 'llm', 'stub-no-call', 'own-judgment', ${`article:${withQuote.articleId}`}, 'completed',
      ${sql.json({ articleId: withQuote.articleId, evidenceHash: withQuote.evidenceHash, promptVersion: "prefilter@probe" } as never)},
      ${sql.json(tampered as never)})
    RETURNING id`;
  await assert.rejects(() => recordJudgment({
    articleId: withQuote.articleId, inputRevision: withQuote.articleRevision, evidenceHash: withQuote.evidenceHash,
    rulesetVersion: "tampered-output", promptVersion: "prefilter@probe", modelVersion: "stub-no-call",
  }, { ...accepted, modelReceiptId: tamperedRow!.id }, "2026-11-18T05:00:10.000Z"), /不能背书另一份输出/);
  await assert.rejects(() => appendControlledEvidence({
    sourceId: SOURCE, url: `https://example.com/hash-only-${tag()}`, title: "只声明", raw: { not: "the file" }, rawFileSha256: "a".repeat(64),
  }), /没有原件字节/);
  const cleared = await appendControlledEvidence({
    sourceId: SOURCE, url, title: "绑定回执", raw: { n: 1 }, bodyText: null, quotedText: null,
  });
  const scored = await materialForScoring(cleared.articleId);
  assert.equal(scored?.bodyText, null);
  assert.equal(scored?.quotedText, null);
  await sql`UPDATE articles SET body_text = '旧正文不该被抽走' WHERE id = ${cleared.articleId}`;
  const still = await materialForScoring(cleared.articleId);
  assert.equal(still?.bodyText, null);
  const [identity] = await sql<{ identity_key: string; body_text: string | null }[]>`
    SELECT identity_key, body_text FROM articles WHERE id = ${cleared.articleId}`;
  assert.equal(identity!.body_text, "旧正文不该被抽走");
  assert.ok(identity!.identity_key);
});

test("the file command stores a result, repeats, rejects a changed output, and stales it when evidence moves", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "own-file-result-"));
  const url = `https://example.com/file-result-${tag()}`;
  const body = "窄主张的原句在正文里。后面还有条件。";
  const excerpt = "窄主张的原句在正文里";
  const saved = await appendControlledEvidence({
    sourceId: SOURCE, url, title: "文件结果", raw: { n: 1 }, bodyText: body,
  });
  const output = {
    narrowClaim: "正文把范围限在这一句",
    quoteLocation: { excerpt, start: body.indexOf(excerpt), end: body.indexOf(excerpt) + excerpt.length },
    conditions: ["只在这段正文里"],
    time: "2026-11-18",
    valueBasis: "正文写明了限制",
    audience: ["读这一段的人"],
    substantiveAddition: "比标题多了范围",
    clauses: [{ id: "scope", text: "只覆盖这一句" }],
  };
  const document = (evidence: typeof saved, claim = output.narrowClaim) => ({
    schema: "own-file-result-v1",
    items: [{
      articleId: evidence.articleId, evidenceHash: evidence.evidenceHash, evidenceVersion: evidence.evidenceVersion,
      inputRevision: evidence.articleRevision, rulesetVersion: "rules@file", promptVersion: "prompt@file",
      executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
      output: { ...output, narrowClaim: claim },
    }],
  });
  const run = (doc: unknown) => {
    const file = path.join(dir, `result-${tag()}.json`);
    writeFileSync(file, JSON.stringify(doc));
    return spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-file-result.ts"), "--file", file], {
      cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" },
    });
  };
  const first = run(document(saved));
  assert.equal(first.status, 0, first.stderr);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.vendorReceipt, false);
  assert.equal(firstJson.items[0].idempotent, false);
  assert.equal(firstJson.items[0].factStatus, "unchecked");
  assert.equal(firstJson.items[0].releaseStatus, "not_licensed");
  assert.equal(firstJson.items[0].fileReceipt.vendorReceipt, false);
  const [row] = await sql<{ origin: string; fact_status: string; release_status: string; model_version: string; model_receipt_id: number | null; file_result: { modelKnowledge: string; knownModel: string | null; output: { narrowClaim: string; time: string; valueBasis: string } }; vendor: boolean }[]>`
    SELECT origin, fact_status, release_status, model_version, model_receipt_id,
      comparison->'fileResult' AS file_result,
      (comparison->'fileResult'->>'vendorReceipt')::boolean AS vendor
    FROM own_judgments WHERE article_id = ${saved.articleId} AND stale = false`;
  assert.equal(row!.origin, "file");
  assert.equal(row!.fact_status, "unchecked");
  assert.equal(row!.release_status, "not_licensed");
  assert.equal(row!.model_version, "file:assistant-file");
  assert.equal(row!.model_receipt_id, null);
  assert.equal(row!.vendor, false);
  assert.equal(row!.file_result.modelKnowledge, "unknown");
  assert.equal(row!.file_result.knownModel, null);
  assert.equal(row!.file_result.output.time, "2026-11-18");
  assert.equal(row!.file_result.output.valueBasis, "正文写明了限制");
  const [receipts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE subject = ${`article:${saved.articleId}`}`;
  assert.equal(receipts!.n, 0);
  const again = run(document(saved));
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).items[0].idempotent, true);
  const changed = run(document(saved, "另一条窄主张"));
  assert.notEqual(changed.status, 0);
  assert.match(changed.stdout, /同一判断身份出现不同结果/);
  const [kept] = await sql<{ claim: string; n: number }[]>`
    SELECT comparison->'fileResult'->'output'->>'narrowClaim' AS claim, count(*)::int AS n
    FROM own_judgments WHERE article_id = ${saved.articleId} GROUP BY claim`;
  assert.equal(kept!.claim, "正文把范围限在这一句");
  assert.equal(kept!.n, 1);
  const next = await appendControlledEvidence({
    sourceId: SOURCE, url, title: "文件结果", raw: { n: 1 }, bodyText: `${body}补充了一句。`,
  });
  assert.notEqual(next.evidenceHash, saved.evidenceHash);
  const [stale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${firstJson.items[0].judgmentId}`;
  assert.equal(stale!.stale, true);
  const expired = run(document(saved));
  assert.notEqual(expired.status, 0);
  assert.match(expired.stdout, /判断必须绑定当前文章修订/);
  const humanUrl = `https://example.com/file-human-${tag()}`;
  const human = await appendControlledEvidence({
    sourceId: SOURCE, url: humanUrl, title: "人工文件", raw: { n: 2 }, bodyText: body,
  });
  const humanRun = run({
    schema: "own-file-result-v1",
    items: [{
      ...document(human).items[0], executionSource: "human-file",
    }],
  });
  assert.equal(humanRun.status, 0, humanRun.stderr);
  const [humanRow] = await sql<{ origin: string; fact_status: string; model_version: string; model_receipt_id: number | null }[]>`
    SELECT origin, fact_status, model_version, model_receipt_id FROM own_judgments WHERE article_id = ${human.articleId}`;
  assert.equal(humanRow!.origin, "file");
  assert.equal(humanRow!.fact_status, "unchecked");
  assert.equal(humanRow!.model_version, "file:human-file");
  assert.equal(humanRow!.model_receipt_id, null);
});

test("a body that returns to an older text keeps one mirror, and a footnote does not move the article revision", async () => {
  const raw = { n: 1 };
  const url = `https://example.com/mirror-${tag()}`;
  const otherUrl = `https://example.com/mirror-other-${tag()}`;
  const first = await appendControlledEvidence({ sourceId: SOURCE, url, title: "往返", raw, bodyText: "正文甲" });
  const judgment = await recordJudgment({
    articleId: first.articleId, inputRevision: first.articleRevision, evidenceHash: first.evidenceHash,
    rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null,
  }, bodyOnly(["甲"]), "2026-11-18T06:00:00.000Z");
  const other = await appendControlledEvidence({ sourceId: SOURCE, url: otherUrl, title: "旁观", raw, bodyText: "另一篇" });
  const otherJudgment = await recordJudgment({
    articleId: other.articleId, inputRevision: other.articleRevision, evidenceHash: other.evidenceHash,
    rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null,
  }, bodyOnly(["旁观"]), "2026-11-18T06:00:01.000Z");
  const changed = await appendControlledEvidence({ sourceId: SOURCE, url, title: "往返", raw, bodyText: "正文乙" });
  assert.equal(changed.articleRevision, 2);
  assert.notEqual(changed.evidenceHash, first.evidenceHash);
  const back = await appendControlledEvidence({ sourceId: SOURCE, url, title: "往返", raw, bodyText: "正文甲" });
  assert.equal(back.idempotent, false);
  assert.equal(back.articleRevision, 3);
  const again = await appendControlledEvidence({ sourceId: SOURCE, url, title: "往返", raw, bodyText: "正文甲" });
  assert.equal(again.idempotent, true);
  assert.equal(again.articleRevision, 3);
  assert.equal(again.evidenceVersion, back.evidenceVersion);
  const [article] = await sql<{ revision: number; body_text: string; content_hash: string }[]>`
    SELECT revision, body_text, content_hash FROM articles WHERE id = ${first.articleId}`;
  const revisions = await sql<{ revision: number; body_text: string; content_hash: string }[]>`
    SELECT revision, body_text, content_hash FROM article_revisions WHERE article_id = ${first.articleId} ORDER BY revision`;
  const [evidence] = await sql<{ version: number; article_revision: number; body_text: string; evidence_hash: string }[]>`
    SELECT version, article_revision, body_text, evidence_hash FROM own_evidence_versions
    WHERE article_id = ${first.articleId} ORDER BY version DESC LIMIT 1`;
  const hash = contentHash({ title: "往返", bodyText: "正文甲", excerpt: null });
  assert.deepEqual(revisions.map((row) => row.body_text), ["正文甲", "正文乙", "正文甲"]);
  assert.equal(article!.revision, 3);
  assert.equal(article!.body_text, "正文甲");
  assert.equal(article!.content_hash, hash);
  assert.equal(revisions[2]!.content_hash, hash);
  assert.equal(evidence!.body_text, "正文甲");
  assert.equal(Number(evidence!.article_revision), 3);
  assert.equal(evidence!.evidence_hash, back.evidenceHash);
  const [stale] = await sql<{ stale: boolean; input_revision: number; evidence_hash: string }[]>`
    SELECT stale, input_revision, evidence_hash FROM own_judgments WHERE id = ${judgment.id}`;
  assert.equal(stale!.stale, true);
  assert.equal(Number(stale!.input_revision), 1);
  assert.equal(stale!.evidence_hash, first.evidenceHash);
  const [kept] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${otherJudgment.id}`;
  assert.equal(kept!.stale, false);
  const [beforeSupplement] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${other.articleId}`;
  const supplement = await appendLocatedSupplement(other.articleId, {
    kind: "same-page-footnotes", sourceUrl: otherUrl, httpStatus: 200, responseSha256: "ab".repeat(32),
    parts: [{ id: "n1", role: "footnote", byteStart: 0, byteEnd: 4, text: "脚注" }],
  });
  const [afterSupplement] = await sql<{ revision: number; body_text: string }[]>`
    SELECT revision, body_text FROM articles WHERE id = ${other.articleId}`;
  assert.equal(afterSupplement!.revision, beforeSupplement!.revision);
  assert.equal(afterSupplement!.body_text, "另一篇");
  assert.equal(supplement.version, other.evidenceVersion + 1);
  assert.notEqual(supplement.evidenceHash, other.evidenceHash);
  const [footnoteStale] = await sql<{ stale: boolean; input_revision: number }[]>`
    SELECT stale, input_revision FROM own_judgments WHERE id = ${otherJudgment.id}`;
  assert.equal(footnoteStale!.stale, true);
  assert.equal(Number(footnoteStale!.input_revision), other.articleRevision);
  const [untouched] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM own_judgments WHERE article_id = ${first.articleId}`;
  assert.equal(untouched!.n, 1);
});

test("a selection file keeps its rationale, stays pending, and does not rewrite the semantic result", async () => {
  const url = `https://example.com/selection-${tag()}`;
  const body = "教程步骤写在正文里。产品更新是另一句。";
  const saved = await appendControlledEvidence({ sourceId: SOURCE, url, title: "选择夹具", raw: { n: 1 }, bodyText: body });
  const excerpt = "教程步骤写在正文里";
  const semantic = await recordFileResult({
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision, rulesetVersion: "rules@select", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "正文分开写了教程和产品", quoteLocation: { excerpt, start: body.indexOf(excerpt), end: body.indexOf(excerpt) + excerpt.length },
      conditions: ["只在这段正文里"], time: "2026-11-18", valueBasis: "正文写了两句", audience: ["读这一段的人"],
      substantiveAddition: "比标题多了两句", clauses: [{ id: "scope", text: "只覆盖这两句" }],
    },
  }, "2026-11-18T07:00:00.000Z");
  const item = {
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision, rulesetVersion: "rules@select",
    promptVersion: "assistant-selection-decision-draft-v2-nine-convenience-v1",
    used_claim: "正文分开写了教程和产品", excerpt, excerpt_source: "current_body",
    decision: "candidate", decision_rationale: "教程不自动高于产品更新，这条理由留在原件里，不升成通过。",
    audience_benefit: "读者能区分教程和产品更新", fact_checked: false,
  };
  const first = await recordSelectionDecision(item, "2026-11-18T07:00:01.000Z");
  assert.equal(first.idempotent, false);
  assert.equal(first.body.factStatus, "unchecked");
  assert.equal(first.body.releaseStatus, "not_licensed");
  assert.equal(first.body.valueStatus, "incomplete_material");
  assert.equal(first.body.selectionDecision?.status, "pending_review");
  assert.equal(first.body.selectionDecision?.boundSemanticJudgmentId, semantic.id);
  assert.equal(first.body.selectionDecision?.item.decision_rationale, item.decision_rationale);
  const again = await recordSelectionDecision(item, "2026-11-18T07:00:02.000Z");
  assert.equal(again.idempotent, true);
  assert.equal(again.id, first.id);
  await assert.rejects(() => recordSelectionDecision({ ...item, decision_rationale: "另一条理由" }, "2026-11-18T07:00:03.000Z"), JudgmentConflict);
  const [semanticRow] = await sql<{ output_sha: string; fact_status: string; release_status: string }[]>`
    SELECT comparison->'fileResult'->>'outputSha256' AS output_sha, fact_status, release_status
    FROM own_judgments WHERE id = ${semantic.id}`;
  assert.equal(semanticRow!.output_sha, semantic.fileReceipt.outputSha256);
  assert.equal(semanticRow!.fact_status, "unchecked");
  assert.equal(semanticRow!.release_status, "not_licensed");
  const queue = await listPendingSelections();
  const queued = queue.find((row) => row.id === first.id);
  assert.equal(queued?.item.audience_benefit, item.audience_benefit);
  assert.equal(queued?.evidenceHash, saved.evidenceHash);
  assert.equal(queued?.inputRevision, saved.articleRevision);
  assert.equal(queued?.boundSemanticJudgmentId, semantic.id);
  const [parked] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${saved.articleId}`;
  assert.equal(parked!.processing_state, "skipped");
  const [published] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id = ${saved.articleId}`;
  const [analysed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${saved.articleId}`;
  assert.equal(published!.n, 0);
  assert.equal(analysed!.n, 0);
  const moved = await appendControlledEvidence({ sourceId: SOURCE, url, title: "选择夹具", raw: { n: 1 }, bodyText: `${body}补充。` });
  assert.notEqual(moved.evidenceHash, saved.evidenceHash);
  const [selectionStale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${first.id}`;
  assert.equal(selectionStale!.stale, true);
  const [semanticStill] = await sql<{ stale: boolean; output_sha: string }[]>`
    SELECT stale, comparison->'fileResult'->>'outputSha256' AS output_sha FROM own_judgments WHERE id = ${semantic.id}`;
  assert.equal(semanticStill!.stale, true);
  assert.equal(semanticStill!.output_sha, semantic.fileReceipt.outputSha256);
  assert.equal((await listPendingSelections()).some((row) => row.id === first.id), false);
  const other = await appendControlledEvidence({ sourceId: SOURCE, url: `https://example.com/selection-other-${tag()}`, title: "旁观", raw: { n: 2 }, bodyText: body });
  const otherSemantic = await recordFileResult({
    articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion,
    inputRevision: other.articleRevision, rulesetVersion: "rules@select", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "旁观正文", quoteLocation: { excerpt, start: body.indexOf(excerpt), end: body.indexOf(excerpt) + excerpt.length },
      conditions: ["旁观"], time: "2026-11-18", valueBasis: "旁观", audience: ["旁观"], substantiveAddition: "旁观",
      clauses: [{ id: "scope", text: "旁观" }],
    },
  }, "2026-11-18T07:00:04.000Z");
  const otherDecision = await recordSelectionDecision({ ...item, articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion, inputRevision: other.articleRevision }, "2026-11-18T07:00:05.000Z");
  assert.equal(otherDecision.body.selectionDecision?.boundSemanticJudgmentId, otherSemantic.id);
  const [untouched] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${otherDecision.id}`;
  assert.equal(untouched!.stale, false);
  assert.equal((await listPendingSelections()).some((row) => row.id === otherDecision.id), true);
});

test("a date revision rebinds evidence, and a fixture draft stays pending without publishing", async () => {
  const url = `https://example.com/date-draft-${tag()}`;
  const body = "教程步骤写在正文里。产品更新是另一句。";
  const saved = await appendControlledEvidence({ sourceId: SOURCE, url, title: "日期夹具", raw: { n: 1 }, bodyText: body });
  const excerpt = "教程步骤写在正文里";
  const semantic = await recordFileResult({
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "正文分开写了教程和产品", quoteLocation: { excerpt, start: body.indexOf(excerpt), end: body.indexOf(excerpt) + excerpt.length },
      conditions: ["只在这段正文里"], time: "2026-11-17", valueBasis: "正文写了两句", audience: ["读这一段的人"],
      substantiveAddition: "比标题多了两句", clauses: [{ id: "scope", text: "只覆盖这两句" }],
    },
  }, "2026-11-18T08:00:00.000Z");
  await sql`UPDATE articles SET revision = revision + 1 WHERE id = ${saved.articleId}`;
  await assert.rejects(() => recordFileResult({
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: semantic.body.fileResult!.output,
  }, "2026-11-18T08:00:01.000Z"), /当前文章修订/);
  await assert.rejects(() => recordFileResult({
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision + 1, rulesetVersion: "rules@date", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: semantic.body.fileResult!.output,
  }, "2026-11-18T08:00:02.000Z"), /当前证据没有绑到当前文章修订/);
  const aligned = await alignEvidenceToArticleRevision(saved.articleId);
  assert.equal(aligned.unchanged, false);
  assert.equal(aligned.articleRevision, saved.articleRevision + 1);
  assert.equal(aligned.evidenceHash, saved.evidenceHash);
  assert.equal(aligned.staled, 1);
  const rebound = await recordFileResult({
    articleId: saved.articleId, evidenceHash: aligned.evidenceHash, evidenceVersion: aligned.version,
    inputRevision: aligned.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: semantic.body.fileResult!.output,
  }, "2026-11-18T08:00:03.000Z");
  const decision = await recordSelectionDecision({
    articleId: saved.articleId, evidenceHash: aligned.evidenceHash, evidenceVersion: aligned.version,
    inputRevision: aligned.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@select",
    used_claim: "正文分开写了教程和产品", decision: "candidate", decision_rationale: "夹具理由留在原件里。",
    conditions: ["只在这段正文里"],
  }, "2026-11-18T08:00:04.000Z");
  const draft = await recordReviewDraft({
    articleId: saved.articleId, evidenceHash: aligned.evidenceHash, evidenceVersion: aligned.version,
    inputRevision: aligned.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@draft",
    text: "技术夹具稿，不是对外稿件。", sourceNote: "fixture", conditions: ["只在这段正文里"], technicalFixture: true,
  }, "2026-11-18T08:00:05.000Z");
  assert.equal(draft.body.factStatus, "unchecked");
  assert.equal(draft.body.releaseStatus, "not_licensed");
  assert.equal(draft.body.reviewDraft?.boundSemanticJudgmentId, rebound.id);
  assert.equal(draft.body.reviewDraft?.boundSelectionJudgmentId, decision.id);
  const listed = await listPendingDrafts();
  assert.equal(listed.find((row) => row.id === draft.id)?.text, "技术夹具稿，不是对外稿件。");
  const [parked] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${saved.articleId}`;
  const [published] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id = ${saved.articleId}`;
  assert.equal(parked!.processing_state, "skipped");
  assert.equal(published!.n, 0);
  const other = await appendControlledEvidence({ sourceId: SOURCE, url: `https://example.com/date-other-${tag()}`, title: "旁观", raw: { n: 2 }, bodyText: body });
  const otherSemantic = await recordFileResult({
    articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion,
    inputRevision: other.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "旁观正文", quoteLocation: { excerpt, start: body.indexOf(excerpt), end: body.indexOf(excerpt) + excerpt.length },
      conditions: ["旁观"], time: "2026-11-17", valueBasis: "旁观", audience: ["旁观"], substantiveAddition: "旁观",
      clauses: [{ id: "scope", text: "旁观" }],
    },
  }, "2026-11-18T08:00:06.000Z");
  const otherDecision = await recordSelectionDecision({
    articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion,
    inputRevision: other.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@select",
    decision_rationale: "旁观理由。", conditions: ["旁观"],
  }, "2026-11-18T08:00:07.000Z");
  const otherDraft = await recordReviewDraft({
    articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion,
    inputRevision: other.articleRevision, rulesetVersion: "rules@date", promptVersion: "prompt@draft",
    text: "旁观夹具稿。", sourceNote: "fixture", conditions: ["旁观"], technicalFixture: true,
  }, "2026-11-18T08:00:08.000Z");
  await appendControlledEvidence({ sourceId: SOURCE, url, title: "日期夹具", raw: { n: 1 }, bodyText: `${body}补充。` });
  const [staleDraft] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${draft.id}`;
  const [keptDraft] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${otherDraft.id}`;
  assert.equal(staleDraft!.stale, true);
  assert.equal(keptDraft!.stale, false);
  assert.equal((await listPendingDrafts()).some((row) => row.id === otherDraft.id), true);
  assert.equal(otherSemantic.id.length > 0 && otherDecision.id.length > 0, true);
  const dated = await appendControlledEvidence({ sourceId: SOURCE, url: `https://example.com/date-only-${tag()}`, title: "只补日期", raw: { n: 3 }, bodyText: body });
  const recorded = await recordDateOnly(dated.articleId, new Date("2026-11-17T00:00:00.000Z"), "2026-11-17");
  const [row] = await sql<{ revision: number; publication_time: string | null; body_text: string; processing_state: string; evidence_revision: number }[]>`
    SELECT a.revision, a.publication_time, a.body_text, a.processing_state, v.article_revision AS evidence_revision
    FROM articles a JOIN own_evidence_versions v ON v.article_id = a.id
    WHERE a.id = ${dated.articleId} ORDER BY v.version DESC LIMIT 1`;
  assert.equal(row!.publication_time, "2026-11-17");
  assert.equal(row!.body_text, body);
  assert.equal(Number(row!.revision), Number(row!.evidence_revision));
  assert.equal(row!.processing_state, "skipped");
  assert.equal(recorded.articleRevision, Number(row!.revision));
});

test("a manuscript file imports as a real draft, repeats, and rejects an old revision", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "own-review-draft-"));
  const url = `https://example.com/real-draft-${tag()}`;
  const body = "待审正文要引用的原句在材料里。";
  const excerpt = "待审正文要引用的原句在材料里";
  const saved = await appendControlledEvidence({ sourceId: SOURCE, url, title: "真稿材料", raw: { n: 1 }, bodyText: body });
  await recordFileResult({
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision, rulesetVersion: "rules@draft", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "材料里有这一句", quoteLocation: { excerpt, start: 0, end: excerpt.length },
      conditions: ["只引用这一句"], time: "2026-11-18", valueBasis: "材料写了这一句", audience: ["复核的人"],
      substantiveAddition: "没有新的结论", clauses: [{ id: "scope", text: "只覆盖这一句" }],
    },
  }, "2026-11-18T09:50:00.000Z");
  await recordSelectionDecision({
    articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
    inputRevision: saved.articleRevision, rulesetVersion: "rules@draft", promptVersion: "prompt@select",
    decision_rationale: "选择理由不是稿件正文。", conditions: ["只引用这一句"],
  }, "2026-11-18T09:50:01.000Z");
  const document = {
    schema: "own-review-draft-v1",
    items: [{
      articleId: saved.articleId, evidenceHash: saved.evidenceHash, evidenceVersion: saved.evidenceVersion,
      inputRevision: saved.articleRevision, rulesetVersion: "rules@draft", promptVersion: "prompt@draft",
      text: "这是待审正文，引用材料里的原句。", sourceNote: "文件交来的初稿",
      sourceCitations: [excerpt], conditions: ["只引用这一句"], technicalFixture: false, requiresHumanReview: true,
    }],
  };
  const run = (doc: unknown) => {
    const file = path.join(dir, `draft-${tag()}.json`);
    writeFileSync(file, JSON.stringify(doc));
    return spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-review-draft.ts"), "--file", file], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" },
    });
  };
  const first = run(document);
  assert.equal(first.status, 0, first.stderr);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.items[0].idempotent, false);
  assert.equal(firstJson.items[0].technicalFixture, false);
  assert.equal(firstJson.items[0].requiresHumanReview, true);
  assert.equal(firstJson.items[0].factStatus, "unchecked");
  assert.equal(firstJson.items[0].releaseStatus, "not_licensed");
  const again = run(document);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).items[0].idempotent, true);
  assert.equal(JSON.parse(again.stdout).items[0].judgmentId, firstJson.items[0].judgmentId);
  const staleVersion = run({ ...document, items: [{ ...document.items[0], evidenceVersion: saved.evidenceVersion + 9 }] });
  assert.notEqual(staleVersion.status, 0);
  assert.match(staleVersion.stdout, /当前版本|当前文章修订/);
  const otherUrl = `https://example.com/real-draft-other-${tag()}`;
  const other = await appendControlledEvidence({ sourceId: SOURCE, url: otherUrl, title: "另一篇", raw: { n: 2 }, bodyText: body });
  await recordFileResult({
    articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion,
    inputRevision: other.articleRevision, rulesetVersion: "rules@draft", promptVersion: "prompt@semantic",
    executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
    output: {
      narrowClaim: "另一篇也有这一句", quoteLocation: { excerpt, start: 0, end: excerpt.length },
      conditions: ["另一篇"], time: "2026-11-18", valueBasis: "另一篇", audience: ["复核的人"],
      substantiveAddition: "另一篇", clauses: [{ id: "scope", text: "另一篇" }],
    },
  }, "2026-11-18T09:50:02.000Z");
  await recordSelectionDecision({
    articleId: other.articleId, evidenceHash: other.evidenceHash, evidenceVersion: other.evidenceVersion,
    inputRevision: other.articleRevision, rulesetVersion: "rules@draft", promptVersion: "prompt@select",
    decision_rationale: "另一篇的选择理由。", conditions: ["另一篇"],
  }, "2026-11-18T09:50:03.000Z");
  const otherRun = run({
    schema: "own-review-draft-v1",
    items: [{
      ...document.items[0], articleId: other.articleId, evidenceHash: other.evidenceHash,
      evidenceVersion: other.evidenceVersion, inputRevision: other.articleRevision,
      text: "另一篇的待审正文。", sourceCitations: [excerpt], conditions: ["另一篇"],
    }],
  });
  assert.equal(otherRun.status, 0, otherRun.stderr);
  await appendControlledEvidence({ sourceId: SOURCE, url, title: "真稿材料", raw: { n: 1 }, bodyText: `${body}补充。` });
  const [stale] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${firstJson.items[0].judgmentId}`;
  const [kept] = await sql<{ stale: boolean }[]>`SELECT stale FROM own_judgments WHERE id = ${JSON.parse(otherRun.stdout).items[0].judgmentId}`;
  assert.equal(stale!.stale, true);
  assert.equal(kept!.stale, false);
  const listed = await listPendingDrafts();
  const survivor = listed.find((row) => row.id === JSON.parse(otherRun.stdout).items[0].judgmentId);
  assert.equal(survivor?.technicalFixture, false);
  assert.equal(survivor?.requiresHumanReview, true);
  assert.equal(survivor?.text, "另一篇的待审正文。");
  const [parked] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${other.articleId}`;
  const [published] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id = ${saved.articleId}`;
  assert.equal(parked!.processing_state, "skipped");
  assert.equal(published!.n, 0);
});

test("three unblinded public samples go through the import command", { skip: existsSync(SAMPLES) ? false : "public samples are not in this checkout" }, () => {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-unblinded-drill.ts"), SAMPLES], {
    cwd: process.cwd(), encoding: "utf8", env: {
      ...process.env, DATABASE_URL: process.env.DATABASE_URL, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
      FEISHU_CONTENT_PUSH_ENABLED: "false", DINGTALK_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false",
      INDEXNOW_SUBMIT_ENABLED: "false", BAIDU_PUSH_ENABLED: "false",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { scored: boolean; holdout: boolean; phases: { rawOnly: { judgmentRecorded: number }; repeated: { idempotent: number } }; samples: Array<{ fileSha256: string; canonicalSha256: string }> };
  assert.equal(report.scored, false);
  assert.equal(report.holdout, false);
  assert.equal(report.phases.rawOnly.judgmentRecorded, 0);
  assert.equal(report.phases.repeated.idempotent, 3);
  assert.equal(report.samples.length, 3);
  for (const sample of report.samples) assert.notEqual(sample.fileSha256, sample.canonicalSha256);
});
