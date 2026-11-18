// Map the two verified calibration decisions and real drafts. Does not invent missing judgment fields.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseFileResultDocument, parseSelectionDecisionDocument } from "../site/own-pipeline.ts";

const RULESET = "17-选题打分推荐-v2.3#sha256:45c5a6a0105268a6ecf887c8bc7611595e9626fe0a25b7ce76ca48ee64e3e43e";
const URLS = [
  "https://github.com/anthropics/claude-code/releases/tag/v2.1.323",
  "https://antigravity.google/releases?tab=hub&version=2.33.0",
];
const OLD_NINE = new Set([
  "assistant-selection-decision-draft-v2-nine-convenience-v1",
  "assistant-selection-decision-draft-v3-rejudge-simready-watermark-xycond-v1",
]);

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const selectionDoc = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const drafts = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const items = selectionDoc.items.filter((item: { url: string }) => URLS.includes(item.url));
if (items.length !== 2) throw new Error("校准包里不是这两条");
if (selectionDoc.rulesetVersion !== RULESET) throw new Error("规则集哈希变了");

const mappedSelection = [];
const mappedFile = [];
const missing = [];
for (const item of items) {
  const articleId = item.articleId_mapping?.articleId;
  if (typeof articleId !== "string" || !articleId) throw new Error(`没有事后 articleId 映射 ${item.url}`);
  if (OLD_NINE.has(item.promptVersion)) throw new Error("不能套用旧九条提示词");
  const excerpt = item.exact_excerpt;
  const start = item.exact_excerpt_bound_offset;
  if (typeof excerpt !== "string" || !Number.isInteger(start)) throw new Error(`引用位置不完整 ${item.url}`);
  const present = {
    articleId,
    evidenceHash: item.evidenceHash,
    evidenceVersion: item.evidenceVersion,
    inputRevision: item.inputRevision,
    rulesetVersion: item.rulesetVersion,
    executionSource: item.executionSource,
    modelKnowledge: "unknown",
    knownModel: null,
    output: {
      narrowClaim: item.used_claim,
      quoteLocation: { excerpt, start, end: start + excerpt.length },
      conditions: item.conditions,
      time: item.published_basis,
      audience: item.audience,
      clauses: item.clauses_matched,
    },
  };
  const absent = ["promptVersion", "output.valueBasis", "output.substantiveAddition"].filter((key) => {
    if (key === "promptVersion") return typeof item.semanticPromptVersion !== "string";
    return true;
  });
  missing.push({ url: item.url, articleId, absent, selectionPromptVersionKeptApart: item.promptVersion });
  mappedFile.push({ url: item.url, present, absent });
  mappedSelection.push({ ...item, articleId, articleId_mapping_applied: articleId });
}

const selectionOut = {
  schema: "selection-decision-from-fields-v2-min",
  factStatus: "unchecked",
  releaseStatus: "not_licensed",
  items: mappedSelection,
};
parseSelectionDecisionDocument(selectionOut);
let fileRejected = "";
try {
  parseFileResultDocument({ schema: "own-file-result-v1", items: mappedFile.map((row) => row.present) });
} catch (error) {
  fileRejected = error instanceof Error ? error.message : String(error);
}
if (!fileRejected) throw new Error("缺字段的文件语义不该通过校验");

const draftBodies = drafts.drafts.filter((row: { sourceURL: string }) => URLS.includes(row.sourceURL)).map((row: { draftId: string; sourceURL: string; body: string; title: string }) => ({
  draftId: row.draftId, sourceURL: row.sourceURL, title: row.title, bodySha256: sha(row.body), body: row.body,
}));

const report = {
  adapter: "public-sample-v4-calibration-to-file-v1",
  didNotInventModelReceipt: true,
  didNotReuseOldNinePrompt: true,
  rulesetUnchanged: RULESET,
  fileImport: "not_run",
  fileRejected,
  requiredFileItemKeys: ["articleId", "evidenceHash", "evidenceVersion", "inputRevision", "rulesetVersion", "promptVersion", "executionSource", "modelKnowledge", "knownModel", "output"],
  requiredOutputKeys: ["narrowClaim", "quoteLocation", "conditions", "time", "audience", "clauses", "valueBasis", "substantiveAddition"],
  mappedFromExisting: {
    articleId: "articleId_mapping.articleId",
    narrowClaim: "used_claim",
    "quoteLocation.excerpt": "exact_excerpt",
    "quoteLocation.start": "exact_excerpt_bound_offset",
    "quoteLocation.end": "start plus excerpt length",
    conditions: "conditions",
    time: "published_basis",
    audience: "audience",
    clauses: "clauses_matched",
    rulesetVersion: "item.rulesetVersion",
    executionSource: "item.executionSource",
  },
  missing,
  mappedFile,
  selectionParses: true,
  draftBodies,
  sourceContract: {
    dailyX: 132,
    roster: 174,
    nonX: "47 includes excluded, observe, and manual optional",
    eightNewAlreadyIn132: true,
    gapsAreMissingProofInTwoLogs: ["hf_models_trending", "hf_daily_papers", "github_trending_daily", "github_trending_weekly", "anthropic_news_page", "meta_research_blog", "nvidia_newsroom_page", "thinking_machines_news", "chatgpt_help_release_notes", "github_fast_rising"],
    notUpstream: "TheRundownAI",
    scoreCheckOnly: "ArtificialAnlys",
    benchmarkNotInPool: "10-29",
    thisRunDidNotFetch: true,
    notAssertedNeverRan: true,
  },
};
writeFileSync(process.argv[4]!, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, fileRejected, missing: missing.map((row) => row.absent) }));
