// One-shot import. No worker, no model, no scoring, no queueProcessing.
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { appendControlledEvidence } from "@aihot/backend/own-pipeline-store";
import {
  ImportRejected,
  assertThrowawayDatabase,
  cliEntryAllowed,
  mapControlledImport,
  parseImportDocument,
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
    const completeness = !mapped.bodyText ? "missing_body" : mapped.quotedText ? "body_and_quote_unverified" : "missing_quote";
    if (dryRun) {
      items.push({
        url: item.url, identityKey: mapped.identityKey, rawFileSha256: item.rawFileSha256, rawCanonicalSha256: item.rawCanonicalSha256, gaps: mapped.gaps,
        completeness, quality: "unverified", judgment: "dry_run", scored: false, valueJudgment: false,
      });
      continue;
    }
    try {
      const evidence = await appendControlledEvidence(item);
      if (evidence.idempotent) counts.idempotent += 1;
      else counts.evidenceAppended += 1;
      if (!mapped.bodyText || !mapped.quotedText) counts.judgmentSkippedIncomplete += 1;
      const judgment = "not_written";
      const [projection] = await sql<{ publications: number; deliveries: number }[]>`
        SELECT (SELECT count(*)::int FROM publications WHERE article_id = ${evidence.articleId}) AS publications,
               (SELECT count(*)::int FROM deliveries WHERE subject_id = ${evidence.articleId}) AS deliveries`;
      items.push({
        url: item.url, identityKey: mapped.identityKey, rawFileSha256: item.rawFileSha256, rawCanonicalSha256: item.rawCanonicalSha256,
        articleId: evidence.articleId, articleRevision: evidence.articleRevision,
        evidenceVersion: evidence.evidenceVersion, evidenceHash: evidence.evidenceHash, gaps: evidence.gaps,
        completeness, quality: "unverified", judgment, scored: false, valueJudgment: false,
        publicationRows: projection!.publications, deliveryRows: projection!.deliveries,
      });
    } catch (error) {
      counts.rejected += 1;
      items.push({ url: item.url, rawFileSha256: item.rawFileSha256, rawCanonicalSha256: item.rawCanonicalSha256, error: error instanceof Error ? error.message : String(error), scored: false, valueJudgment: false });
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
