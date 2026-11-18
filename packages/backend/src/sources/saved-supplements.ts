// Readings taken from a response that is already stored. They do not fetch the linked page.
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

function inChrome(el: cheerio.Element, $: cheerio.CheerioAPI): boolean {
  let node: cheerio.Element | null = el;
  while (node) {
    const tag = node.tagName;
    if (!tag) break;
    const cls = String($(node).attr("class") ?? "");
    if (tag === "nav" || tag === "header" || tag === "footer" || $(node).attr("role") === "navigation") return true;
    if (/(^|\s)card(\s|$)/.test(cls) || tag === "article" && /(^|\s)card(\s|$)/.test(cls)) return true;
    node = node.parent as cheerio.Element | null;
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

/** Chart rows plus the axis fields the page stored. A bare number keeps its suffix and decimals. */
export function chartAxisParts(html: string): Array<{ id: string; role: "chart_axis"; byteStart: number; byteEnd: number; text: string }> {
  const $ = cheerio.load(html);
  const bytes = Buffer.from(html);
  const parts = [];
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
