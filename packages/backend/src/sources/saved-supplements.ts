// Readings taken from a response that is already stored. They do not fetch the linked page.
import type { Element } from "domhandler";
import * as cheerio from "cheerio";

export interface StoredLink {
  label: string;
  href: string;
  absoluteUrl: string;
  byteStart: number;
  byteEnd: number;
  linkedPageRead: false;
}

export function absoluteHref(href: string, pageUrl: string): string | null {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sameDocument(absolute: string, pageUrl: string): boolean {
  const a = new URL(absolute);
  const b = new URL(pageUrl);
  return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") && a.search === b.search;
}

function inChrome(el: Element, $: cheerio.CheerioAPI): boolean {
  let node: Element | null = el;
  while (node) {
    const tag = node.tagName;
    if (!tag) break;
    const cls = String($(node).attr("class") ?? "");
    if (tag === "nav" || tag === "header" || tag === "footer" || $(node).attr("role") === "navigation") return true;
    if (/(^|\s)card(\s|$)/.test(cls) || tag === "article" && /(^|\s)card(\s|$)/.test(cls)) return true;
    node = node.parent as Element | null;
  }
  return false;
}

/** A saved anchor is kept only when the raw bytes contain that href beside its label, outside the chrome. */
export function storedContentLink(html: string, pageUrl: string, bodyText: string, anchor: { label: string; href: string; absoluteUrl: string; byteOffset: number }): StoredLink | { skipped: string } {
  const absolute = absoluteHref(anchor.href, pageUrl);
  if (!absolute) return { skipped: "href 无法解析" };
  const expected = anchor.absoluteUrl.replace(/\/$/, "");
  if (absolute.replace(/\/$/, "") !== expected) return { skipped: "绝对地址与原文解析不一致" };
  if (sameDocument(absolute, pageUrl)) return { skipped: "指向本页，不是外链" };
  if (bodyText.includes(absolute) || bodyText.includes(anchor.absoluteUrl)) return { skipped: "地址已经在正文里" };
  const bytes = Buffer.from(html);
  const window = bytes.subarray(anchor.byteOffset, Math.min(bytes.length, anchor.byteOffset + Math.max(anchor.href.length + 80, 180))).toString("utf8");
  if (!window.includes(anchor.href)) return { skipped: "原文该位置没有这个 href" };
  const around = bytes.subarray(Math.max(0, anchor.byteOffset - 200), Math.min(bytes.length, anchor.byteOffset + anchor.href.length + 500)).toString("utf8");
  if (!around.includes(anchor.label)) return { skipped: "原文该位置没有这个标签" };
  const $ = cheerio.load(html);
  const matches = $("a").toArray().filter((el) => $(el).attr("href") === anchor.href && $(el).text().replace(/\s+/g, " ").includes(anchor.label));
  if (!matches.length) return { skipped: "页面上没有这个链接" };
  if (matches.every((el) => inChrome(el, $))) return { skipped: "链接在导航或页脚" };
  const at = bytes.indexOf(Buffer.from(anchor.href), anchor.byteOffset);
  return { label: anchor.label, href: anchor.href, absoluteUrl: absolute, byteStart: at, byteEnd: at + Buffer.byteLength(anchor.href), linkedPageRead: false };
}

function jsonSlice(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function axisLines(name: string, value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [`${name}: ${value}`];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const lines = [];
  for (const key of ["label", "suffix", "decimals", "min", "max", "unit"]) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string" || typeof item === "number") lines.push(`${name}.${key}: ${item}`);
  }
  return lines;
}

export interface ContentAside {
  links: StoredLink[];
  charts: Array<{ id: string; role: "chart_axis"; byteStart: number; byteEnd: number; text: string }>;
}

function locateHref(bytes: Buffer, href: string, label: string): number {
  const needle = Buffer.from(href);
  let from = 0;
  while (from < bytes.length) {
    const at = bytes.indexOf(needle, from);
    if (at < 0) return -1;
    const around = bytes.subarray(Math.max(0, at - 200), Math.min(bytes.length, at + href.length + 500)).toString("utf8");
    if (around.includes(label)) return at;
    from = at + 1;
  }
  return -1;
}

/** Links and chart axes on the page itself. The caller does not name them. Linked pages are not read. */
export function contentAside(html: string, pageUrl: string, bodyText: string): ContentAside {
  const $ = cheerio.load(html);
  const bytes = Buffer.from(html);
  const links: StoredLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    if (inChrome(el, $)) return;
    const href = $(el).attr("href") ?? "";
    if (!href || href.startsWith("#") || /^(?:mailto|javascript|data):/i.test(href)) return;
    const absolute = absoluteHref(href, pageUrl);
    if (!absolute || sameDocument(absolute, pageUrl)) return;
    if (bodyText.includes(absolute)) return;
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (label.length < 2) return;
    const at = locateHref(bytes, href, label);
    if (at < 0) return;
    const key = `${label}\0${absolute}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ label, href, absoluteUrl: absolute, byteStart: at, byteEnd: at + Buffer.byteLength(href), linkedPageRead: false });
  });
  return { links, charts: chartAxisParts(html) };
}

function lineValue(text: string, name: string): string {
  const match = new RegExp(`^${name}: (.*)$`, "m").exec(text);
  return match?.[1]?.trim() ?? "";
}

/** What scoring can see: a parse-time aside, plus supplements already stored on the evidence gate. */
export function asideFromGate(gate: unknown): ContentAside {
  const links: StoredLink[] = [];
  const charts: ContentAside["charts"] = [];
  if (!gate || typeof gate !== "object") return { links, charts };
  const row = gate as { aside?: ContentAside; supplements?: Array<{ parts?: Array<Record<string, unknown>> }> };
  for (const link of row.aside?.links ?? []) links.push({ ...link, linkedPageRead: false });
  for (const chart of row.aside?.charts ?? []) charts.push(chart);
  for (const supplement of row.supplements ?? []) {
    for (const part of supplement.parts ?? []) {
      const role = String(part.role ?? "");
      const text = String(part.text ?? "");
      if (role === "content_link") {
        const label = lineValue(text, "label");
        const absoluteUrl = lineValue(text, "absoluteUrl");
        if (!label || !absoluteUrl) continue;
        links.push({
          label, href: absoluteUrl, absoluteUrl,
          byteStart: Number(part.byteStart ?? 0), byteEnd: Number(part.byteEnd ?? 0), linkedPageRead: false,
        });
      } else if (role === "chart_axis" || role === "chart") {
        charts.push({
          id: String(part.id ?? "chart"), role: "chart_axis",
          byteStart: Number(part.byteStart ?? 0), byteEnd: Number(part.byteEnd ?? 0), text,
        });
      }
    }
  }
  return { links, charts };
}

/** Chart rows plus the axis fields the page stored. A bare number keeps its suffix and decimals. */
export function chartAxisParts(html: string): Array<{ id: string; role: "chart_axis"; byteStart: number; byteEnd: number; text: string }> {
  const $ = cheerio.load(html);
  const bytes = Buffer.from(html);
  const parts: ContentAside["charts"] = [];
  let n = 0;
  $("mistral-block-chart").each((_, el) => {
    n += 1;
    const raw = jsonSlice($(el).text());
    if (!raw) {
      parts.push({ id: `chart-axis-${n}`, role: "chart_axis" as const, byteStart: 0, byteEnd: 0, text: "chartNotExtracted: true" });
      return;
    }
    const chart = JSON.parse(raw) as Record<string, unknown>;
    const at = bytes.indexOf(Buffer.from(raw));
    const lines = [`title: ${typeof chart.title === "string" ? chart.title : ""}`, `type: ${typeof chart.type === "string" ? chart.type : ""}`];
    lines.push(...axisLines("x", chart.x), ...axisLines("y", chart.y), ...axisLines("value", chart.value));
    const rows = Array.isArray(chart.data) ? chart.data : Array.isArray(chart.points) ? chart.points : [];
    lines.push("rows:");
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const bits = [`label=${String(item.label ?? "")}`];
      if (item.value !== undefined) bits.push(`value=${String(item.value)}`);
      if (item.x !== undefined) bits.push(`x=${String(item.x)}`);
      if (item.y !== undefined) bits.push(`y=${String(item.y)}`);
      lines.push(bits.join(" "));
    }
    parts.push({ id: `chart-axis-${n}`, role: "chart_axis" as const, byteStart: at, byteEnd: at + Buffer.byteLength(raw), text: lines.join("\n") });
  });
  return parts;
}
