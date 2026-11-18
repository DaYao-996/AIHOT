// Database loop for controlled import, evidence versions and own judgements.
// Unblinded public posts are gap checks only. They are not a new holdout.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stableJson } from "@aihot/backend/lib/ids";
import { HISTORICAL_RULESET, unblindedStructureGaps, type JudgmentBody } from "../site/own-pipeline.ts";
import { JudgmentConflict, appendControlledEvidence, commitControlledLoop, recordJudgment } from "../packages/backend/src/own-pipeline-store.ts";

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

function supplementedBody(reasons: string[]): JudgmentBody {
  return {
    informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
    valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "deterministic", reasons,
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
    supplementedBody(["已补正文，仍未评分"]), "2026-11-18T00:01:00.000Z", binding,
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

  const [article] = await sql<{ revision: number; raw: unknown; body_text: string | null; x_post: unknown; processing_queued_at: Date | null }[]>`
    SELECT revision, raw, body_text, x_post, processing_queued_at FROM articles WHERE id = ${first.evidence.articleId}`;
  assert.equal(article!.revision, 2);
  assert.equal(stableJson(article!.raw), stableJson(original));
  assert.equal(article!.body_text, "显式正文");
  assert.equal(article!.x_post, null);
  assert.equal(article!.processing_queued_at, null);
  const revisions = await sql<{ revision: number; body_text: string | null }[]>`
    SELECT revision, body_text FROM article_revisions WHERE article_id = ${first.evidence.articleId} ORDER BY revision`;
  assert.deepEqual(revisions.map((row) => row.revision), [1, 2]);

  const versions = await sql<{ version: number; raw: unknown; body_text: string | null; quoted_text: string | null }[]>`
    SELECT version, raw, body_text, quoted_text FROM own_evidence_versions
    WHERE article_id = ${first.evidence.articleId} ORDER BY version`;
  assert.equal(stableJson(versions[0]!.raw), stableJson(original));
  assert.equal(versions[0]!.body_text, null);
  assert.equal(versions[1]!.raw, null);
  assert.equal(versions[1]!.body_text, "显式正文");
  assert.equal(versions[2]!.quoted_text, "显式引用");
  assert.equal(versions[2]!.raw, null);
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
  const traced = await recordJudgment({
    ...saved.judgment.identity, promptVersion: "prefilter@abc", modelVersion: "stub-model",
  }, { ...gapBody(["带来源"]), origin: "model" }, "2026-11-18T04:00:03.000Z");
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
    items: [{ url: `https://example.com/cli-${tag()}`, title: "命令导入", raw, rawSha256: createHash("sha256").update(stableJson(raw)).digest("hex") }],
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

test("three unblinded public samples only record body, quote and raw gaps", { skip: existsSync(SAMPLES) ? false : "public samples are not in this checkout" }, async () => {
  const ids = readdirSync(SAMPLES).filter((name) => existsSync(`${SAMPLES}/${name}/record.json`)).sort();
  assert.equal(ids.length, 3);
  for (const id of ids) {
    const rawBytes = readFileSync(`${SAMPLES}/${id}/raw.json`);
    const record = JSON.parse(readFileSync(`${SAMPLES}/${id}/record.json`, "utf8")) as {
      handle: string; post_id: string; root_text: string; quote?: { status?: string; text?: string };
    };
    const raw = JSON.parse(rawBytes.toString("utf8")) as unknown;
    const gaps = unblindedStructureGaps(record, raw);
    assert.equal(gaps.scored, false);
    assert.equal(createHash("sha256").update(rawBytes).digest("hex").length, 64);
    const url = `https://x.com/${record.handle}/status/${record.post_id}`;
    const first = await commitControlledLoop(
      { sourceId: SOURCE, url, title: record.root_text.slice(0, 40), raw },
      gapBody([`${id} 只记缺口，未评分`]), "2026-11-18T03:00:00.000Z", binding,
    );
    const quote = record.quote?.status === "present" ? record.quote.text : undefined;
    const second = await commitControlledLoop(
      { sourceId: SOURCE, url, title: record.root_text.slice(0, 40), raw, bodyText: record.root_text, quotedText: quote },
      supplementedBody([`${id} 显式补入正文，未评分`]), "2026-11-18T03:01:00.000Z", binding,
    );
    const versions = await sql<{ version: number; raw: unknown; body_text: string | null; quoted_text: string | null }[]>`
      SELECT version, raw, body_text, quoted_text FROM own_evidence_versions WHERE article_id = ${first.evidence.articleId} ORDER BY version`;
    assert.equal(stableJson(versions[0]!.raw), stableJson(raw));
    assert.equal(versions[0]!.body_text, null);
    assert.equal(versions[1]!.version, 2);
    assert.equal(versions[1]!.body_text, record.root_text);
    assert.equal(versions[1]!.quoted_text, quote ?? null);
    const [article] = await sql<{ raw: unknown }[]>`SELECT raw FROM articles WHERE id = ${first.evidence.articleId}`;
    assert.equal(stableJson(article!.raw), stableJson(raw));
    assert.equal(second.judgment.body.informationTypeId, null);
    assert.equal(second.judgment.body.releaseStatus, "not_licensed");
    const [scored] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${first.evidence.articleId}`;
    assert.equal(scored!.n, 0);
  }
});
