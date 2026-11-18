// On a copy of the closed-loop database, append one marker to one article through the evidence entry.
import { closeDb, sql } from "@aihot/backend/db";
import { appendControlledEvidence } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const articleId = process.argv[2];
const marker = "技术回归标记。";
if (!articleId) throw new Error("usage: node scripts/own-draft-loop-v9-change.ts <articleId>");

assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
const [article] = await sql<{ source_id: string; url: string; title: string; raw: unknown; body_text: string }[]>`
  SELECT source_id, url, title, raw, body_text FROM articles WHERE id = ${articleId}`;
if (!article?.body_text || article.body_text.includes(marker)) throw new Error("没有可改的正文");
const written = await appendControlledEvidence({
  sourceId: article.source_id,
  url: article.url,
  title: article.title,
  raw: article.raw,
  bodyText: `${article.body_text}${marker}`,
});
const rows = await sql<{ id: string; article_id: string; stale: boolean; kind: string }[]>`
  SELECT id, article_id, stale,
    CASE
      WHEN comparison ? 'reviewDraft' THEN 'draft'
      WHEN comparison ? 'selectionDecision' THEN 'selection'
      WHEN comparison ? 'fileResult' THEN 'semantic'
      ELSE 'other'
    END AS kind
  FROM own_judgments
  WHERE comparison->'reviewDraft'->>'technicalFixture' = 'false'
     OR (article_id = ${articleId} AND (comparison ? 'fileResult' OR comparison ? 'selectionDecision' OR comparison ? 'reviewDraft'))
  ORDER BY article_id, kind`;
console.log(JSON.stringify({ ok: true, written, marker, rows }));
await closeDb();
