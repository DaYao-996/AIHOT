import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFetched, classifyProse, cutHtmlSection, gateStoredSample, parseModelOutputFile } from "../packages/backend/src/body-gate.ts";

const page = `<article>
<h2 id="linked-billing">Linked billing</h2>
<p>November 17, 2026. Linked billing is in beta.</p>
<h2 id="text-watermark">Text watermark</h2>
<p>November 16, 2026. Watermark applies to Opus.</p>
</article>`;

test("a fragment cut stops at the next heading and is not the whole page", () => {
  const cut = cutHtmlSection(page, { fragment: "linked-billing", title: "Linked billing", dateLabel: "November 17, 2026" });
  assert.equal(cut.body, "attributed");
  assert.match(cut.sectionText ?? "", /Linked billing is in beta/);
  assert.equal((cut.sectionText ?? "").includes("Watermark"), false);
  assert.ok((cut.sectionText ?? "").length < page.length);
  assert.equal(typeof cut.pageSha256, "string");
  assert.notEqual(cut.sectionSha256, cut.pageSha256);
});

test("a fragment and a different title are ambiguous, and a missing heading is missing", () => {
  const clash = cutHtmlSection(page, { fragment: "linked-billing", title: "Text watermark" });
  assert.equal(clash.body, "ambiguous");
  assert.match(clash.reason, /different headings/);
  const absent = cutHtmlSection(page, { fragment: "no-such", title: "No such note" });
  assert.equal(absent.body, "missing");
  assert.equal(absent.sectionText, null);
});

test("stored samples do not treat a feed excerpt or a missing page as a body", () => {
  const forbidden = gateStoredSample({
    url: "https://openai.com/index/example", title: "Example", publishedAt: "2026-11-17T00:00:00.000Z",
    excerpt: "A short feed summary.", bodyText: null, bodyHtml: null, detailHtml: null, feedXml: null, detailHttpStatus: 403,
  });
  assert.equal(forbidden.fetch, "detail_forbidden");
  assert.equal(forbidden.body, "summary_only");
  assert.equal(forbidden.queue, "held");
  assert.equal(forbidden.fact, "unchecked");
  const notStored = gateStoredSample({
    url: "https://blog.google/example#section", title: "Example", publishedAt: null,
    excerpt: null, bodyText: null, bodyHtml: null, detailHtml: null, feedXml: null, detailHttpStatus: 200,
  });
  assert.equal(notStored.body, "not_stored");
  assert.equal(notStored.queue, "held");
});

test("a forbidden detail stays blocked and a unique fragment can be complete", () => {
  const blocked = classifyFetched({ title: "Introducing", url: "https://openai.com/index/x", httpStatus: 403, html: null, feedExcerpt: "A short summary." });
  assert.equal(blocked.completeness, "blocked");
  assert.equal(blocked.queue, "held");
  const section = `<h2 id="linked-billing">Linked billing</h2><p>November 17, 2026. Linked billing is in beta for profiles.</p><h2 id="next">Next</h2><p>Other note.</p>`;
  const cut = classifyFetched({
    title: "Claude Platform release notes — November 17, 2026",
    url: "https://platform.claude.com/docs/en/release-notes/overview#linked-billing",
    httpStatus: 200, html: section,
  });
  assert.equal(cut.completeness, "complete");
  assert.equal((cut.sectionText ?? "").includes("Other note"), false);
});

test("a newsletter footer is not part of the article", () => {
  const prose = `${"Nov 17, 2026 | Put Gemini to work and finish your tasks. The list is ready. ".repeat(4)}Get the latest news from Google in your inbox Sign up for our newsletters with product updates.`;
  const judged = classifyProse("Put Gemini to work for you", prose);
  assert.equal(judged.completeness, "complete");
  assert.equal(judged.text.includes("newsletter"), false);
  assert.match(judged.text, /list is ready\.$/);
});

test("a model file is accepted only without route labels", () => {
  const ok = parseModelOutputFile([{
    articleId: "a", evidenceHash: "e", promptVersion: "p", modelVersion: "m", inputHash: "i",
    output: { human_verification: { status: "unverified" } }, costUsd: null,
  }]);
  assert.equal(ok.ok, true);
  const banned = parseModelOutputFile([{
    articleId: "a", evidenceHash: "e", promptVersion: "p", modelVersion: "m", inputHash: "i",
    output: { prioritize: true }, costUsd: null,
  }]);
  assert.equal(banned.ok, false);
});
