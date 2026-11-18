// Gate the 15 already-stored detail samples. Does not fetch. Does not score.
import { writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { gateStoredSample } from "@aihot/backend/body-gate";
import { listFeatureQueue, recordBodyGate } from "@aihot/backend/own-pipeline-store";
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

const detailStatus: Record<string, number> = {
  "https://openai.com/index/introducing-gpt-6-2-astra-sol": 403,
  "https://openai.com/index/strengthening-nato-allied-cyber-defences-ai": 403,
  "https://openai.com/index/introducing-chatgpt-for-sales": 403,
};

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  const rows = await sql<{ id: string; url: string; title: string; published_at: Date | null; excerpt: string | null; body_text: string | null; body_html: string | null }[]>`
    SELECT id, url, title, published_at, excerpt, body_text, body_html FROM articles WHERE url IN ${sql(URLS)}`;
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  const items = [];
  for (const url of URLS) {
    const row = byUrl.get(url);
    if (!row) {
      items.push({ url, fetch: "detail_not_stored", body: "missing", fact: "unchecked", queue: "held", reason: "article row is not in this database" });
      continue;
    }
    const gate = gateStoredSample({
      url, title: row.title, publishedAt: row.published_at?.toISOString() ?? null,
      excerpt: row.excerpt, bodyText: row.body_text, bodyHtml: row.body_html,
      detailHtml: null, feedXml: null, detailHttpStatus: detailStatus[url] ?? 200,
    });
    const recorded = await recordBodyGate(row.id, gate);
    items.push({ url, articleId: row.id, evidenceVersion: recorded.version, ...gate, sectionText: undefined });
  }
  const queue = await listFeatureQueue();
  const report = {
    generated_at: new Date().toISOString(),
    samples: items.length,
    ready: queue.length,
    fact: "unchecked",
    scored: false,
    note: "Detail HTML from the earlier probe was not stored, so these 15 cannot be cut into sections. Feed excerpts stay summaries. OpenAI 403 is unchanged.",
    items, queue,
  };
  writeFileSync("docs/own-pipeline/BODY_GATE_v10.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ samples: items.length, ready: queue.length, held: items.filter((item) => item.queue === "held").length }));
}

try {
  await main();
} finally {
  await closeDb();
}
