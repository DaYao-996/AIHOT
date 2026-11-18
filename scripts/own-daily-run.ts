// One incremental collection of the sources named by the runtime file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { applyStoredAttempt } from "@aihot/backend/content/extract";
import { holdBackAutomaticRelease } from "@aihot/backend/own-pipeline-hold";
import { materialForScoring, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { collectSource, loadSource } from "@aihot/backend/sources/collect";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { serveDaily } from "./own-daily-serve.ts";

interface RuntimeFile {
  listen: string;
  sourceId: string;
  listingState: string;
  stateFile: string;
  samples: Record<string, string>;
  bodyGeneration?: number;
}

const PROMPTS = {
  rulesetVersion: "daily-file-v1",
  semantic: "assistant-file-semantics-daily-v1",
  selection: "assistant-selection-daily-v1",
  draft: "real-draft-daily-v1",
};

async function ensureSource(id: string, listen: string) {
  const config = {
    url: `http://${listen}/listing`,
    itemSelector: "article",
    linkSelector: "a",
    titleSelector: "a",
    publishedAtSelector: "time",
    publishedAtUtcOffset: "+00:00",
    allowUrlPrefixes: [`http://${listen}/`],
    detail: { maxFetches: 8 },
  };
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at, site_fulltext)
    VALUES (${id}, '日常本地', 'web_list', ${sql.json(config)}, 'T1', 'editorial', false, '2100-01-01', false)
    ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = false, site_fulltext = false`;
}

async function judgeUnjudged(sourceId: string): Promise<number> {
  const rows = await sql<{ id: string; url: string; publication_time: string | null }[]>`
    SELECT a.id, a.url, a.publication_time FROM articles a
    WHERE a.source_id = ${sourceId} AND a.body_text IS NOT NULL AND length(a.body_text) >= 140
      AND NOT EXISTS (
        SELECT 1 FROM own_judgments j
        WHERE j.article_id = a.id AND j.stale = false AND j.prompt_version = ${PROMPTS.semantic}
      )`;
  for (const row of rows) {
    const scoring = await materialForScoring(row.id);
    const body = scoring?.bodyText ?? "";
    const excerpt = body.slice(80, 140);
    const start = body.indexOf(excerpt);
    if (start < 0 || excerpt.trim().length < 20) continue;
    const [evidence] = await sql<{ evidence_hash: string; version: number; revision: number }[]>`
      SELECT v.evidence_hash, v.version, a.revision
      FROM articles a JOIN LATERAL (
        SELECT evidence_hash, version FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
      ) v ON true WHERE a.id = ${row.id}`;
    if (!evidence) continue;
    const time = /^\d{4}-\d{2}-\d{2}/.test(row.publication_time ?? "") ? row.publication_time! : "无发布元数据";
    await recordFileResult({
      articleId: row.id, evidenceHash: evidence.evidence_hash, evidenceVersion: Number(evidence.version), inputRevision: Number(evidence.revision),
      rulesetVersion: PROMPTS.rulesetVersion, promptVersion: PROMPTS.semantic,
      executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
      output: {
        narrowClaim: "正文里有这一句", quoteLocation: { excerpt, start, end: start + excerpt.length },
        conditions: ["引文取自当前正文"], time,
        valueBasis: "只引用已保存的正文，不另写事实", audience: ["待审的人"], substantiveAddition: "判断依据是这一句原文",
        clauses: [{ id: "quote", text: "引文必须能在当前正文里按位置取出" }],
      },
    }, "2026-11-18T16:00:00.000Z");
    await recordSelectionDecision({
      articleId: row.id, evidenceHash: evidence.evidence_hash, evidenceVersion: Number(evidence.version), inputRevision: Number(evidence.revision),
      rulesetVersion: PROMPTS.rulesetVersion, promptVersion: PROMPTS.selection,
      decision_rationale: "日常增量里的已保存正文。不是新消息。", conditions: ["旧样本", "不是新消息"],
      sampleRole: "development_sample", timeliness: "historical_backlog", qualityAcceptance: false,
    }, "2026-11-18T16:00:00.000Z");
    await recordReviewDraft({
      articleId: row.id, evidenceHash: evidence.evidence_hash, evidenceVersion: Number(evidence.version), inputRevision: Number(evidence.revision),
      rulesetVersion: PROMPTS.rulesetVersion, promptVersion: PROMPTS.draft,
      text: `待审。正文写有：「${excerpt}」。不是新消息，未核，未许可。`,
      sourceNote: "日常样本。不是新消息，不是质量验收。",
      sourceCitations: [row.url], conditions: ["事实未核", "未许可", "不是新消息"],
      technicalFixture: false, requiresHumanReview: true,
    }, "2026-11-18T16:00:00.000Z");
    await holdBackAutomaticRelease(sql, row.id);
  }
  return rows.length;
}

async function refreshBodies(sourceId: string): Promise<number> {
  const source = await loadSource(sourceId);
  const rows = await sql<{ id: string; url: string; body_text: string }[]>`
    SELECT id, url, body_text FROM articles WHERE source_id = ${sourceId} AND body_status = 'ok' AND body_text IS NOT NULL`;
  let revised = 0;
  for (const row of rows) {
    const refused = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM own_request_attempts
      WHERE url = ${row.url} AND phase = 'failed' AND http_status = 403`;
    if (refused[0]?.n) continue;
    const got = await fetchDetail(row.url, source!, { date: false, title: false, summary: false, body: true });
    if (!got.response?.attemptId || !got.body?.text || got.body.text === row.body_text) continue;
    const applied = await applyStoredAttempt(got.response.attemptId, row.id);
    if (applied.status === "revised") {
      revised += 1;
      await holdBackAutomaticRelease(sql, row.id);
    }
  }
  return revised;
}

export async function serve(runtime: RuntimeFile): Promise<void> {
  await serveDaily(runtime);
}

export async function runDaily(runtime: RuntimeFile): Promise<Record<string, unknown>> {
  if (!runtime.listen || !runtime.sourceId || !runtime.stateFile) throw new Error("运行配置缺少 listen、sourceId 或 stateFile");
  if (runtime.listen.startsWith("127.0.0.1:") || runtime.listen.startsWith("localhost:")) config.allowPrivateNetworkFetch = true;
  await ensureSource(runtime.sourceId, runtime.listen);
  try {
    const collected = await collectSource(runtime.sourceId, { force: true });
    const articles = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${runtime.sourceId}`;
    for (const article of articles) await holdBackAutomaticRelease(sql, article.id);
    const judged = await judgeUnjudged(runtime.sourceId);
    const state = existsSync(runtime.stateFile) ? JSON.parse(readFileSync(runtime.stateFile, "utf8")) as { bodyGeneration?: number } : {};
    const wanted = runtime.bodyGeneration ?? 0;
    let bodyRevisions = 0;
    if (wanted > (state.bodyGeneration ?? 0)) {
      bodyRevisions = await refreshBodies(runtime.sourceId);
      mkdirSync(dirname(runtime.stateFile), { recursive: true });
      writeFileSync(runtime.stateFile, JSON.stringify({ bodyGeneration: wanted }) + "\n");
    }
    const publications = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications`;
    return {
      step: "run",
      sourceId: runtime.sourceId,
      status: collected.status,
      found: collected.found,
      created: collected.created,
      revised: collected.revised,
      judged,
      bodyRevisions,
      articles: articles.length,
      publications: publications[0]?.n ?? 0,
      publish: false,
      macSchedulePassed: false,
    };
  } finally {
    await closeDb();
  }
}
