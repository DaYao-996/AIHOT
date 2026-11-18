// Export this isolated 15-article sample. Not a production dump and not a source-code archive.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const URLS = [
  "https://openai.com/index/introducing-gpt-6-2-astra-sol",
  "https://openai.com/index/strengthening-nato-allied-cyber-defences-ai",
  "https://openai.com/index/introducing-chatgpt-for-sales",
  "https://blog.google/innovation-and-ai/products/gemini-app/tasks-in-gemini-free-new-features/",
  "https://blog.google/products-and-platforms/products/maps/ask-maps-holiday-travel-features-2026/",
  "https://blog.google/products-and-platforms/products/search/gemini-4-hydrogen-search-upgrade/",
  "https://huggingface.co/blog/openrouter",
  "https://huggingface.co/blog/nvidia/simready-assets-robot-pick-and-place",
  "https://huggingface.co/blog/allenai/xybench",
  "https://platform.claude.com/docs/en/release-notes/overview#linked-billing",
  "https://platform.claude.com/docs/en/release-notes/overview#text-watermark-claude-opus-4-6-and-4-5-models",
  "https://platform.claude.com/docs/en/release-notes/overview#self-hosted-managed-agents",
  "https://github.com/openai/codex/releases/tag/rust-v0.171.0-alpha.13",
  "https://github.com/openai/codex/releases/tag/rust-v0.170.0-alpha.4.2",
  "https://github.com/openai/codex/releases/tag/rust-v0.171.0-alpha.12",
];

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag >= 0 ? process.argv[dirFlag + 1] : "";

async function main() {
  if (!dir) throw new Error("usage: node scripts/own-sample-export.ts --dir <pack>");
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  mkdirSync(`${dir}/bytes`, { recursive: true });
  const articles = await sql`SELECT * FROM articles WHERE url IN ${sql(URLS)} ORDER BY url`;
  if (articles.length !== URLS.length) throw new Error(`expected ${URLS.length} articles, found ${articles.length}`);
  const ids = articles.map((row) => row.id as string);
  const sources = await sql`SELECT id, name, kind, config, tags, tier, participation_mode, interval_minutes, site_fulltext, syndicate_fulltext
    FROM sources WHERE id IN ${sql([...new Set(articles.map((row) => row.source_id as string))])} ORDER BY id`;
  const revisions = await sql`SELECT * FROM article_revisions WHERE article_id IN ${sql(ids)} ORDER BY article_id, revision`;
  const evidence = await sql`SELECT article_id, version, article_revision, raw, body_text, quoted_text, x_post, evidence_hash, created_at,
      raw_identity, body_gate, encode(sha256(raw_file), 'hex') AS raw_file_sha256, octet_length(raw_file) AS raw_file_bytes
    FROM own_evidence_versions WHERE article_id IN ${sql(ids)} ORDER BY article_id, version`;
  const files = await sql<{ sha: string; bytes: Buffer }[]>`
    SELECT DISTINCT encode(sha256(raw_file), 'hex') AS sha, raw_file AS bytes
    FROM own_evidence_versions WHERE article_id IN ${sql(ids)} AND raw_file IS NOT NULL`;
  const judgments = await sql`SELECT * FROM own_judgments WHERE article_id IN ${sql(ids)} ORDER BY article_id, created_at`;
  for (const file of files) writeFileSync(`${dir}/bytes/${file.sha}.bin`, file.bytes);
  const extra = new Set<string>();
  for (const row of evidence) {
    const gate = row.body_gate as { supplements?: { responseSha256?: string }[] } | null;
    for (const item of gate?.supplements ?? []) if (item.responseSha256) extra.add(item.responseSha256);
  }
  const missing = [...extra].filter((sha) => !files.some((file) => file.sha === sha));
  for (const sha of missing) {
    const candidates = [`/tmp/condition-supplement/${sha}.bin`, `/opt/cursor/artifacts/watermark-platforms-response.bin`];
    const found = candidates.find((file) => existsSync(file));
    if (!found) throw new Error(`补料原件不在导出范围里：${sha}`);
    copyFileSync(found, `${dir}/bytes/${sha}.bin`);
    const copied = createHash("sha256").update(readFileSync(`${dir}/bytes/${sha}.bin`)).digest("hex");
    if (copied !== sha) throw new Error(`补料原件哈希不符：${sha}`);
  }
  writeFileSync(`${dir}/sources.json`, JSON.stringify(sources.map((row) => ({ ...row, enabled: false, health: "unknown", fail_count: 0 })), null, 2));
  writeFileSync(`${dir}/articles.json`, JSON.stringify(articles.map((row) => ({ ...row, grouping_receipt_id: null })), null, 2));
  writeFileSync(`${dir}/article_revisions.json`, JSON.stringify(revisions, null, 2));
  writeFileSync(`${dir}/evidence.jsonl`, evidence.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(`${dir}/judgments.json`, JSON.stringify(judgments, null, 2));
  writeFileSync(`${dir}/MANIFEST.json`, JSON.stringify({
    sample: "fifteen-public-details",
    urls: URLS,
    counts: { articles: articles.length, revisions: revisions.length, evidence: evidence.length, judgments: judgments.length, byteFiles: files.length + missing.length },
    supplementBytesStoredSeparately: missing,
    notRecovered: [
      "no pg-boss queue",
      "no receipts, analyses, publications, or deliveries",
      "no credentials or notify targets",
      "pages that were not fetched are not in bytes/",
      "a later semantic re-extraction is not included until a new pack is exported",
    ],
  }, null, 2));
  console.log(JSON.stringify({ dir, articles: articles.length, evidence: evidence.length, judgments: judgments.length, files: files.length + missing.length, supplementBytesStoredSeparately: missing }));
}

try { await main(); } finally { await closeDb(); }
