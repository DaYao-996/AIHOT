// Body attribution before feature extraction. A long page is not each item's text.
import { sha256 } from "./lib/ids.ts";

export type Completeness = "complete" | "partial" | "blocked" | "ambiguous";
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
  completeness?: Completeness;
}

interface Heading {
  level: number;
  id: string | null;
  text: string;
  start: number;
  contentFrom: number;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function plain(value: string): string {
  return decodeEntities(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function elementSpan(html: string, id: string): { tag: string; contentFrom: number; end: number } | null {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i").exec(html);
  if (!open || open.index === undefined) return null;
  const tag = open[1]!.toLowerCase();
  const contentFrom = open.index + open[0].length;
  const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  token.lastIndex = contentFrom;
  let depth = 1;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return { tag, contentFrom, end: match.index };
  }
  return null;
}

/** From the fragment through later subheadings, stopping before the next update at the same level. */
function fragmentSection(html: string, id: string): { text: string; start: number; end: number; subheadings: string[] } | null {
  const span = elementSpan(html, id);
  if (!span) return null;
  const after = html.slice(span.end);
  let boundary = html.length;
  if (span.tag === "li") {
    const sibling = /<li\b[^>]*\bid=["'][^"']+["'][^>]*>/i.exec(after);
    if (sibling?.index !== undefined) boundary = Math.min(boundary, span.end + sibling.index);
  }
  const heading = /<h[1-3]\b[^>]*>/i.exec(after);
  if (heading?.index !== undefined) boundary = Math.min(boundary, span.end + heading.index);
  const region = html.slice(span.contentFrom, boundary);
  const subheadings = [...region.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => plain(match[2] ?? "")).filter(Boolean);
  const text = plain(region);
  return text ? { text, start: span.contentFrom, end: boundary, subheadings } : null;
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
export function cutHtmlSection(html: string, opts: { fragment?: string | null; title: string; dateLabel?: string | null; article?: boolean }): Omit<BodyGate, "fetch" | "queue" | "fact" | "completeness"> & { fact: FactState } {
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
  if (!opts.article && found.length > 1 && cut.text.length > pageText.length * 0.85) {
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

function releaseKind(title: string): "prerelease" | "stable" {
  return /(?:^|[^a-z0-9])(?:alpha|beta|rc|pre)(?:[^a-z0-9]|$)/i.test(title) ? "prerelease" : "stable";
}

function versionLine(text: string): boolean {
  return /^release\s+\S+$/i.test(text.trim());
}

/** One Atom entry. The release kind comes from that entry's title. Other entries are not joined. */
export function atomReleaseNote(xml: string, title: string): {
  body: BodyState; text: string | null; updated: string | null; reason: string;
  releaseKind: "prerelease" | "stable" | null; start: number | null; end: number | null;
} {
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  const hits = entries.filter((entry) => plain(entry[0]).includes(title));
  if (hits.length === 0) return { body: "missing", text: null, updated: null, reason: "atom entry for this title is not in the stored feed", releaseKind: null, start: null, end: null };
  if (hits.length > 1) return { body: "ambiguous", text: null, updated: null, reason: "more than one atom entry contains this title", releaseKind: null, start: null, end: null };
  const hit = hits[0]!;
  const entry = hit[0];
  const updated = /<updated>([^<]*)<\/updated>/i.exec(entry)?.[1] ?? null;
  const content = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(entry)?.[1] ?? "";
  const text = plain(decodeEntities(content).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1"));
  const kind = releaseKind(title);
  if (!text) return { body: "missing", text: null, updated, reason: "atom content is empty; a short detail page is not evidence of truncation", releaseKind: kind, start: hit.index ?? null, end: hit.index === undefined ? null : hit.index + entry.length };
  const thin = versionLine(text);
  return {
    body: "attributed", text, updated, releaseKind: kind, start: hit.index ?? null, end: hit.index === undefined ? null : hit.index + entry.length,
    reason: thin
      ? `one atom entry; release kind is ${kind}; content is only the version line; other entries were not joined`
      : `one atom entry; release kind is ${kind}; content is that entry's note; other entries were not joined`,
  };
}

const TRUNCATION = /(?:\bread more\b|\bcontinue reading\b|\[\s*(?:…|\.\.\.)\s*\]|…)\s*$/i;

function datePhrase(title: string): string | null {
  return title.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/)?.[0] ?? null;
}

/** Classify a fetched page. Length alone is not completeness. */
const CHROME = [
  /get the latest news from google in your inbox/i,
  /newsletters with product updates/i,
  /your information will be used in accordance/i,
  /\bread more from /i,
];

export function trimChrome(text: string): { text: string; cut: string | null } {
  let at = text.length;
  let cut: string | null = null;
  for (const mark of CHROME) {
    const found = text.search(mark);
    if (found > 200 && found < at) {
      at = found;
      cut = mark.source;
    }
  }
  return { text: text.slice(0, at).trim(), cut };
}

export function classifyProse(title: string, text: string): { completeness: Completeness; reason: string; text: string } {
  if (/document\.head|<\/script>|\bfunction\s*\(/.test(text)) return { completeness: "ambiguous", reason: "main text still contains page script", text };
  const trimmed = trimChrome(text);
  const body = trimmed.text;
  const words = norm(title).split(" ").filter((word) => word.length > 3);
  const have = words.filter((word) => norm(body).includes(word)).length;
  if (words.length > 0 && have < Math.min(2, words.length)) return { completeness: "ambiguous", reason: "main text does not contain the title", text: body };
  if (TRUNCATION.test(body) || !/[.!?。]"?$/.test(body)) {
    return { completeness: "partial", reason: trimmed.cut ? `footer removed at ${trimmed.cut}; the remaining tail is not a sentence` : "main text does not end at a sentence boundary", text: body };
  }
  return {
    completeness: "complete",
    reason: trimmed.cut ? `title is in the article; a site footer was removed at ${trimmed.cut}` : "the title is in the main text and the tail is a sentence",
    text: body,
  };
}

export interface DomSlice {
  text: string;
  headings: string[];
  missing: string[];
  start: number;
  end: number | null;
  source: string;
  gap: string | null;
}

/** Footnotes in the same response as the article. The body citation and the note stay separate. */
export function samePageFootnotes(html: string): Array<{
  n: number;
  citationByte: number;
  noteByte: number;
  noteEndByte: number;
  text: string;
}> {
  const notes = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid=["']footnote-(\d+)["'][^>]*>/gi)) {
    const n = Number(match[2]);
    const tag = match[1]!.toLowerCase();
    const openAt = match.index ?? 0;
    const contentFrom = openAt + match[0].length;
    const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    token.lastIndex = contentFrom;
    let depth = 1;
    let end = -1;
    for (let next = token.exec(html); next; next = token.exec(html)) {
      depth += next[1] === "/" ? -1 : 1;
      if (depth === 0) { end = next.index + next[0].length; break; }
    }
    if (end < 0) continue;
    const cite = html.search(new RegExp(`id=["']footnote-source-${n}["']`, "i"));
    const text = plain(html.slice(openAt, end));
    if (!text) continue;
    notes.push({
      n,
      citationByte: cite < 0 ? -1 : utf8ByteOffset(html, cite),
      noteByte: utf8ByteOffset(html, openAt),
      noteEndByte: utf8ByteOffset(html, end),
      text,
    });
  }
  return notes.sort((a, b) => a.n - b.n);
}

/** UTF-16 index in the HTML string, as a byte offset into that string's UTF-8 bytes. */
export function utf8ByteOffset(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, Math.max(0, index)));
}

function byteSpan(text: string, start: number | null, end: number | null): { start: number | null; end: number | null } {
  if (start === null) return { start, end };
  return { start: utf8ByteOffset(text, start), end: end === null ? null : utf8ByteOffset(text, end) };
}

function headingAt(html: string, label: string): number {
  for (const match of html.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    if (plain(match[2] ?? "") === label && match.index !== undefined) return match.index;
  }
  return -1;
}

function googleSlice(html: string): DomSlice {
  const marker = html.indexOf("uni-article-body");
  const from = html.indexOf(">", marker) + 1;
  const rest = html.slice(from);
  let rel = -1;
  for (const match of rest.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)) {
    if (/^(?:get the latest news from google|about the author|related stories)\b/i.test(plain(match[1] ?? "")) && match.index !== undefined) {
      rel = match.index;
      break;
    }
  }
  if (rel < 0) {
    return { text: "", headings: [], missing: [], start: from, end: null, source: "uni-article-body", gap: "uni-article-body has no following chrome heading" };
  }
  const slice = rest.slice(0, rel);
  const headings = [...slice.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((match) => plain(match[1] ?? "")).filter((text) => text && !/explore other styles/i.test(text));
  const text = plain(slice);
  const missing = headings.filter((heading) => !text.includes(heading));
  const gap = text.startsWith("Skip to main content") ? "slice still starts at site navigation" : missing.length ? `missing heading: ${missing.join(" | ")}` : null;
  return { text, headings, missing, start: from, end: from + rel, source: "uni-article-body until the next chrome h2", gap };
}

function outlineLabels(html: string): string[] | null {
  const raw = /data-target="SideNavigation" data-props="([^"]+)"/.exec(html)?.[1];
  if (!raw) return null;
  try {
    const props = JSON.parse(raw.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as { titleTree?: { label?: string; children?: unknown[] }[] };
    const labels: string[] = [];
    const walk = (nodes: { label?: string; children?: unknown[] }[] | undefined) => {
      for (const node of nodes ?? []) {
        if (node.label) labels.push(node.label);
        walk(node.children as { label?: string; children?: unknown[] }[] | undefined);
      }
    };
    walk(props.titleTree);
    return labels;
  } catch {
    return null;
  }
}

function hfSlice(html: string): DomSlice {
  const labels = outlineLabels(html) ?? [];
  if (labels.length === 0) {
    return { text: "", headings: [], missing: [], start: 0, end: null, source: "titleTree", gap: "side navigation outline could not be read" };
  }
  const firstAt = headingAt(html, labels[0]!);
  if (firstAt < 0) {
    return { text: "", headings: labels, missing: [labels[0]!], start: 0, end: null, source: "titleTree", gap: `outline heading is not in the page: ${labels[0]}` };
  }
  const navEnd = html.lastIndexOf("</nav>", firstAt);
  const afterNav = navEnd >= 0 ? navEnd + "</nav>".length : Math.max(0, firstAt - 4000);
  const paragraph = html.slice(afterNav, firstAt).search(/<p\b/i);
  const start = paragraph >= 0 ? afterNav + paragraph : firstAt;
  const lastAt = headingAt(html, labels[labels.length - 1]!);
  const lastClose = lastAt >= 0 ? html.slice(lastAt).search(/<\/h[1-4]>/i) : -1;
  const after = lastAt >= 0 && lastClose >= 0 ? lastAt + lastClose : firstAt;
  let end = -1;
  const headings = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  headings.lastIndex = after;
  for (let match = headings.exec(html); match; match = headings.exec(html)) {
    if (!labels.includes(plain(match[1] ?? "")) && match.index !== undefined) {
      end = match.index;
      break;
    }
  }
  if (end < 0) {
    return { text: "", headings: labels, missing: labels, start, end: null, source: "titleTree", gap: "no heading after the outline marks the end of the post" };
  }
  const text = plain(html.slice(start, end));
  let cursor = 0;
  const missing = labels.filter((label) => {
    const at = text.indexOf(label, cursor);
    if (at < 0) return true;
    cursor = at + label.length;
    return false;
  });
  return {
    text, headings: labels, missing, start, end, source: "lede through the titleTree, stopping before the next heading outside it",
    gap: missing.length ? `missing heading: ${missing.join(" | ")}` : null,
  };
}

/** Article region taken from the saved DOM. Null when this page has neither marker. */
export function domArticle(html: string): DomSlice | null {
  if (html.includes("uni-article-body")) return googleSlice(html);
  if (html.includes('data-target="SideNavigation"')) return hfSlice(html);
  return null;
}

export function classifyFetched(input: {
  title: string;
  url: string;
  httpStatus: number;
  html: string | null;
  atomXml?: string | null;
  feedExcerpt?: string | null;
  prose?: string | null;
}): BodyGate {
  const fragment = input.url.includes("#") ? decodeURIComponent(input.url.slice(input.url.indexOf("#") + 1)) : null;
  const pageSha256 = input.html ? sha256(input.html) : null;
  const base = {
    fact: "unchecked" as const, fragment, title: input.title, dateLabel: datePhrase(input.title),
    pageSha256, sectionSha256: null as string | null, start: null as number | null, end: null as number | null, sectionText: null as string | null,
  };
  if (input.httpStatus === 403 || input.httpStatus === 401) {
    const summary = input.feedExcerpt && input.feedExcerpt.length < 400;
    return {
      ...base, fetch: "detail_forbidden", body: summary ? "summary_only" : "missing", completeness: "blocked", queue: "held",
      reason: summary ? "detail is 403; the feed excerpt is a short summary, not an equivalent full section" : "detail is forbidden and no official full section is stored",
    };
  }
  if (input.atomXml && input.url.includes("/releases/")) {
    const note = atomReleaseNote(input.atomXml, input.title);
    if (note.body !== "attributed" || !note.text) {
      return { ...base, fetch: "feed_stored", body: note.body, completeness: note.body === "ambiguous" ? "ambiguous" : "partial", queue: "held", reason: note.reason, start: note.start, end: note.end };
    }
    const thin = versionLine(note.text) || TRUNCATION.test(note.text);
    return {
      ...base, fetch: "feed_stored", body: "attributed", completeness: thin ? "partial" : "complete",
      queue: thin ? "held" : "ready_for_features", reason: note.reason,
      sectionText: note.text, sectionSha256: sha256(note.text), dateLabel: note.updated,
      ...byteSpan(input.atomXml, note.start, note.end),
    };
  }
  if (fragment && input.html) {
    const cut = fragmentSection(input.html, fragment);
    if (!cut) return { ...base, fetch: "feed_stored", body: "missing", completeness: "ambiguous", queue: "held", reason: "fragment id is not on an element of the saved page" };
    const dropped = cut.subheadings.filter((heading) => !cut.text.includes(heading));
    if (dropped.length > 0) {
      return {
        ...base, fetch: "feed_stored", body: "ambiguous", completeness: "partial", queue: "held",
        reason: `subheading dropped before the next update: ${dropped.join(" | ")}`, sectionText: cut.text, sectionSha256: sha256(cut.text),
        ...byteSpan(input.html, cut.start, cut.end),
      };
    }
    const thin = TRUNCATION.test(cut.text);
    return {
      ...base, fetch: "feed_stored", body: "attributed", completeness: thin ? "partial" : "complete",
      queue: thin ? "held" : "ready_for_features",
      reason: cut.subheadings.length
        ? "fragment runs to the next same-level update and keeps the subheadings inside that span"
        : "fragment runs to the next same-level update; the span has no later subheading",
      sectionText: cut.text, sectionSha256: sha256(cut.text),
      ...byteSpan(input.html, cut.start, cut.end),
    };
  }
  if (input.html) {
    const dom = domArticle(input.html);
    if (dom) {
      const ready = !dom.gap && !!dom.text && !/document\.head|<\/script>/.test(dom.text);
      return {
        ...base, fetch: "feed_stored", body: ready ? "attributed" : "ambiguous", completeness: ready ? "complete" : dom.text ? "partial" : "ambiguous",
        queue: ready ? "ready_for_features" : "held",
        reason: dom.gap ?? (dom.headings.length
          ? `DOM slice ${dom.source}; ${dom.headings.length} heading(s) stay inside the slice`
          : `DOM slice ${dom.source}; the body element has no internal heading, and the slice runs from that element to the chrome heading`),
        sectionText: ready ? dom.text : null, sectionSha256: ready ? sha256(dom.text) : null,
        ...byteSpan(input.html, dom.start, dom.end),
      };
    }
  }
  if (input.prose) {
    const prose = classifyProse(input.title, input.prose);
    const ready = prose.completeness === "complete" || prose.completeness === "partial";
    return {
      ...base, fetch: "feed_stored", body: ready ? "attributed" : "ambiguous", completeness: prose.completeness, queue: ready ? "ready_for_features" : "held",
      reason: prose.reason, sectionText: ready ? prose.text : null, sectionSha256: ready ? sha256(prose.text) : null,
    };
  }
  if (!input.html) {
    return { ...base, fetch: "detail_not_stored", body: "not_stored", completeness: "ambiguous", queue: "held", reason: "no response body was saved" };
  }
  const cut = cutHtmlSection(input.html, { fragment, title: input.title, dateLabel: fragment ? datePhrase(input.title) : null, article: !fragment });
  if (fragment) {
    const usable = cut.body === "attributed" && !!cut.sectionText && !TRUNCATION.test(cut.sectionText);
    return {
      ...cut, fetch: "feed_stored", completeness: cut.body === "ambiguous" ? "ambiguous" : cut.body === "missing" ? "ambiguous" : usable ? "complete" : "partial",
      queue: usable ? "ready_for_features" : "held",
    };
  }
  if (cut.body !== "attributed" || !cut.sectionText) {
    return { ...cut, fetch: "feed_stored", completeness: cut.body === "missing" ? "ambiguous" : "ambiguous", queue: "held" };
  }
  const titleWords = norm(input.title).split(" ").filter((word) => word.length > 3);
  const have = titleWords.filter((word) => norm(cut.sectionText!).includes(word)).length;
  const titleOk = titleWords.length === 0 || have >= Math.min(2, titleWords.length);
  const truncated = TRUNCATION.test(cut.sectionText);
  const completeness: Completeness = !titleOk ? "ambiguous" : truncated ? "partial" : "complete";
  return { ...cut, fetch: "feed_stored", completeness, queue: completeness === "ambiguous" ? "held" : "ready_for_features" };
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
    const thin = !!note.text && versionLine(note.text);
    const ready = note.body === "attributed" && !!note.text && !thin;
    return {
      fetch: "feed_stored", body: note.body, fact: "unchecked", queue: ready ? "ready_for_features" : "held",
      completeness: note.body !== "attributed" ? "ambiguous" : thin ? "partial" : "complete",
      reason: note.reason, fragment, title: sample.title, dateLabel: note.updated ?? dateLabel,
      pageSha256: sha256(sample.feedXml), sectionSha256: note.text ? sha256(note.text) : null,
      start: note.start, end: note.end, sectionText: note.text,
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
