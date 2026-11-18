// One-shot import. No worker, no model, no scoring, no queueProcessing.
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { appendControlledEvidence, recordJudgment } from "@aihot/backend/own-pipeline-store";
import {
  HISTORICAL_RULESET,
  ImportRejected,
  assertThrowawayDatabase,
  cliEntryAllowed,
  mapControlledImport,
  parseImportDocument,
  type JudgmentBody,
} from "../site/own-pipeline.ts";

const dryRun = process.argv.includes("--dry-run");
const fileFlag = process.argv.indexOf("--file");
const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : "";

async function main() {
  if (!file) throw new ImportRejected("usage: node scripts/own-import.ts --file <items.json> [--dry-run]");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const gate = cliEntryAllowed(process.env);
  if (!gate.ok) throw new ImportRejected(`外发或模型开关打开，拒绝导入：${gate.outboundIfWorker.join(",")}`);
  const parsed = parseImportDocument(JSON.parse(readFileSync(file, "utf8")));
  const [source] = await sql<{ id: string }[]>`SELECT id FROM sources WHERE id = ${parsed.sourceId}`;
  if (!source) throw new ImportRejected("源不存在，拒绝自动建源");
  const counts = { items: parsed.items.length, evidenceAppended: 0, idempotent: 0, judgmentRecorded: 0, judgmentSkippedIncomplete: 0, rejected: 0 };
  const items = [];
  for (const item of parsed.items) {
    const mapped = mapControlledImport(item);
    const complete = mapped.bodyText !== null;
    if (dryRun) {
      items.push({
        url: item.url, identityKey: mapped.identityKey, rawSha256: item.rawSha256, gaps: mapped.gaps,
        completeness: complete ? "body_present" : "missing_body", judgment: "dry_run", scored: false, valueJudgment: false,
      });
      continue;
    }
    try {
      const evidence = await appendControlledEvidence(item);
      if (evidence.idempotent) counts.idempotent += 1;
      else counts.evidenceAppended += 1;
      let judgment: "not_written_incomplete" | "recorded_deterministic" | "idempotent" = "not_written_incomplete";
      if (!complete) counts.judgmentSkippedIncomplete += 1;
      else {
        const body: JudgmentBody = {
          informationTypeId: null, contentLine: null, materialStatus: "complete", factStatus: "unchecked",
          valueStatus: "reference_only", releaseStatus: "not_licensed", origin: "deterministic", reasons: ["未评分"],
        };
        const recorded = await recordJudgment({
          articleId: evidence.articleId, inputRevision: evidence.articleRevision, evidenceHash: evidence.evidenceHash,
          rulesetVersion: HISTORICAL_RULESET, promptVersion: null, modelVersion: null,
        }, body, new Date().toISOString());
        judgment = recorded.idempotent ? "idempotent" : "recorded_deterministic";
        if (!recorded.idempotent) counts.judgmentRecorded += 1;
      }
      const [projection] = await sql<{ publications: number; deliveries: number }[]>`
        SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${evidence.articleId}) AS publications,
               (SELECT count(*)::int FROM deliveries WHERE subject_id = ${evidence.articleId}) AS deliveries`;
      items.push({
        url: item.url, identityKey: mapped.identityKey, rawSha256: item.rawSha256,
        articleId: evidence.articleId, articleRevision: evidence.articleRevision,
        evidenceVersion: evidence.evidenceVersion, evidenceHash: evidence.evidenceHash, gaps: evidence.gaps,
        completeness: complete ? "body_present" : "missing_body", judgment, scored: false, valueJudgment: false,
        publicationRows: projection!.publications, deliveryRows: projection!.deliveries,
      });
    } catch (error) {
      counts.rejected += 1;
      items.push({ url: item.url, rawSha256: item.rawSha256, error: error instanceof Error ? error.message : String(error), scored: false, valueJudgment: false });
    }
  }
  console.log(JSON.stringify({
    ok: counts.rejected === 0, dryRun, workerStarted: false, entry: "cli", counts, items,
    outboundIfWorker: gate.outboundIfWorker, localDeleteIfWorker: gate.localDeleteIfWorker,
  }));
  if (counts.rejected) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await closeDb();
}
