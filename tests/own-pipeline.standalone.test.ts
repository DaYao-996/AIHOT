import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORIES, CATEGORY_TAGS, ITEM_TYPES } from "@aihot/industry/taxonomy";
import { awaitsMaterial } from "../packages/backend/src/editorial/analyze.ts";
import { promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { missingEvidence } from "../packages/backend/src/editorial/writing.ts";
import { needsGrouping } from "../packages/backend/src/jobs/content.ts";
import { pushEnabled } from "../packages/backend/src/notify/deliver.ts";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { migrationPlan } from "../scripts/migration-safety.ts";
import {
  CONTENT_LINES,
  COST_INPUTS,
  HISTORICAL_RULESET,
  INFORMATION_TYPES,
  ImportRejected,
  JudgmentLedger,
  UPSTREAM_CATEGORY_PROMOTION,
  assertThrowawayDatabase,
  assessSwitches,
  cliEntryAllowed,
  cumulativeEvidenceHash,
  historicalBand,
  informationType,
  mapControlledImport,
  parseFileResultDocument,
  parseImportDocument,
  unblindedStructureGaps,
  type JudgmentBody,
  type JudgmentIdentity,
} from "../site/own-pipeline.ts";

const root = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

const binding = { rulesetVersion: HISTORICAL_RULESET, promptVersion: "none", modelVersion: null };

function identity(over: Partial<JudgmentIdentity> = {}): JudgmentIdentity {
  return { articleId: "a", inputRevision: 1, evidenceHash: "e1", ...binding, ...over };
}

function body(over: Partial<JudgmentBody> = {}): JudgmentBody {
  return {
    informationTypeId: null,
    contentLine: null,
    materialStatus: "missing_body",
    factStatus: "unchecked",
    valueStatus: "incomplete_material",
    releaseStatus: "not_licensed",
    origin: "deterministic",
    reasons: ["缺正文，不算低价值"],
    ...over,
  };
}

test("historical information types are transcribed, not promoted into upstream categories", () => {
  assert.equal(UPSTREAM_CATEGORY_PROMOTION, "refused");
  assert.equal(INFORMATION_TYPES.length, 25);
  assert.equal(INFORMATION_TYPES.filter((row) => row.id !== "other").length, 24);
  assert.equal(CATEGORIES.length, 6);
  assert.equal(CATEGORY_TAGS.length, 13);
  assert.equal(ITEM_TYPES.length, 7);
  const categoryKeys = new Set<string>(CATEGORIES.map((row) => row.key));
  for (const row of INFORMATION_TYPES) {
    assert.equal(categoryKeys.has(row.id), false, row.id);
    assert.equal(informationType(row.id)?.label, row.label);
  }
  assert.equal(informationType("ai-models"), null);
  assert.deepEqual(CONTENT_LINES.map((row) => row.id), ["line1", "line2"]);
  assert.equal(historicalBand(80).band, "70+");
  assert.equal(historicalBand(80).acceptedProductionLine, false);
  assert.equal(historicalBand(55).band, "55-69");
  assert.equal(historicalBand(40).band, "40-54");
  assert.equal(historicalBand(39).band, "<40");
  assert.equal(historicalBand(null).band, "unscored");
  const leak = informationType("price-leak");
  assert.equal(leak?.points, 6);
  assert.equal(leak && "line2Points" in leak ? leak.line2Points : null, 40);
});

test("a judgment keeps old evidence and only stales the same binding", () => {
  const ledger = new JudgmentLedger();
  const first = ledger.record(identity(), body(), "t1");
  const again = ledger.record(identity(), body(), "t2");
  assert.equal(again.idempotent, true);
  assert.equal(again.row, first.row);
  assert.equal(ledger.rows.length, 1);

  const revised = ledger.record(identity({ inputRevision: 2, evidenceHash: "e2" }), body({ reasons: ["修订后仍缺正文"] }), "t3");
  assert.equal(revised.idempotent, false);
  assert.equal(first.row.stale, true);
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.current("a", binding)?.identity.inputRevision, 2);

  const otherModel = ledger.record(identity({ inputRevision: 2, evidenceHash: "e2", modelVersion: "m2" }), body(), "t4");
  assert.equal(otherModel.row.stale, false);
  assert.equal(ledger.current("a", binding)?.id, revised.row.id);
  assert.equal(ledger.current("a", { ...binding, modelVersion: "m2" })?.id, otherModel.row.id);

  const otherArticle = ledger.record(identity({ articleId: "b" }), body(), "t5");
  const staled = ledger.staleMatching({ rulesetVersion: HISTORICAL_RULESET, promptVersion: "none", modelVersion: null });
  assert.equal(staled.includes(revised.row.id), true);
  assert.equal(staled.includes(otherModel.row.id), false);
  assert.equal(staled.includes(otherArticle.row.id), true);
  assert.equal(ledger.rows.length, 4);
  assert.equal(ledger.current("b", binding), null);
  assert.ok(ledger.rows.every((row) => row.body.releaseStatus === "not_licensed"));
});

test("blank prompt and model versions are one identity", () => {
  const ledger = new JudgmentLedger();
  const first = ledger.record(identity({ promptVersion: null, modelVersion: "  " }), body(), "t1");
  const again = ledger.record(identity({ promptVersion: "", modelVersion: null }), body(), "t2");
  assert.equal(again.idempotent, true);
  assert.equal(again.row.id, first.row.id);
  assert.equal(first.row.identity.promptVersion, "");
  assert.equal(first.row.identity.modelVersion, "");
  assert.equal(ledger.rows.length, 1);
  const trimmed = ledger.record(identity({ promptVersion: " prefilter@abc ", modelVersion: null }), body(), "t3");
  const same = ledger.record(identity({ promptVersion: "prefilter@abc", modelVersion: "" }), body(), "t4");
  assert.equal(same.idempotent, true);
  assert.equal(same.row.id, trimmed.row.id);
  assert.notEqual(trimmed.row.id, first.row.id);
});

test("the same judgment identity cannot change its result, and a gap cannot become a value", () => {
  const ledger = new JudgmentLedger();
  ledger.record(identity(), body(), "t1");
  assert.throws(() => ledger.record(identity(), body({ reasons: ["另一套理由"] }), "t2"), /同一判断身份/);
  assert.equal(ledger.rows.length, 1);
  assert.throws(() => ledger.record(identity({ evidenceHash: "e9" }), body({ valueStatus: "reference_only" }), "t3"), /材料不完整/);
  const kept = ledger.record(identity({ articleId: "c", evidenceHash: "e3" }), body({
    materialStatus: "complete", factStatus: "source_claim", valueStatus: "reference_only", reasons: ["来源这样说，尚未核对"],
    comparison: { algorithm: "source-claim-v1", inputHash: sha256(stableJson({ algorithm: "source-claim-v1", evidenceHash: "e3" })) },
  }), "t5");
  assert.throws(() => ledger.record(identity({ articleId: "d", evidenceHash: "e4" }), body({
    materialStatus: "complete", valueStatus: "reference_only", reasons: ["没有对照"],
  }), "t6"), /对照算法/);
  assert.equal(kept.row.body.factStatus, "source_claim");
  assert.equal(kept.row.body.releaseStatus, "not_licensed");
  assert.throws(() => ledger.staleMatching({}), /不能为空/);
});

test("raw text is stored aside and does not become body, quote, or the upstream hash", () => {
  const raw = {
    root_text: "帖子正文在原件里",
    quote: { text: "被引用的另一帖" },
    bodies: { paid_full_text: "帖子正文在原件里" },
  };
  const held = mapControlledImport({ sourceId: "src-x", url: "https://x.com/someone/status/2117095432526700766", title: "一条标题", raw });
  assert.equal(held.bodyText, null);
  assert.equal(held.quotedText, null);
  assert.equal(held.material.xPost, null);
  assert.equal(held.material.raw, raw);
  assert.equal(held.identityKey, "x:2117095432526700766");
  assert.ok(held.gaps.includes("missing_body"));
  assert.ok(held.gaps.includes("raw_text_not_promoted"));
  assert.ok(held.gaps.includes("x_post_not_attached"));

  const withBody = mapControlledImport({
    sourceId: "src-x", url: held.material.url, title: "一条标题", raw, bodyText: "显式正文", quotedText: "显式引用",
  });
  assert.equal(withBody.bodyText, "显式正文");
  assert.equal(withBody.quotedText, "显式引用");
  assert.equal(withBody.material.xPost, null);
  assert.notEqual(withBody.upstreamContentHash, held.upstreamContentHash);
  assert.ok(withBody.gaps.includes("quote_not_in_body_or_revision"));
  assert.equal(withBody.material.bodyText?.includes("显式引用"), false);

  const rawChanged = mapControlledImport({
    sourceId: "src-x", url: held.material.url, title: "一条标题", raw: { ...raw, extra: 1 }, bodyText: "显式正文", quotedText: "显式引用",
  });
  assert.equal(rawChanged.upstreamContentHash, withBody.upstreamContentHash);
  assert.notEqual(rawChanged.evidenceHash, withBody.evidenceHash);

  const quoteChanged = mapControlledImport({
    sourceId: "src-x", url: held.material.url, title: "一条标题", raw, bodyText: "显式正文", quotedText: "另一段引用",
  });
  assert.equal(quoteChanged.upstreamContentHash, withBody.upstreamContentHash);
  assert.notEqual(quoteChanged.evidenceHash, withBody.evidenceHash);

  const xPost = { tweetId: "2117095432526700766", authorName: "A", handle: "someone", text: "显式正文", quoted: { authorName: "B", handle: "other", text: "显式引用", url: "https://x.com/other/status/1" } };
  const attached = mapControlledImport({ sourceId: "src-x", url: held.material.url, title: "一条标题", raw, bodyText: "显式正文", quotedText: "显式引用", xPost });
  assert.equal(attached.identityKey, "x:2117095432526700766");
  assert.equal(attached.material.xPost?.quoted?.text, "显式引用");
  assert.equal(attached.upstreamContentHash, withBody.upstreamContentHash);
  assert.notEqual(attached.evidenceHash, withBody.evidenceHash);
});

test("isolated material does not qualify for grouping, and the pinned source skips it before analyze", () => {
  const modes = ["editorial", "hot_signal", "isolated"] as const;
  for (const participationMode of modes) {
    for (const historical of [false, true]) {
      for (const relevance of ["pass", "block", null]) {
        assert.equal(
          needsGrouping({ participationMode, historical, relevance }),
          participationMode === "editorial" ? relevance === "pass" : participationMode === "hot_signal" && !historical,
        );
      }
    }
  }
  assert.equal(needsGrouping({ participationMode: "isolated", historical: false, relevance: "pass" }), false);

  const content = source("packages/backend/src/jobs/content.ts");
  assert.match(content, /const signal = row\.participation_mode !== "editorial"/);
  assert.match(content, /if \(r\.signal && !attemptTag\) \{\s*return enqueue\(QUEUES\.group, \{ articleId, signalOnly: true \}/);
  assert.match(content, /if \(row\.participation_mode !== "editorial"\) \{[\s\S]*return \{ state: "skipped" \}/);

  const events = source("packages/backend/src/jobs/events.ts");
  assert.match(events, /if \(signalOnly && !\(await settleNonEditorial\(articleId\)\)\.group\) return \{ verdict: "skipped" \}/);
  assert.match(events, /s\.participation_mode = 'editorial' AND a\.processing_state = 'analyzed'/);
  assert.match(events, /s\.participation_mode = 'hot_signal'/);

  const group = source("packages/backend/src/events/group.ts");
  assert.match(group, /if \(opts\.signalOnly \|\| a\.participation_mode !== "editorial"\) return groupSignal/);

  const analyze = source("packages/backend/src/editorial/analyze.ts");
  assert.match(analyze, /if \(prefilter\.label === "BLOCK"\) return \{ prefilter, scores: null, writing: null, structure: null \}/);
  assert.match(analyze, /res\.data\.label === "BLOCK" && missingEvidence\(a\) \? "UNKNOWN"/);
  assert.match(analyze, /if \(awaitsMaterial\(a\)\) return \{ prefilter: null, scores: null, writing: null, structure: null \}/);

  const titleOnly = { bodyText: null, excerpt: null, xPost: null, url: "https://example.com/a", source: { kind: "rss" } };
  assert.equal(missingEvidence(titleOnly as never), true);
  assert.equal(awaitsMaterial(titleOnly as never), true);
  assert.equal(awaitsMaterial({ ...titleOnly, bodyText: "有正文" } as never), false);
});

test("stopping web and api does not disarm worker schedules", () => {
  const closed = assessSwitches({}, false);
  assert.equal(closed.every((row) => row.armed === false), true);
  assert.equal(closed.find((row) => row.id === "ops.retention")?.registeredWhenWorkerStarts, true);
  assert.equal(closed.find((row) => row.id === "seo.indexnow")?.registeredWhenWorkerStarts, true);
  assert.equal(closed.find((row) => row.id === "notify.content.feishu")?.registeredWhenWorkerStarts, true);

  const worker = assessSwitches({}, true);
  assert.equal(worker.find((row) => row.id === "ops.retention")?.armed, true);
  assert.equal(worker.find((row) => row.id === "hot.rank")?.armed, true);
  assert.equal(worker.find((row) => row.id === "collect.fetch")?.armed, false);
  assert.equal(worker.find((row) => row.id === "model.calls")?.armed, false);
  assert.equal(worker.find((row) => row.id === "seo.indexnow")?.armed, false);
  assert.equal(worker.find((row) => row.id === "seo.baidu-push")?.armed, false);
  assert.equal(worker.find((row) => row.id === "notify.ops")?.armed, false);

  const open = assessSwitches({
    COLLECT_ENABLED: "TRUE",
    MODEL_CALLS_ENABLED: "true",
    FEISHU_CONTENT_PUSH_ENABLED: "true",
    DINGTALK_CONTENT_PUSH_ENABLED: "true",
    FEISHU_INTERNAL_ENABLED: "true",
    INDEXNOW_SUBMIT_ENABLED: "true",
    INDEXNOW_KEY: "a".repeat(32),
    BAIDU_PUSH_ENABLED: "true",
    BAIDU_PUSH_TOKEN: "token",
    DAJIALA_KEY: "key",
  }, true);
  assert.equal(open.find((row) => row.id === "collect.fetch")?.armed, false);
  assert.equal(open.find((row) => row.id === "collect.mp")?.armed, false);
  assert.equal(open.find((row) => row.id === "model.calls")?.armed, true);
  assert.equal(open.find((row) => row.id === "seo.indexnow")?.armed, true);
  assert.equal(pushEnabled("feishu_webhook"), false);
  assert.equal(pushEnabled("dingtalk_webhook"), false);

  const schedules = source("apps/worker/src/schedules.ts");
  assert.match(schedules, /name: "content.translate"/);
  assert.match(schedules, /name: "seo.indexnow"/);
  assert.match(schedules, /name: "seo.baidu-push"/);
  assert.match(schedules, /name: "ops.alerts"/);
  assert.match(schedules, /name: "ops.retention"/);
  assert.match(schedules, /collecting\s*\?/);
  const main = source("apps/worker/src/main.ts");
  assert.match(main, /if \(process\.env\.COLLECT_ENABLED === "true"\) await registerSourceJobs\(boss\)/);
  assert.match(main, /await registerNotifyJobs\(boss\)/);
  assert.match(main, /await registerEventJobs\(boss\)/);
  assert.equal(source("site/modules/server.ts").includes("export const SERVER_MODULES: readonly ServerModule[] = [];"), true);
  assert.match(source("docker-compose.yml"), /node scripts\/migrate\.ts && node scripts\/seed\.ts/);
  assert.match(source("packages/backend/src/ingest/items.ts"), /'isolated'/);
  assert.match(source("packages/backend/src/content/materials.ts"), /body_text, body_html, body_status, media, x_post, raw/);
  const materials = source("packages/backend/src/content/materials.ts");
  const revisionAt = materials.indexOf("x_post = coalesce(${m.xPost");
  assert.ok(revisionAt > 0);
  const revisionSet = materials.slice(revisionAt - 600, revisionAt + 40);
  assert.match(revisionSet, /body_text = coalesce/);
  assert.equal(revisionSet.includes("raw"), false);

  const judgmentSql = source("database/migrations/0170_own_judgments.sql");
  assert.equal(migrationPlan(judgmentSql).kind, "transaction");
  assert.match(judgmentSql, /prompt_version text NOT NULL DEFAULT ''/);
  assert.match(judgmentSql, /UNIQUE \(article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version\)/);
  assert.equal(judgmentSql.includes("NULLS NOT DISTINCT"), false);
  assert.match(judgmentSql, /release_status text NOT NULL DEFAULT 'not_licensed'/);
  assert.equal(/\binsert\b/i.test(judgmentSql), false);
  assert.equal(/\banalyses\b/i.test(judgmentSql), false);
  const evidenceSql = source("database/migrations/0171_own_evidence_versions.sql");
  assert.equal(migrationPlan(evidenceSql).kind, "transaction");
  assert.match(evidenceSql, /PRIMARY KEY \(article_id, version\)/);
  assert.equal(/\bupdate\b/i.test(evidenceSql), false);
  assert.equal(migrationPlan(source("database/migrations/0172_own_judgments_origin.sql")).kind, "transaction");
  assert.equal(migrationPlan(source("database/migrations/0173_own_judgments_origin_check.sql")).kind, "transaction");
  assert.equal(migrationPlan(source("database/migrations/0174_own_judgments_origin_validate.sql")).kind, "validation");
  assert.equal(migrationPlan(source("database/migrations/0175_own_evidence_raw_identity.sql")).kind, "transaction");
  assert.equal(migrationPlan(source("database/migrations/0180_own_judgments_origin_file_drop.sql")).kind, "transaction");
  assert.equal(migrationPlan(source("database/migrations/0181_own_judgments_origin_file_check.sql")).kind, "transaction");
  assert.equal(migrationPlan(source("database/migrations/0182_own_judgments_origin_file_validate.sql")).kind, "validation");
});

test("import files reject unknown fields and a mismatched original hash", () => {
  const raw = { text: "原件" };
  const doc = parseImportDocument({ sourceId: "src_1", items: [{ url: "https://example.com/a", title: "标题", raw }] });
  assert.equal(doc.items[0]!.rawCanonicalSha256.length, 64);
  assert.equal(doc.items[0]!.rawFileSha256, null);
  assert.throws(() => parseImportDocument({ sourceId: "src_1", items: [{ url: "https://example.com/a", title: "标题", raw, score: 80 }] }), ImportRejected);
  const fileHash = "a".repeat(64);
  const withFile = parseImportDocument({ sourceId: "src_1", items: [{ url: "https://example.com/a", title: "标题", raw, rawFileSha256: fileHash }] });
  assert.equal(withFile.items[0]!.rawFileSha256, fileHash);
  assert.notEqual(withFile.items[0]!.rawCanonicalSha256, fileHash);
  assert.throws(() => parseImportDocument({ sourceId: "src_1", items: [{ url: "https://example.com/a", title: "标题", raw, rawCanonicalSha256: "ab" }] }), /规范化 JSON/);
  assert.throws(() => parseImportDocument({ sourceId: "src_1", items: [{ url: "https://example.com/a", title: "标题", raw, rawSha256: fileHash }] }), /未知字段/);
  assert.throws(() => parseImportDocument({ sourceId: "src_1", items: [{ url: "javascript:alert(1)", title: "标题", raw }] }), /http/);
});

test("a model judgement cannot hide behind an empty version", () => {
  const ledger = new JudgmentLedger();
  assert.throws(() => ledger.record(identity({ promptVersion: null, modelVersion: "" }), body({ origin: "model" }), "t"), /可追溯/);
  assert.throws(() => ledger.record(identity({ promptVersion: "prefilter@abc", modelVersion: "stub" }), body({ origin: "model", reasons: ["只有版本字符串"] }), "t2"), /回执/);
  const row = ledger.record(identity({ promptVersion: "prefilter@abc", modelVersion: "stub" }), body({ origin: "model", reasons: ["带来源"], modelReceiptId: 1 }), "t3");
  assert.equal(row.row.body.origin, "model");
  assert.equal(row.row.identity.promptVersion, "prefilter@abc");
  assert.equal(cliEntryAllowed({}).ok, true);
  assert.equal(cliEntryAllowed({ COLLECT_ENABLED: "true" }).ok, false);
  assert.equal(cliEntryAllowed({ MODEL_CALLS_ENABLED: "true" }).outboundIfWorker.includes("model.calls"), true);
});

test("a file result schema accepts a narrow claim and rejects a score or a claimed hash", () => {
  const item = {
    articleId: "article-1", evidenceHash: "a".repeat(64), evidenceVersion: 2, inputRevision: 3,
    rulesetVersion: "rules@1", promptVersion: "prompt@1", executionSource: "assistant-file", knownModel: null,
    output: {
      narrowClaim: "这是一个窄主张",
      quoteLocation: { excerpt: "原句在这里", start: null, end: null },
      conditions: ["只在正文出现时"],
      audience: ["读发布说明的人"],
      substantiveAddition: "相对标题多了一句限制",
      clauses: [{ id: "scope", text: "只覆盖这一段" }],
    },
  };
  const parsed = parseFileResultDocument({ schema: "own-file-result-v1", items: [item] });
  assert.equal(parsed[0]!.output.narrowClaim, "这是一个窄主张");
  assert.equal(parsed[0]!.knownModel, null);
  assert.throws(() => parseFileResultDocument({ schema: "own-file-result-v1", items: [{ ...item, outputSha256: "b".repeat(64) }] }), /格式无法解析/);
  assert.throws(() => parseFileResultDocument({ schema: "own-file-result-v1", items: [{ ...item, output: { ...item.output, score: 80 } }] }), /score|格式无法解析/);
  assert.throws(() => parseFileResultDocument({ schema: "own-file-result-v1", items: [{ ...item, executionSource: "gpt-4o" }] }), /executionSource/);
});

test("throwaway database guard rejects remote and production names", () => {
  assert.doesNotThrow(() => assertThrowawayDatabase("postgres://own_test:own_test@127.0.0.1:5432/own_pipeline_test"));
  assert.throws(() => assertThrowawayDatabase("postgres://own_test@db.example.com:5432/own_pipeline_test"), /非本机/);
  assert.throws(() => assertThrowawayDatabase("postgres://127.0.0.1:5432/aihot"), /非临时库/);
  assert.throws(() => assertThrowawayDatabase("postgres://127.0.0.1:5432/private24_test"), /生产/);
});

test("evidence hash changes when a quote is added and keeps the original raw in the hash input", () => {
  const raw = { root_text: "原件" };
  const base = { rawVersions: [raw], bodyText: "正文", quotedText: null, xPost: null };
  const quoted = { ...base, quotedText: "引用" };
  assert.notEqual(cumulativeEvidenceHash(base), cumulativeEvidenceHash(quoted));
  assert.equal(cumulativeEvidenceHash({ ...quoted, rawVersions: [raw, { extra: 1 }] }) === cumulativeEvidenceHash(quoted), false);
  const gaps = unblindedStructureGaps(
    { root_text: "正文", quote: { status: "present", text: "引用" } },
    { schema: "writer046-socialdata-search-raw-v1" },
  );
  assert.equal(gaps.scored, false);
  assert.ok(gaps.gaps.includes("record_quote_not_stored_until_explicit"));
  assert.ok(gaps.gaps.includes("raw_is_search_page_snapshot"));
  assert.equal(unblindedStructureGaps({ root_text: "正文", quote: { status: "not_a_quote" } }, {}).gaps.includes("quote_not_applicable"), true);
});

test("cost inputs stay blank where this round has no price evidence", () => {
  const byService = new Map(COST_INPUTS.map((row) => [row.service, row]));
  assert.equal(byService.get("llm.input")?.amount, null);
  assert.equal(byService.get("llm.output")?.amount, null);
  assert.equal(byService.get("prior-api.estimate")?.amount, 2.06);
  assert.equal(byService.get("socialdata")?.basis, "code-comment");
  assert.equal(byService.get("jina")?.amount, 0.36);
  for (const name of ["prefilter", "selection-score", "structure"] as const) {
    assert.match(promptVersion(name), new RegExp(`^${name}@[0-9a-f]{10}$`));
  }
});
