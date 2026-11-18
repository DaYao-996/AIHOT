// Merge the frozen selection, the real draft body, and the two completed semantic strings.
// The CLI files keep those strings. Prompt names that disagree stay in the provenance file.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseFileResultDocument, parseReviewDraftDocument, parseSelectionDecisionDocument } from "../site/own-pipeline.ts";

const RULESET = "17-选题打分推荐-v2.3#sha256:45c5a6a0105268a6ecf887c8bc7611595e9626fe0a25b7ce76ca48ee64e3e43e";
const SEMANTIC_PROMPT = "assistant-file-semantics-public40-two-completion-v1";
const PACK_SELECTION_PROMPT = "assistant-selection-decision-public-sample-v4-calibration-after-comparison-v1";
const DRAFT_PACKAGE = "real-draft-inputs-v2";
const URLS = [
  "https://github.com/anthropics/claude-code/releases/tag/v2.1.323",
  "https://antigravity.google/releases?tab=hub&version=2.33.0",
];

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function same(label: string, left: unknown, right: unknown) {
  if (left !== right) throw new Error(`${label} 不一致`);
}
function exact(label: string, value: string): string {
  if (value.trim() !== value || !value) throw new Error(`${label} 不能靠裁剪变成通过`);
  return value;
}

const selectionDoc = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const drafts = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const completion = JSON.parse(readFileSync(process.argv[4]!, "utf8"));
const outDir = process.argv[5]!;
mkdirSync(outDir, { recursive: true });

same("规则集", selectionDoc.rulesetVersion, RULESET);
same("规则集", completion.rulesetVersion, RULESET);
same("补齐语义提示词", completion.promptVersion, SEMANTIC_PROMPT);
same("校准包选择提示词", selectionDoc.promptVersion, PACK_SELECTION_PROMPT);
same("补齐包记下的校准包选择提示词", completion.selectionPromptVersion, PACK_SELECTION_PROMPT);
if (completion.modelKnowledge !== "unknown" || completion.knownModel !== null || completion.executionSource !== "assistant-file") {
  throw new Error("模型身份不是 unknown / assistant-file");
}

const provenance = [];
const fileItems = [];
const selectionItems = [];
const draftItems = [];

for (const url of URLS) {
  const frozen = selectionDoc.items.find((item: { url: string }) => item.url === url);
  const done = completion.items.find((item: { url: string }) => item.url === url);
  const draft = drafts.drafts.find((item: { sourceURL: string }) => item.sourceURL === url);
  if (!frozen || !done || !draft) throw new Error(`缺一条 ${url}`);
  const mappedId = frozen.articleId_mapping?.articleId;
  same("事后 articleId", mappedId, done.articleId);
  same("冻结 articleId", frozen.articleId, null);
  same("证据哈希", frozen.evidenceHash, done.evidenceHash);
  same("证据版本", frozen.evidenceVersion, done.evidenceVersion);
  same("文章修订", frozen.inputRevision, done.inputRevision);
  same("稿件绑定证据", draft.binding.evidenceHash, done.evidenceHash);
  same("稿件绑定修订", draft.binding.articleRevision, done.inputRevision);
  same("单条历史选择提示词", frozen.promptVersion, done.historicalItemSelectionPromptVersion);
  same("补齐条目上的校准包选择提示词", done.selectionPromptVersion, PACK_SELECTION_PROMPT);
  same("补齐条目语义提示词", done.promptVersion, SEMANTIC_PROMPT);
  if (frozen.fact_checked === true || frozen.factStatus !== "unchecked" || frozen.releaseStatus !== "not_licensed") {
    throw new Error("冻结决定已把事实或许可标高");
  }
  const excerpt = exact("exact_excerpt", frozen.exact_excerpt);
  const start = frozen.exact_excerpt_bound_offset;
  if (!Number.isInteger(start) || start < 0) throw new Error("引用偏移无效");
  const valueBasis = exact("valueBasis", done.output.valueBasis);
  const substantiveAddition = exact("substantiveAddition", done.output.substantiveAddition);
  const clauses = frozen.clauses_matched.map((clause: { id: string; text: string }) => ({ id: exact("clause.id", clause.id), text: exact("clause.text", clause.text) }));
  const body = exact("draft.body", draft.body);
  same("稿件正文哈希", sha(body), done.draftBodySHA);
  const citations = draft.claims.map((claim: { quote?: string | null }) => claim.quote).filter((quote: string | null | undefined): quote is string => typeof quote === "string" && quote.length > 0).map((quote: string) => exact("claim.quote", quote));
  if (citations.length === 0) throw new Error("真稿没有来源引用");
  const selection = { ...frozen, articleId: mappedId };
  const changed = Object.keys(selection).filter((key) => selection[key] !== frozen[key]);
  if (changed.join() !== "articleId") throw new Error("选择条目除 articleId 外被改了");
  fileItems.push({
    articleId: mappedId,
    evidenceHash: frozen.evidenceHash,
    evidenceVersion: frozen.evidenceVersion,
    inputRevision: frozen.inputRevision,
    rulesetVersion: RULESET,
    promptVersion: SEMANTIC_PROMPT,
    executionSource: "assistant-file",
    modelKnowledge: "unknown",
    knownModel: null,
    output: {
      narrowClaim: exact("used_claim", frozen.used_claim),
      quoteLocation: { excerpt, start, end: start + excerpt.length },
      conditions: frozen.conditions.map((item: string) => exact("condition", item)),
      time: exact("published_basis", frozen.published_basis),
      valueBasis,
      audience: frozen.audience.map((item: string) => exact("audience", item)),
      substantiveAddition,
      clauses,
    },
  });
  selectionItems.push(selection);
  draftItems.push({
    articleId: mappedId,
    evidenceHash: frozen.evidenceHash,
    evidenceVersion: frozen.evidenceVersion,
    inputRevision: frozen.inputRevision,
    rulesetVersion: RULESET,
    promptVersion: DRAFT_PACKAGE,
    text: body,
    sourceNote: exact("formatNote", draft.formatNote),
    sourceCitations: citations,
    conditions: frozen.conditions.map((item: string) => exact("condition", item)),
    technicalFixture: false,
    requiresHumanReview: true,
  });
  provenance.push({
    url,
    articleId: mappedId,
    articleIdWasNullOnFrozenDecision: true,
    articleIdMappingSource: frozen.articleId_mapping,
    semanticPromptVersion: SEMANTIC_PROMPT,
    semanticPromptRole: "这次补 valueBasis 和 substantiveAddition 的任务，不充当以往语义提示词",
    selectionItemPromptVersion: frozen.promptVersion,
    selectionPackPromptVersion: PACK_SELECTION_PROMPT,
    draftPromptVersion: DRAFT_PACKAGE,
    draftPromptRole: "稿件包 schema 名。稿件原件没有 promptVersion，不把语义提示词或选择提示词写到稿上",
    valueBasis,
    substantiveAddition,
    completionFlagsNotCopiedIntoCli: ["valueBasisAndSubstantiveAdditionArePlainStrings", "cliTypeAdaptationIsMainsResponsibility", "didNotInventCliTypes"],
    modelKnowledge: "unknown",
    knownModel: null,
    executionSource: "assistant-file",
    vendorReceipt: false,
  });
}

const fileDoc = { schema: "own-file-result-v1", items: fileItems };
const selectionOut = { schema: "selection-decision-from-fields-v2-min", factStatus: "unchecked", releaseStatus: "not_licensed", items: selectionItems };
const draftDoc = { schema: "own-review-draft-v1", items: draftItems };
const parsedFile = parseFileResultDocument(fileDoc);
const parsedSelection = parseSelectionDecisionDocument(selectionOut);
const parsedDraft = parseReviewDraftDocument(draftDoc);
parsedFile.forEach((item, index) => {
  same("入库 valueBasis", item.output.valueBasis, fileItems[index]!.output.valueBasis);
  same("入库 substantiveAddition", item.output.substantiveAddition, fileItems[index]!.output.substantiveAddition);
  same("入库 narrowClaim", item.output.narrowClaim, fileItems[index]!.output.narrowClaim);
  same("入库 excerpt", item.output.quoteLocation.excerpt, fileItems[index]!.output.quoteLocation.excerpt);
});
parsedDraft.forEach((item, index) => same("入库正文", item.text, draftItems[index]!.text));
if (parsedSelection.length !== 2) throw new Error("选择条数不对");

writeFileSync(`${outDir}/file-results.json`, JSON.stringify(fileDoc, null, 2));
writeFileSync(`${outDir}/selection-decisions.json`, JSON.stringify(selectionOut, null, 2));
writeFileSync(`${outDir}/review-drafts.json`, JSON.stringify(draftDoc, null, 2));
writeFileSync(`${outDir}/PROVENANCE.json`, JSON.stringify({
  adapter: "public-sample-v4-calibration-to-file-v9",
  rulesetVersion: RULESET,
  items: provenance,
}, null, 2));
console.log(JSON.stringify({ ok: true, articles: fileItems.map((item) => item.articleId), citations: draftItems.map((item) => item.sourceCitations.length) }));
