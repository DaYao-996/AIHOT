// One plain GET for each of the 15 detail targets. Saves response bytes. No Jina, no model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { classifyFetched } from "@aihot/backend/body-gate";
import { readableDocument } from "@aihot/backend/content/extract";
import { contentDocument } from "@aihot/backend/lib/page-content";
import { actualSectionRecord } from "@aihot/backend/file-extract";
import { appendControlledEvidence, listFeatureQueue, recordBodyGate } from "@aihot/backend/own-pipeline-store";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

const ITEMS = [
  { sourceId: "openai_news", url: "https://openai.com/index/introducing-gpt-6-2-astra-sol" },
  { sourceId: "openai_news", url: "https://openai.com/index/strengthening-nato-allied-cyber-defences-ai" },
  { sourceId: "openai_news", url: "https://openai.com/index/introducing-chatgpt-for-sales" },
  { sourceId: "google_ai_blog", url: "https://blog.google/innovation-and-ai/products/gemini-app/tasks-in-gemini-free-new-features/" },
  { sourceId: "google_ai_blog", url: "https://blog.google/products-and-platforms/products/maps/ask-maps-holiday-travel-features-2026/" },
  { sourceId: "google_ai_blog", url: "https://blog.google/products-and-platforms/products/search/gemini-4-hydrogen-search-upgrade/" },
  { sourceId: "huggingface_blog", url: "https://huggingface.co/blog/openrouter" },
  { sourceId: "huggingface_blog", url: "https://huggingface.co/blog/nvidia/simready-assets-robot-pick-and-place" },
  { sourceId: "huggingface_blog", url: "https://huggingface.co/blog/allenai/xybench" },
  { sourceId: "claude_platform_release_notes", url: "https://platform.claude.com/docs/en/release-notes/overview#linked-billing" },
  { sourceId: "claude_platform_release_notes", url: "https://platform.claude.com/docs/en/release-notes/overview#text-watermark-claude-opus-4-6-and-4-5-models" },
  { sourceId: "claude_platform_release_notes", url: "https://platform.claude.com/docs/en/release-notes/overview#self-hosted-managed-agents" },
  { sourceId: "openai_codex_github_releases", url: "https://github.com/openai/codex/releases/tag/rust-v0.171.0-alpha.13" },
  { sourceId: "openai_codex_github_releases", url: "https://github.com/openai/codex/releases/tag/rust-v0.170.0-alpha.4.2" },
  { sourceId: "openai_codex_github_releases", url: "https://github.com/openai/codex/releases/tag/rust-v0.171.0-alpha.12" },
];

async function get(url: string) {
  const started = new Date().toISOString();
  const res = await guardedFetch(url, { timeoutMs: 25_000 });
  return { status: res.status, finalUrl: res.url, fetchedAt: started, body: res.body, contentType: res.headers.get("content-type") };
}

async function main() {
  assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
  if (process.env.MODEL_CALLS_ENABLED === "true") throw new Error("模型开关开着");
  mkdirSync("/tmp/detail-bytes", { recursive: true });
  const saved = process.argv.includes("--saved") ? JSON.parse(readFileSync("docs/own-pipeline/DETAIL_REFETCH_v11.json", "utf8")) : null;
  const load = (sha: string) => readFileSync(`/tmp/detail-bytes/${sha}.bin`);
  const overview = saved
    ? { status: saved.overview.status, finalUrl: saved.overview.finalUrl, fetchedAt: saved.generated_at, body: load(saved.overview.sha256), contentType: "text/html" }
    : await get("https://platform.claude.com/docs/en/release-notes/overview");
  writeFileSync(`/tmp/detail-bytes/${sha256(overview.body)}.bin`, overview.body);
  const atom = saved
    ? { status: saved.atom.status, finalUrl: saved.atom.finalUrl, fetchedAt: saved.generated_at, body: load(saved.atom.sha256), contentType: "application/atom+xml" }
    : await get("https://github.com/openai/codex/releases.atom");
  writeFileSync(`/tmp/detail-bytes/${sha256(atom.body)}.bin`, atom.body);
  const openaiFeed = saved ? { status: saved.openaiFeed.status, body: Buffer.from(""), url: "", fetchedAt: saved.generated_at, contentType: null } : await get("https://openai.com/news/rss.xml");
  const items = [];
  for (const item of ITEMS) {
    const row = (await sql<{ id: string; title: string; excerpt: string | null; raw: unknown }[]>`
      SELECT id, title, excerpt, raw FROM articles WHERE source_id = ${item.sourceId} AND url = ${item.url}`)[0];
    const previous = saved?.items?.find((row: { url: string }) => row.url === item.url);
    const page = item.url.startsWith("https://platform.claude.com/docs/en/release-notes/overview#")
      ? overview
      : saved && previous?.rawSha256
        ? { status: previous.httpStatus, finalUrl: previous.finalUrl, fetchedAt: previous.fetchedAt, body: load(previous.rawSha256), contentType: previous.contentType }
        : await get(item.url.split("#")[0]);
    if (!item.url.includes("#")) writeFileSync(`/tmp/detail-bytes/${sha256(page.body)}.bin`, page.body);
    const html = page.status === 200 ? page.body.toString("utf8") : null;
    const prose = html && !item.url.includes("#") && item.sourceId !== "openai_codex_github_releases"
      ? readableDocument(contentDocument(html), item.url)?.text ?? null : null;
    const gate = classifyFetched({
      title: row?.title ?? item.url, url: item.url, httpStatus: page.status, html,
      atomXml: item.sourceId === "openai_codex_github_releases" && atom.status === 200 ? atom.body.toString("utf8") : null,
      feedExcerpt: row?.excerpt ?? null,
      prose,
    });
    let evidence = null;
    if (row) {
      evidence = await appendControlledEvidence({
        sourceId: item.sourceId, url: item.url, title: row.title,
        raw: row.raw && typeof row.raw === "object" ? row.raw : { guid: null },
        rawFileBase64: page.body.toString("base64"), rawFileSha256: sha256(page.body),
        ...(gate.sectionText && gate.queue === "ready_for_features" ? { bodyText: gate.sectionText } : {}),
      });
      await recordBodyGate(row.id, gate);
    }
    const feature = gate.sectionText && gate.sectionSha256 && gate.pageSha256
      ? actualSectionRecord({
        url: item.url, title: row?.title ?? item.url, completeness: gate.completeness ?? "ambiguous",
        sectionText: gate.sectionText, pageSha256: gate.pageSha256, sectionSha256: gate.sectionSha256,
      }) : null;
    items.push({
      url: item.url, sourceId: item.sourceId, httpStatus: page.status, finalUrl: page.finalUrl, fetchedAt: page.fetchedAt,
      contentType: page.contentType, byteLength: page.body.length, rawSha256: sha256(page.body),
      completeness: gate.completeness, reason: gate.reason, queue: gate.queue, fact: gate.fact,
      sectionSha256: gate.sectionSha256, tail: gate.sectionText?.slice(-80) ?? null,
      evidenceHash: evidence?.evidenceHash ?? null,
      feature,
    });
  }
  const queue = await listFeatureQueue();
  const report = {
    generated_at: new Date().toISOString(), paid: false, bypass403: false,
    overview: { status: overview.status, finalUrl: overview.finalUrl, sha256: sha256(overview.body), bytes: overview.body.length },
    atom: { status: atom.status, finalUrl: atom.finalUrl, sha256: sha256(atom.body), bytes: atom.body.length },
    openaiFeed: saved?.openaiFeed ?? { status: openaiFeed.status, sha256: sha256(openaiFeed.body) },
    ready: queue.length, items,
  };
  writeFileSync("docs/own-pipeline/DETAIL_REFETCH_v11.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ready: queue.length, counts: items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.completeness ?? "none"]: (acc[item.completeness ?? "none"] ?? 0) + 1 }), {}) }));
}

try { await main(); } finally { await closeDb(); }
