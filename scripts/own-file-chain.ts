// File semantic, selection, and pending draft for material already stored.
// One optional official detail read saves the response and does not rewrite an old body.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { HttpStatusError } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { materialForScoring, recordFileResult, recordReviewDraft, recordSelectionDecision } from "@aihot/backend/own-pipeline-store";
import { loadSource } from "@aihot/backend/sources/collect";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

config.allowPrivateNetworkFetch = true;
const flag = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};
const sealPath = flag("--seal", "");
const configPath = flag("--config", "");
const outDir = flag("--out-dir", "");
if (!sealPath || !configPath || !outDir) throw new Error("需要 --seal --config --out-dir");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
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
const dirty = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "scripts/own-file-chain.ts", "packages/backend/src/sources/collect.ts"], { encoding: "utf8" });
if (dirty.trim()) {
  console.error(dirty);
  process.exit(2);
}
const frozen = JSON.parse(readFileSync(configPath, "utf8")) as {
  fileChain: { minBodyBytes: number; rulesetVersion: string; semanticPrompt: string; selectionPrompt: string; draftPrompt: string };
  detailProbe?: { sourceId: string; url: string };
};
mkdirSync(`${outDir}/logs`, { recursive: true });
const log = (line: string) => { appendFileSync(`${outDir}/logs/chain.log`, line + "\n"); console.log(line); };
const recordedAt = "2026-11-18T13:30:00.000Z";

try {
  const rows = await sql<{ id: string; url: string; title: string; published_at: Date; revision: number; version: number; evidence_hash: string; body_text: string }[]>`
    SELECT a.id, a.url, a.title, a.published_at, a.revision, v.version, v.evidence_hash, v.body_text
    FROM articles a
    JOIN LATERAL (
      SELECT version, evidence_hash, body_text FROM own_evidence_versions WHERE article_id = a.id ORDER BY version DESC LIMIT 1
    ) v ON true
    WHERE a.published_at IS NOT NULL AND a.body_status = 'ok' AND octet_length(v.body_text) >= ${frozen.fileChain.minBodyBytes}
    ORDER BY a.url`;
  const chain = [];
  for (const row of rows) {
    const excerpt = row.body_text.slice(80, 140);
    const start = row.body_text.indexOf(excerpt);
    if (start < 0 || excerpt.trim().length < 20) throw new Error(`引文不成立 ${row.url}`);
    const quote = { excerpt, start, end: start + excerpt.length };
    const time = row.published_at.toISOString().slice(0, 10);
    const semantic = await recordFileResult({
      articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
      rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: frozen.fileChain.semanticPrompt,
      executionSource: "assistant-file", modelKnowledge: "unknown", knownModel: null,
      output: {
        narrowClaim: "正文里有这一句", quoteLocation: quote, conditions: ["引文取自已入库正文"], time,
        valueBasis: "只引用已保存的正文，不另写事实", audience: ["待审的人"], substantiveAddition: "判断依据是这一句原文",
        clauses: [{ id: "quote", text: "引文必须能在当前正文里按位置取出" }],
      },
    }, recordedAt);
    const selection = await recordSelectionDecision({
      articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
      rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: frozen.fileChain.selectionPrompt,
      decision_rationale: "选题只标记这篇已有正文和时间，理由不是稿件正文。", conditions: ["已有发布时间", "引文在正文中"],
    }, recordedAt);
    const draft = await recordReviewDraft({
      articleId: row.id, evidenceHash: row.evidence_hash, evidenceVersion: Number(row.version), inputRevision: Number(row.revision),
      rulesetVersion: frozen.fileChain.rulesetVersion, promptVersion: frozen.fileChain.draftPrompt,
      text: `待审。${row.title} 的正文写有：「${excerpt}」。`, sourceNote: "稿件引用已入库正文，不采用选题理由。",
      sourceCitations: [row.url], conditions: ["事实未核", "未许可"], technicalFixture: false, requiresHumanReview: true,
    }, recordedAt);
    const view = await materialForScoring(row.id);
    chain.push({
      url: row.url, publishedAt: time, bodyBytes: Buffer.byteLength(row.body_text),
      scoringSame: view?.bodyText === row.body_text, evidenceHash: row.evidence_hash,
      semanticId: semantic.id, selectionId: selection.id, draftId: draft.id,
      releaseStatus: draft.body.releaseStatus, factStatus: draft.body.factStatus,
    });
    log(`CHAIN ${row.url} body=${Buffer.byteLength(row.body_text)} date=${time} draft=${draft.id}`);
  }
  let probe = null;
  if (frozen.detailProbe) {
    const source = await loadSource(frozen.detailProbe.sourceId);
    if (!source) throw new Error("没有这个源");
    try {
      const got = await fetchDetail(frozen.detailProbe.url, source, { date: true, title: false, summary: false, body: true });
      const bytes = got.response?.bytes ?? Buffer.alloc(0);
      const raw = bytes.toString("utf8");
      const extracted = got.body?.text ?? "";
      const note = `rawHasAbout=${raw.includes("About NVIDIA")} extractedHasAbout=${extracted.includes("About NVIDIA")} extractedBytes=${Buffer.byteLength(extracted)} rawBytes=${bytes.length}; the slice is not a completeness claim`;
      await sql`INSERT INTO own_detail_responses (source_id, url, http_status, response, response_sha256, truncated, extracted_bytes, extraction_note)
        VALUES (${source.id}, ${frozen.detailProbe.url}, ${got.response?.status ?? null}, ${bytes}, ${sha256(bytes)}, ${got.response?.truncated ?? false}, ${Buffer.byteLength(extracted)}, ${note})`;
      probe = { url: frozen.detailProbe.url, status: got.response?.status ?? null, rawBytes: bytes.length, sha256: sha256(bytes), extractedBytes: Buffer.byteLength(extracted), note, publishedAt: got.publishedAt?.toISOString() ?? null };
      log(`PROBE ${probe.url} status=${probe.status} raw=${probe.rawBytes} extracted=${probe.extractedBytes}`);
    } catch (error) {
      const status = error instanceof HttpStatusError ? error.status : null;
      const message = error instanceof Error ? error.message.slice(0, 180) : String(error);
      await sql`INSERT INTO fetch_runs (source_id, status, finished_at, found_count, new_count, error, detail)
        VALUES (${source.id}, 'failed', now(), 0, 0, ${message}, ${sql.json({ requests: 1, httpStatus: status, retryable: false, bypassed403: false })})`;
      probe = { url: frozen.detailProbe.url, status, error: message, retried: false };
      log(`PROBE FAIL ${frozen.detailProbe.url} status=${status} ${message}`);
    }
  }
  const [counts] = await sql<{ publications: number; receipts: number }[]>`
    SELECT (SELECT count(*)::int FROM publications) AS publications, (SELECT count(*)::int FROM receipts) AS receipts`;
  const report = { contractPassed: false, workerStarted: false, chain, probe, publications: counts!.publications, receipts: counts!.receipts };
  writeFileSync(`${outDir}/CHAIN.json`, JSON.stringify(report, null, 2));
  log(JSON.stringify({ ok: true, drafts: chain.length, publications: counts!.publications, receipts: counts!.receipts }));
} finally {
  await stopBoss();
  await closeDb();
}
