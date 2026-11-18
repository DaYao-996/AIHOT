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
import { activeJudgment, JudgmentConflict, appendControlledEvidence, commitControlledLoop, materialForScoring, recordJudgment } from "../packages/backend/src/own-pipeline-store.ts";

const SOURCE = `own-pipeline-${tag()}`;
const SAMPLES = process.env.OWN_PUBLIC_SAMPLES
  ?? "/tmp/review-evidence/AIHOT_独立审阅资料/evidence/public_revealed_examples";
const binding = { rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null };

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Own pipeline test', 'external', 'isolated', '2100-01-01')`;
});
after(() => closeDb());

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
