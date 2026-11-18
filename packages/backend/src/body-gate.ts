// Body attribution before feature extraction. A long page is not each item's text.
import { sha256 } from "./lib/ids.ts";

export type FetchState = "feed_stored" | "detail_forbidden" | "detail_not_stored";
export type BodyState = "attributed" | "summary_only" | "missing" | "ambiguous" | "not_stored";
export type FactState = "unchecked";

export interface BodyGate {
  fetch: FetchState;
  body: BodyState;
  fact: FactState;
  queue: "ready_for_features" | "held";
  reason: string;
  fragment: string | null;
  title: string;
  dateLabel: string | null;
  pageSha256: string | null;
  sectionSha256: string | null;
  start: number | null;
  end: number | null;
  sectionText: string | null;
}

interface Heading {
  level: number;
  id: string | null;
  text: string;
  start: number;
  contentFrom: number;
}

function plain(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function norm(value: string): string {
  return plain(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function headings(html: string): Heading[] {
  const out: Heading[] = [];
  const re = /<h([1-3])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[2] ?? "";
    const id = /(?:^|\s)id\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
    const index = match.index ?? 0;
    out.push({ level: Number(match[1]), id, text: plain(match[3] ?? ""), start: index, contentFrom: index + match[0].length });
  }
  return out;
}

function sectionSpan(html: string, heading: Heading, all: Heading[]): { start: number; end: number; text: string } {
  const next = all.find((item) => item.start > heading.start && item.level <= heading.level);
  const end = next ? next.start : html.length;
  const text = plain(html.slice(heading.contentFrom, end));
  return { start: heading.contentFrom, end, text };
}

/** Cut one update out of a stored page. The whole page is never returned as the section. */
export function cutHtmlSection(html: string, opts: { fragment?: string | null; title: string; dateLabel?: string | null }): Omit<BodyGate, "fetch" | "queue" | "fact"> & { fact: FactState } {
  const pageSha256 = sha256(html);
  const fragment = opts.fragment ? decodeURIComponent(opts.fragment) : null;
  const found = headings(html);
  const byFragment = fragment ? found.filter((item) => item.id === fragment) : [];
  const titleKey = norm(opts.title);
  const byTitle = found.filter((item) => titleKey && (norm(item.text) === titleKey || norm(item.text).includes(titleKey)));
  const base = { fragment, title: opts.title, dateLabel: opts.dateLabel ?? null, pageSha256, fact: "unchecked" as const };
  const empty = { ...base, sectionText: null, sectionSha256: null, start: null, end: null };
  if (!html.trim() || found.length === 0) return { ...empty, body: "missing", reason: "stored page has no headings" };
  if (byFragment.length > 1) return { ...empty, body: "ambiguous", reason: "fragment matches more than one heading" };
  if (byFragment.length === 1 && byTitle.length > 0 && !byTitle.some((item) => item.start === byFragment[0]!.start)) {
    return { ...empty, body: "ambiguous", reason: "fragment and title point at different headings" };
  }
  if (byFragment.length === 0 && byTitle.length > 1) return { ...empty, body: "ambiguous", reason: "title matches more than one heading" };
  const heading = byFragment[0] ?? (byTitle.length === 1 ? byTitle[0] : null);
  if (!heading) return { ...empty, body: "missing", reason: "no heading matches the fragment or the title" };
  const cut = sectionSpan(html, heading, found);
  const pageText = plain(html);
  if (found.length > 1 && cut.text.length > pageText.length * 0.85) {
    return { ...empty, body: "ambiguous", reason: "section is almost the whole page" };
  }
  if (opts.dateLabel && !cut.text.includes(opts.dateLabel) && !heading.text.includes(opts.dateLabel)) {
    return { ...empty, body: "ambiguous", reason: "date is not inside the matched section" };
  }
  if (titleKey && !norm(heading.text).includes(titleKey) && !norm(cut.text).includes(titleKey)) {
    return { ...empty, body: "ambiguous", reason: "title is not inside the matched section" };
  }
  return {
    ...base,
    body: "attributed",
    reason: "one heading matches and the following section stops before the next heading",
    sectionText: cut.text,
    sectionSha256: sha256(cut.text),
    start: cut.start,
    end: cut.end,
  };
}

/** Official Atom content is the release note when it is present. A short page scrape does not prove truncation. */
export function atomReleaseNote(xml: string, title: string): { body: BodyState; text: string | null; updated: string | null; reason: string } {
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const hits = entries.filter((entry) => plain(entry).includes(title));
  if (hits.length === 0) return { body: "missing", text: null, updated: null, reason: "atom entry for this title is not in the stored feed" };
  if (hits.length > 1) return { body: "ambiguous", text: null, updated: null, reason: "more than one atom entry contains this title" };
  const entry = hits[0]!;
  const updated = /<updated>([^<]*)<\/updated>/i.exec(entry)?.[1] ?? null;
  const content = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(entry)?.[1] ?? "";
  const text = plain(content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1"));
  if (!text) return { body: "missing", text: null, updated, reason: "atom content is empty; a short detail page is not evidence of truncation" };
  return { body: "attributed", text, updated, reason: "atom content element is the release note" };
}

export interface StoredSample {
  url: string;
  title: string;
  publishedAt: string | null;
  excerpt: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  detailHtml: string | null;
  feedXml: string | null;
  detailHttpStatus: number | null;
}

/** What can be said from material already stored. Fact stays unchecked. */
export function gateStoredSample(sample: StoredSample): BodyGate {
  const fragment = sample.url.includes("#") ? sample.url.slice(sample.url.indexOf("#") + 1) : null;
  const dateLabel = sample.publishedAt ? sample.publishedAt.slice(0, 10) : null;
  if (sample.detailHttpStatus === 403 || sample.detailHttpStatus === 401) {
    return {
      fetch: "detail_forbidden", body: sample.excerpt ? "summary_only" : "missing", fact: "unchecked", queue: "held",
      reason: sample.excerpt ? "detail is forbidden; the feed excerpt is a summary and is not the body" : "detail is forbidden and the feed has no body",
      fragment, title: sample.title, dateLabel, pageSha256: null, sectionSha256: null, start: null, end: null, sectionText: null,
    };
  }
  if (sample.feedXml && sample.url.includes("github.com") && sample.url.includes("/releases/")) {
    const note = atomReleaseNote(sample.feedXml, sample.title);
    const ready = note.body === "attributed" && !!note.text;
    return {
      fetch: "feed_stored", body: note.body, fact: "unchecked", queue: ready ? "ready_for_features" : "held",
      reason: note.reason, fragment, title: sample.title, dateLabel: note.updated ?? dateLabel,
      pageSha256: sha256(sample.feedXml), sectionSha256: note.text ? sha256(note.text) : null,
      start: null, end: null, sectionText: ready ? note.text : null,
    };
  }
  if (!sample.detailHtml && !sample.bodyHtml) {
    return {
      fetch: "detail_not_stored", body: sample.excerpt ? "summary_only" : "not_stored", fact: "unchecked", queue: "held",
      reason: sample.excerpt
        ? "detail HTML was not retained; the feed excerpt stays a summary"
        : "detail HTML and feed body were not retained, so length from the earlier probe is not a body",
      fragment, title: sample.title, dateLabel, pageSha256: null, sectionSha256: null, start: null, end: null, sectionText: null,
    };
  }
  const html = sample.detailHtml ?? sample.bodyHtml ?? "";
  const cut = cutHtmlSection(html, { fragment, title: sample.title, dateLabel });
  return { fetch: "feed_stored", queue: cut.body === "attributed" ? "ready_for_features" : "held", ...cut };
}

const BANNED_OUTPUT = /"expected"|"prioritize"|"verify"|"exclude"|"automatic_route"/;

/** A file of model output. No network. Scores and route labels are rejected. */
export function parseModelOutputFile(value: unknown): { ok: true; items: ModelFileItem[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "file must be a non-empty array" };
  const items: ModelFileItem[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return { ok: false, error: "each item must be an object" };
    const item = row as Record<string, unknown>;
    for (const key of ["articleId", "evidenceHash", "promptVersion", "modelVersion", "inputHash"]) {
      if (typeof item[key] !== "string" || !item[key]) return { ok: false, error: `${key} is required` };
    }
    if (!item.output || typeof item.output !== "object") return { ok: false, error: "output object is required" };
    const encoded = JSON.stringify(item.output);
    if (BANNED_OUTPUT.test(encoded)) return { ok: false, error: "output contains a route or score label" };
    const human = (item.output as { human_verification?: { status?: string } }).human_verification?.status;
    if (human && human !== "unverified") return { ok: false, error: "model file cannot set human verification" };
    const cost = item.costUsd;
    if (cost !== null && cost !== undefined && typeof cost !== "number") return { ok: false, error: "costUsd must be a number or null" };
    items.push({
      articleId: item.articleId as string,
      evidenceHash: item.evidenceHash as string,
      promptVersion: item.promptVersion as string,
      modelVersion: item.modelVersion as string,
      inputHash: item.inputHash as string,
      output: item.output,
      costUsd: typeof cost === "number" ? cost : null,
    });
  }
  return { ok: true, items };
}

export interface ModelFileItem {
  articleId: string;
  evidenceHash: string;
  promptVersion: string;
  modelVersion: string;
  inputHash: string;
  output: unknown;
  costUsd: number | null;
}
