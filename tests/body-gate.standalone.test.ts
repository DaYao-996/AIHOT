import assert from "node:assert/strict";
import { test } from "node:test";
import { cutHtmlSection, gateStoredSample, parseModelOutputFile } from "../packages/backend/src/body-gate.ts";

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
