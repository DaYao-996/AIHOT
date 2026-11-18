// One plain GET for each of the 15 detail targets. Saves response bytes. No Jina, no model.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { closeDb, sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
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
    const codex = item.sourceId === "openai_codex_github_releases";
    const html = page.status === 200 && !codex ? page.body.toString("utf8") : null;
    const prose = html && !item.url.includes("#") && !codex
      ? readableDocument(contentDocument(html), item.url)?.text ?? null : null;
    const gate = classifyFetched({
      title: row?.title ?? item.url, url: item.url, httpStatus: page.status, html,
      atomXml: codex && atom.status === 200 ? atom.body.toString("utf8") : null,
      feedExcerpt: row?.excerpt ?? null,
      prose,
    });
    let evidence = null;
    if (row) {
      evidence = await appendControlledEvidence({
        sourceId: item.sourceId, url: item.url, title: row.title,
        raw: row.raw && typeof row.raw === "object" ? row.raw : { guid: null },
        rawFileBase64: page.body.toString("base64"), rawFileSha256: sha256(page.body),
        bodyText: gate.queue === "ready_for_features" ? gate.sectionText ?? null : null,
      });
      await recordBodyGate(row.id, gate);
    }
    const pageSha = codex ? sha256(atom.body) : gate.pageSha256;
    const feature = gate.sectionText && gate.sectionSha256 && pageSha
      ? actualSectionRecord({
        url: item.url, title: row?.title ?? item.url, completeness: gate.completeness ?? "ambiguous",
        sectionText: gate.sectionText, pageSha256: pageSha, sectionSha256: gate.sectionSha256,
      }) : null;
    const fragment = item.url.includes("#") ? decodeURIComponent(item.url.slice(item.url.indexOf("#") + 1)) : null;
    const input = {
      url: item.url, finalUrl: page.finalUrl, fragment, fetchedAt: previous?.fetchedAt ?? page.fetchedAt,
      httpStatus: page.status, rawSha256: sha256(page.body), byteLength: page.body.length,
      source: gate.reason, start: gate.start, end: gate.end,
      sectionByteSource: item.url.includes("github.com") ? "shared-atom" : item.url.includes("overview#") ? "shared-overview" : "detail-response",
    };
    const output = {
      schema: "mechanical-section-v1",
      extraction: feature ? "mechanical_slice" : null,
      completeness: gate.completeness, queue: gate.queue, fact: gate.fact, reason: gate.reason,
      sectionText: gate.sectionText, sectionSha256: gate.sectionSha256, headingsInReason: gate.reason,
      feature,
    };
    items.push({
      url: item.url, sourceId: item.sourceId, httpStatus: page.status, finalUrl: page.finalUrl,
      fetchedAt: input.fetchedAt, fragment, contentType: page.contentType, byteLength: page.body.length,
      rawSha256: input.rawSha256, completeness: gate.completeness, reason: gate.reason, queue: gate.queue, fact: gate.fact,
      source: gate.reason, start: gate.start, end: gate.end, sectionText: gate.sectionText,
      sectionSha256: gate.sectionSha256, evidenceHash: evidence?.evidenceHash ?? null,
      evidenceVersion: evidence?.evidenceVersion ?? null, articleRevision: evidence?.articleRevision ?? null,
      input, output, inputSha256: sha256(stableJson(input)), outputSha256: sha256(stableJson(output)),
      feature, bytes: page.body,
    });
  }
  const queue = await listFeatureQueue();
  const pack = "/tmp/own-evidence-v12";
  rmSync(pack, { recursive: true, force: true });
  mkdirSync(`${pack}/shared`, { recursive: true });
  writeFileSync(`${pack}/shared/overview.bin`, overview.body);
  writeFileSync(`${pack}/shared/atom.bin`, atom.body);
  const publicItems = items.map((item, index) => {
    const dir = `${pack}/items/${String(index + 1).padStart(2, "0")}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/response.bin`, item.bytes);
    if (item.sectionText) writeFileSync(`${dir}/section.txt`, item.sectionText);
    const feature = {
      schema: "mechanical-section-v1",
      extraction: item.feature ? "mechanical_slice" : null,
      note: item.feature ? "first and last sentence only; not a semantic claim" : "no section was stored as a feature",
      input: item.input,
      output: item.output,
      inputSha256: item.inputSha256,
      outputSha256: item.outputSha256,
    };
    writeFileSync(`${dir}/feature.json`, JSON.stringify(feature, null, 2));
    const { bytes, ...rest } = item;
    return rest;
  });
  const report = {
    generated_at: new Date().toISOString(), paid: false, refetch: false, bypass403: false,
    checkedMeans: "checked is a human claim against a stored excerpt, not an automatic proof",
    overview: { status: overview.status, finalUrl: overview.finalUrl, sha256: sha256(overview.body), bytes: overview.body.length },
    atom: { status: atom.status, finalUrl: atom.finalUrl, sha256: sha256(atom.body), bytes: atom.body.length },
    openaiFeed: saved?.openaiFeed ?? { status: openaiFeed.status, sha256: sha256(openaiFeed.body) },
    ready: queue.length,
    counts: publicItems.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.completeness ?? "none"]: (acc[item.completeness ?? "none"] ?? 0) + 1 }), {}),
    items: publicItems,
  };
  writeFileSync(`${pack}/INDEX.json`, JSON.stringify(report, null, 2));
  writeFileSync("docs/own-pipeline/DETAIL_EVIDENCE_v12.json", JSON.stringify(report, null, 2));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "HASHES.txt") files.push(path);
    }
  };
  walk(pack);
  const hashes = files.sort().map((file) => `${sha256(readFileSync(file))}  ${file.slice(pack.length + 1)}`).join("\n") + "\n";
  writeFileSync(`${pack}/HASHES.txt`, hashes);
  const packed = spawnSync("tar", ["-czf", "/tmp/own-pipeline-evidence-v12.tar.gz", "-C", "/tmp", "own-evidence-v12"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
  console.log(JSON.stringify({ ready: queue.length, counts: report.counts, pack: "/tmp/own-pipeline-evidence-v12.tar.gz" }));
}

try { await main(); } finally { await closeDb(); }
