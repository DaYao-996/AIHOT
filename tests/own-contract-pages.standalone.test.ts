// The frozen page config matches the saved official HTML. It does not fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fromHtml } from "@aihot/backend/sources/web-list";

const config = JSON.parse(readFileSync("docs/own-pipeline/contract-run-v14/CONFIG.json", "utf8")) as {
  connect: Array<{ sourceId: string; config?: Record<string, unknown> }>;
};
function items(id: string) {
  const source = config.connect.find((row) => row.sourceId === id)!;
  const html = readFileSync(`docs/own-pipeline/contract-run-v14/inputs/probe/${id}.bin`, "utf8");
  return fromHtml(html, String(source.config!.url), { id, config: source.config!, uses: [] } as never);
}

test("saved official pages keep title and url together", () => {
  const machines = items("thinking_machines_news");
  assert.ok(machines.length >= 4);
  assert.equal(machines[0]!.url, "https://thinkingmachines.ai/news/inkling-2-small/");
  assert.match(machines[0]!.title, /Inkling 2 Small/);
  assert.ok(machines[0]!.publishedAt);
  const meta = items("meta_research_blog");
  assert.ok(meta.length >= 4);
  assert.ok(meta.every((item) => item.url.includes("/blog/") && item.title.length > 8 && item.publishedAt));
  const nvidia = items("nvidia_newsroom_page");
  assert.equal(nvidia.length, 3);
  assert.ok(nvidia.every((item) => item.url.startsWith("https://nvidianews.nvidia.com/news/") && item.title.length > 8));
  const anthropic = items("anthropic_news_page");
  assert.ok(anthropic.length >= 6);
  assert.ok(anthropic.every((item) => item.title.length > 8 && item.url.startsWith("https://www.anthropic.com/")));
});
