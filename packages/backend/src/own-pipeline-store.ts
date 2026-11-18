// 受控导入、证据版本和自有判断的数据库写入。不排队、不调用模型、不建源。
// 采集和模型开关只约束 CLI。这里不读那些开关，调用方要自己守住入口。
// 导入把 processing_state 收成 skipped，content.sweep 只捡 new，所以之后即使 worker 起来也不会把这些行入队。
import { contentHash, identityKeyFor, reviseMaterial, upsertMaterial, type XPostData } from "./content/materials.ts";
import { sql, type Db } from "./db.ts";
import { sha256, stableJson } from "./lib/ids.ts";
import { type BodyGate, type ModelFileItem } from "./body-gate.ts";
import {
  ImportRejected,
  assertThrowawayDatabase,
  canonicalIdentity,
  cumulativeEvidenceHash,
  fileExecutionIdentity,
  fileOutputCanonical,
  fileOutputSha256,
  mapControlledImport,
  selectionOutputSha256,
  ownModelOutput,
  parseOwnModelOutput,
  type FileResultItem,
  type FileResultRecord,
  type ControlledImportItem,
  type JudgmentBody,
  type JudgmentIdentity,
} from "../../../site/own-pipeline.ts";

type XPost = XPostData;

export class JudgmentConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgmentConflict";
  }
}

interface RawIdentity {
  fileSha256: string | null;
  canonicalSha256: string;
}

interface EvidenceVersionRow {
  version: number;
  article_revision: number;
  raw: unknown;
  body_text: string | null;
  quoted_text: string | null;
  x_post: XPost | null;
  evidence_hash: string;
  raw_identity: RawIdentity | null;
}

export interface EvidenceWrite {
  articleId: string;
  articleRevision: number;
  evidenceVersion: number;
  evidenceHash: string;
  idempotent: boolean;
  createdArticle: boolean;
  revisedArticle: boolean;
  gaps: string[];
}

export interface JudgmentWrite {
  id: string;
  identity: JudgmentIdentity;
  body: JudgmentBody;
  stale: boolean;
  /** 应用层重复调用返回已有行。唯一约束只在并发插入撞车时触发。 */
  idempotent: boolean;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("拒绝空的数据库地址");
  assertThrowawayDatabase(url);
  return url;
}

function advisoryKey(text: string): string {
  let n = BigInt(`0x${sha256(text).slice(0, 16)}`);
  const sign = 1n << 63n;
  if (n >= sign) n -= 1n << 64n;
  return n.toString();
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

function canonicalBody(body: JudgmentBody): JudgmentBody {
  return {
    ...body,
    comparison: body.comparison ?? null,
    modelReceiptId: body.modelReceiptId ?? null,
    factCheck: body.factCheck ?? null,
    fileResult: body.fileResult ?? null,
    selectionDecision: body.selectionDecision ?? null,
  };
}

function judgmentComparison(body: JudgmentBody): Record<string, unknown> | null {
  const stored: Record<string, unknown> = {};
  if (body.fileResult) stored.fileResult = body.fileResult;
  if (body.comparison) {
    stored.algorithm = body.comparison.algorithm;
    stored.inputHash = body.comparison.inputHash;
  }
  if (body.factCheck) stored.factCheck = body.factCheck;
  if (body.selectionDecision) stored.selectionDecision = body.selectionDecision;
  return Object.keys(stored).length ? stored : null;
}

function explicitText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function fileBytes(item: ControlledImportItem): Buffer | null {
  if (!item.rawFileBase64) return null;
  return Buffer.from(item.rawFileBase64, "base64");
}

export async function writeEvidence(tx: Db, item: ControlledImportItem): Promise<EvidenceWrite> {
  databaseUrl();
  const mapped = mapControlledImport(item);
  await tx`SELECT pg_advisory_xact_lock(${advisoryKey(`import\0${item.sourceId}\0${item.url}`)}::bigint)`;
  const [source] = await tx<{ id: string }[]>`SELECT id FROM sources WHERE id = ${item.sourceId}`;
  if (!source) throw new Error("源不存在，拒绝自动建源");
  const [sameUrl] = await tx<{ identity_key: string }[]>`
    SELECT identity_key FROM articles WHERE source_id = ${item.sourceId} AND url = ${item.url}`;
  const wanted = identityKeyFor({
    sourceId: item.sourceId, url: item.url, title: item.title, xPost: item.xPost ?? null, via: "import",
  });
  if (sameUrl && item.xPost?.tweetId && sameUrl.identity_key.startsWith("x:") && sameUrl.identity_key !== `x:${item.xPost.tweetId}`) {
    throw new ImportRejected(`同一 URL 已绑定帖子身份 ${sameUrl.identity_key}`);
  }
  const identityKey = sameUrl?.identity_key ?? wanted;
  if (!sameUrl) {
    const [other] = await tx<{ url: string }[]>`
      SELECT url FROM articles WHERE identity_key = ${identityKey} AND NOT (source_id = ${item.sourceId} AND url = ${item.url})`;
    if (other) throw new ImportRejected(`身份 ${identityKey} 已属于另一条材料`);
  }
  const saved = await upsertMaterial({
    sourceId: item.sourceId,
    url: item.url,
    title: item.title,
    author: item.author ?? null,
    publishedAt: mapped.material.publishedAt ?? undefined,
    raw: item.raw,
    identityKey,
    ...(item.bodyText ? { bodyText: explicitText(item.bodyText), bodyStatus: "ok" as const } : {}),
    ...(item.xPost ? { xPost: item.xPost } : {}),
    via: "import",
  }, tx);
  await tx`SELECT pg_advisory_xact_lock(${advisoryKey(`judgment\0${saved.articleId}`)}::bigint)`;
  const versions = await tx<EvidenceVersionRow[]>`
    SELECT version, article_revision, raw, body_text, quoted_text, x_post, evidence_hash, raw_identity
    FROM own_evidence_versions WHERE article_id = ${saved.articleId} ORDER BY version FOR UPDATE`;
  const canonicalSha256 = sha256(stableJson(item.raw));
  const bytes = fileBytes(item);
  const verifiedFromBytes = bytes ? sha256(bytes) : null;
  if (bytes && item.rawFileSha256 && item.rawFileSha256 !== verifiedFromBytes) throw new ImportRejected("原件字节与声明的文件哈希不一致");
  if (item.rawFileSha256 && !bytes) {
    const [storedBytes] = await tx<{ raw_file: Buffer | null }[]>`
      SELECT raw_file FROM own_evidence_versions WHERE article_id = ${saved.articleId} AND raw_file IS NOT NULL ORDER BY version DESC LIMIT 1`;
    if (!storedBytes?.raw_file || sha256(storedBytes.raw_file) !== item.rawFileSha256) {
      throw new ImportRejected("没有原件字节，不能把文件哈希标成已验证");
    }
  }
  const fileSha256 = verifiedFromBytes;
  const priorFile = versions.map((row) => row.raw_identity?.fileSha256).find((value) => value);
  if (fileSha256 && priorFile && priorFile !== fileSha256) throw new ImportRejected("原件文件哈希与已保存的审阅声明不一致");
  const rawIdentity = { fileSha256, canonicalSha256, bytesVerified: !!fileSha256 };
  const latest = versions.at(-1);
  // 缺省字段沿用当前一版（patch）。显式 null 清空。与当前快照不同才另记一版；完全相同则幂等。回到较早的另一份原件会另记一版，旧版仍留着。
  const bodyText = item.bodyText === undefined ? (latest?.body_text ?? null) : explicitText(item.bodyText);
  const quotedText = item.quotedText === undefined ? (latest?.quoted_text ?? null) : explicitText(item.quotedText);
  const xPost = item.xPost === undefined ? (latest?.x_post ?? null) : item.xPost;
  const evidenceHash = cumulativeEvidenceHash({ title: item.title, raw: item.raw, bodyText, quotedText, xPost });
  await tx`UPDATE articles SET raw = ${tx.json(item.raw as never)}
    WHERE id = ${saved.articleId} AND raw IS DISTINCT FROM ${tx.json(item.raw as never)}::jsonb`;
  // 正文只经 upsertMaterial / reviseMaterial 写入。直接改 body_text 会让修订号和 content_hash 停在旧文本上。
  let revisedArticle = saved.revised;
  if (item.bodyText !== undefined) {
    const [mirror] = await tx<{ title: string; body_text: string | null; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, body_text, excerpt, content_hash FROM articles WHERE id = ${saved.articleId} FOR UPDATE`;
    const hash = contentHash({ title: mirror!.title, bodyText, excerpt: mirror!.excerpt });
    if (mirror!.body_text !== bodyText || mirror!.content_hash !== hash) {
      await reviseMaterial(tx, saved.articleId, {
        set: sql`body_text = ${bodyText}, body_status = ${bodyText ? "ok" : "pending"}`,
        hash, title: mirror!.title, bodyText,
      });
      revisedArticle = true;
    }
  }
  if (item.xPost !== undefined) {
    await tx`UPDATE articles SET x_post = ${xPost ? tx.json(xPost as never) : null} WHERE id = ${saved.articleId}`;
  }
  const [article] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${saved.articleId}`;
  const park = async () => {
    await tx`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL
      WHERE id = ${saved.articleId} AND processing_state = 'new'`;
  };
  if (latest && latest.evidence_hash === evidenceHash && Number(latest.article_revision) === Number(article!.revision)) {
    if (fileSha256 && !latest.raw_identity?.fileSha256) {
      await tx`UPDATE own_evidence_versions SET raw_identity = ${tx.json({ ...(latest.raw_identity ?? { canonicalSha256 }), fileSha256 } as never)}
        WHERE article_id = ${saved.articleId} AND version = ${latest.version} AND (raw_identity IS NULL OR raw_identity->>'fileSha256' IS NULL)`;
    }
    if (bytes) {
      await tx`UPDATE own_evidence_versions SET raw_file = ${bytes}
        WHERE article_id = ${saved.articleId} AND version = ${latest.version} AND raw_file IS NULL`;
    }
    await park();
    return {
      articleId: saved.articleId, articleRevision: article!.revision, evidenceVersion: latest.version, evidenceHash,
      idempotent: true, createdArticle: saved.created, revisedArticle, gaps: mapped.gaps,
    };
  }
  const version = (latest?.version ?? 0) + 1;
  await tx`
    INSERT INTO own_evidence_versions (article_id, version, article_revision, raw, body_text, quoted_text, x_post, evidence_hash, raw_identity, raw_file)
    VALUES (${saved.articleId}, ${version}, ${article!.revision}, ${tx.json(item.raw as never)},
            ${bodyText}, ${quotedText}, ${xPost ? tx.json(xPost as never) : null}, ${evidenceHash}, ${tx.json(rawIdentity as never)}, ${bytes})`;
  await tx`UPDATE own_judgments SET stale = true
    WHERE article_id = ${saved.articleId} AND stale = false
      AND (evidence_hash <> ${evidenceHash} OR input_revision <> ${article!.revision})`;
  await park();
  return {
    articleId: saved.articleId, articleRevision: article!.revision, evidenceVersion: version, evidenceHash,
    idempotent: false, createdArticle: saved.created, revisedArticle, gaps: mapped.gaps,
  };
}

function bodyFromRow(row: {
  information_type_id: JudgmentBody["informationTypeId"];
  content_line: JudgmentBody["contentLine"];
  material_status: JudgmentBody["materialStatus"];
  fact_status: JudgmentBody["factStatus"];
  value_status: JudgmentBody["valueStatus"];
  release_status: JudgmentBody["releaseStatus"];
  origin: JudgmentBody["origin"];
  reasons: string[];
  comparison: JudgmentBody["comparison"];
  model_receipt_id: number | null;
}): JudgmentBody {
  return {
    informationTypeId: row.information_type_id,
    contentLine: row.content_line,
    materialStatus: row.material_status,
    factStatus: row.fact_status,
    valueStatus: row.value_status,
    releaseStatus: row.release_status,
    origin: row.origin,
    reasons: row.reasons,
    comparison: row.comparison?.algorithm ? { algorithm: row.comparison.algorithm, inputHash: row.comparison.inputHash } : null,
    modelReceiptId: row.model_receipt_id,
    factCheck: (row.comparison as { factCheck?: JudgmentBody["factCheck"] } | null)?.factCheck ?? null,
    fileResult: (row.comparison as { fileResult?: FileResultRecord } | null)?.fileResult ?? null,
    selectionDecision: (row.comparison as { selectionDecision?: JudgmentBody["selectionDecision"] } | null)?.selectionDecision ?? null,
  };
}

function assertBody(body: JudgmentBody, identity: JudgmentIdentity): void {
  if (body.releaseStatus !== "not_licensed") throw new JudgmentConflict("判断不能发放发布许可");
  if (body.materialStatus !== "complete" && body.valueStatus !== "incomplete_material") {
    throw new JudgmentConflict("材料不完整时不能记成价值判断");
  }
  if (body.origin === "model" && (!identity.promptVersion || !identity.modelVersion)) {
    throw new JudgmentConflict("模型判断必须带可追溯的提示词版本和模型版本");
  }
  if (body.origin === "model" && !(Number.isInteger(body.modelReceiptId) && (body.modelReceiptId ?? 0) > 0)) {
    throw new JudgmentConflict("模型判断必须带可追溯回执");
  }
  if (body.origin === "file") {
    if (!identity.promptVersion || identity.modelVersion !== fileExecutionIdentity(body.fileResult?.executionSource ?? "assistant-file")) {
      throw new JudgmentConflict("文件结果的执行来源无法识别");
    }
    if (body.modelReceiptId) throw new JudgmentConflict("文件结果不能使用外部回执");
    if (body.factStatus !== "unchecked") throw new JudgmentConflict("文件结果不能把事实标成已核");
    if (body.valueStatus !== "incomplete_material") throw new JudgmentConflict("文件结果不能记成价值判断");
    if (!body.fileResult || body.fileResult.vendorReceipt !== false || body.fileResult.outputSha256 !== fileOutputSha256(body.fileResult)) {
      throw new JudgmentConflict("文件输出哈希无法重算");
    }
  }
  if (body.origin !== "model" && body.origin !== "deterministic" && body.origin !== "file") throw new JudgmentConflict("判断来源无法识别");
  if (body.selectionDecision) {
    if (body.selectionDecision.status !== "pending_review") throw new JudgmentConflict("选择决定只能待审");
    if (body.factStatus !== "unchecked" || body.releaseStatus !== "not_licensed" || body.valueStatus !== "incomplete_material") {
      throw new JudgmentConflict("选择决定不能升级事实、价值或许可");
    }
    if (body.selectionDecision.outputSha256 !== selectionOutputSha256(body.selectionDecision.item)) {
      throw new JudgmentConflict("选择决定输出哈希无法重算");
    }
    if (typeof body.selectionDecision.item.decision_rationale !== "string" || !body.selectionDecision.item.decision_rationale.trim()) {
      throw new JudgmentConflict("选择决定缺少理由");
    }
  }
}

async function writeJudgment(tx: Db, identity: JudgmentIdentity, body: JudgmentBody, recordedAt: string): Promise<JudgmentWrite> {
  databaseUrl();
  const canonical = canonicalIdentity(identity);
  assertBody(body, canonical);
  const id = sha256(stableJson(canonical));
  await tx`SELECT pg_advisory_xact_lock(${advisoryKey(`judgment\0${canonical.articleId}`)}::bigint)`;
  const [current] = await tx<{ evidence_hash: string; article_revision: number; body_text: string | null; quoted_text: string | null }[]>`
    SELECT evidence_hash, article_revision, body_text, quoted_text FROM own_evidence_versions
    WHERE article_id = ${canonical.articleId} ORDER BY version DESC LIMIT 1`;
  if (!current) throw new JudgmentConflict("没有持久证据，拒绝判断");
  if (current.evidence_hash !== canonical.evidenceHash || current.article_revision !== canonical.inputRevision) {
    throw new JudgmentConflict("判断必须绑定当前持久证据");
  }
  const derived = !current.body_text ? "missing_body" : current.quoted_text ? "complete" : "missing_quote";
  if (body.materialStatus !== derived) throw new JudgmentConflict(`持久证据是${derived}，不能写成${body.materialStatus}`);
  if (body.origin === "model") {
    if (!body.modelReceiptId) throw new JudgmentConflict("模型判断必须带可追溯回执");
    const [receipt] = await tx<{ id: number; model: string | null; status: string; subject: string | null; request: Record<string, unknown> | null; response: unknown }[]>`
      SELECT id, model, status, subject, request, response FROM receipts WHERE id = ${body.modelReceiptId}`;
    if (!receipt) throw new JudgmentConflict("模型回执不存在");
    if (receipt.status !== "received" && receipt.status !== "completed") throw new JudgmentConflict("模型回执尚未完成");
    if (!receipt.model || receipt.model !== canonical.modelVersion) throw new JudgmentConflict("模型判断的回执模型与 modelVersion 不一致");
    const request = receipt.request ?? {};
    const bound = receipt.subject === `article:${canonical.articleId}`
      && request.articleId === canonical.articleId
      && request.evidenceHash === canonical.evidenceHash
      && request.promptVersion === canonical.promptVersion;
    if (!bound) throw new JudgmentConflict("回执没有绑到这篇文章的当前证据");
    if (!canonical.promptVersion) throw new JudgmentConflict("模型判断必须带可追溯的提示词版本和模型版本");
    let parsed: ReturnType<typeof parseOwnModelOutput>;
    try {
      parsed = parseOwnModelOutput(receipt.response, {
        articleId: canonical.articleId, evidenceHash: canonical.evidenceHash, promptVersion: canonical.promptVersion,
      });
    } catch (error) {
      throw new JudgmentConflict(error instanceof Error ? error.message : String(error));
    }
    if (stableJson(parsed.output) !== stableJson(ownModelOutput(body))) throw new JudgmentConflict("回执不能背书另一份输出");
  }
  if (body.valueStatus === "reference_only") {
    if (!body.comparison || !body.comparison.algorithm.trim() || body.comparison.algorithm === "none") {
      throw new JudgmentConflict("reference_only 必须带可重算的对照算法");
    }
    const expected = sha256(stableJson({ algorithm: body.comparison.algorithm, evidenceHash: canonical.evidenceHash }));
    if (body.comparison.inputHash !== expected) throw new JudgmentConflict("对照输入哈希无法按算法重算");
  }
  if (body.factStatus === "checked") {
    if (body.origin === "model") throw new JudgmentConflict("模型判断不能把事实标成已核");
    const excerpt = body.factCheck?.sourceExcerpt ?? "";
    const inMaterial = excerpt.trim().length >= 4 && ((current.body_text ?? "").includes(excerpt) || (current.quoted_text ?? "").includes(excerpt));
    if (!body.factCheck || body.factCheck.by !== "human" || !body.factCheck.claim.trim() || !inMaterial) {
      throw new JudgmentConflict("事实已核必须能在持久正文或引用里找到来源摘录，并且由人核验");
    }
  }
  const [existing] = await tx<{
    id: string; stale: boolean; information_type_id: JudgmentBody["informationTypeId"]; content_line: JudgmentBody["contentLine"];
    material_status: JudgmentBody["materialStatus"]; fact_status: JudgmentBody["factStatus"]; value_status: JudgmentBody["valueStatus"];
    release_status: JudgmentBody["releaseStatus"]; origin: JudgmentBody["origin"]; reasons: string[];
    comparison: JudgmentBody["comparison"]; model_receipt_id: number | null;
  }[]>`SELECT id, stale, information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons,
      comparison, model_receipt_id
      FROM own_judgments WHERE id = ${id} FOR UPDATE`;
  if (existing) {
    if (stableJson(canonicalBody(bodyFromRow(existing))) !== stableJson(canonicalBody(body))) throw new JudgmentConflict(`同一判断身份出现不同结果：${id}`);
    return { id, identity: canonical, body, stale: existing.stale, idempotent: true };
  }
  await tx`UPDATE own_judgments SET stale = true
    WHERE article_id = ${canonical.articleId} AND ruleset_version = ${canonical.rulesetVersion}
      AND prompt_version = ${canonical.promptVersion} AND model_version = ${canonical.modelVersion}
      AND stale = false AND (input_revision <> ${canonical.inputRevision} OR evidence_hash <> ${canonical.evidenceHash})`;
  await tx`INSERT INTO own_judgments (
      id, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
      information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons, recorded_at,
      comparison, model_receipt_id)
    VALUES (${id}, ${canonical.articleId}, ${canonical.inputRevision}, ${canonical.evidenceHash}, ${canonical.rulesetVersion},
      ${canonical.promptVersion}, ${canonical.modelVersion}, ${body.informationTypeId}, ${body.contentLine},
      ${body.materialStatus}, ${body.factStatus}, ${body.valueStatus}, ${body.releaseStatus}, ${body.origin}, ${tx.json(body.reasons as never)}, ${recordedAt},
      ${judgmentComparison(body) ? tx.json(judgmentComparison(body) as never) : null}, ${body.modelReceiptId ?? null})`;
  return { id, identity: canonical, body, stale: false, idempotent: false };
}

async function reread(identity: JudgmentIdentity, body: JudgmentBody): Promise<JudgmentWrite> {
  const canonical = canonicalIdentity(identity);
  const [existing] = await sql<{
    id: string; stale: boolean; information_type_id: JudgmentBody["informationTypeId"]; content_line: JudgmentBody["contentLine"];
    material_status: JudgmentBody["materialStatus"]; fact_status: JudgmentBody["factStatus"]; value_status: JudgmentBody["valueStatus"];
    release_status: JudgmentBody["releaseStatus"]; origin: JudgmentBody["origin"]; reasons: string[];
    comparison: JudgmentBody["comparison"]; model_receipt_id: number | null;
  }[]>`SELECT id, stale, information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons,
      comparison, model_receipt_id
      FROM own_judgments
      WHERE article_id = ${canonical.articleId} AND input_revision = ${canonical.inputRevision}
        AND evidence_hash = ${canonical.evidenceHash} AND ruleset_version = ${canonical.rulesetVersion}
        AND prompt_version = ${canonical.promptVersion} AND model_version = ${canonical.modelVersion}`;
  if (!existing) throw new Error("唯一约束冲突后没有读到已有判断");
  if (stableJson(canonicalBody(bodyFromRow(existing))) !== stableJson(canonicalBody(body))) throw new JudgmentConflict(`同一判断身份出现不同结果：${existing.id}`);
  return { id: existing.id, identity: canonical, body, stale: existing.stale, idempotent: true };
}

/**
 * 某条绑定上当前仍有效的判断。规则不同是另一条绑定，不会被这里选中，也不会被证据更新误标失效以外的方式改掉。
 * 同一绑定若有多条未失效行，取最近写入的一条。
 */
export async function activeJudgment(
  articleId: string,
  binding: Pick<JudgmentIdentity, "rulesetVersion" | "promptVersion" | "modelVersion">,
): Promise<JudgmentWrite | null> {
  databaseUrl();
  const promptVersion = binding.promptVersion?.trim() ?? "";
  const modelVersion = binding.modelVersion?.trim() ?? "";
  const [row] = await sql<{
    id: string; stale: boolean; input_revision: number; evidence_hash: string; ruleset_version: string;
    prompt_version: string; model_version: string;
    information_type_id: JudgmentBody["informationTypeId"]; content_line: JudgmentBody["contentLine"];
    material_status: JudgmentBody["materialStatus"]; fact_status: JudgmentBody["factStatus"]; value_status: JudgmentBody["valueStatus"];
    release_status: JudgmentBody["releaseStatus"]; origin: JudgmentBody["origin"]; reasons: string[];
    comparison: JudgmentBody["comparison"]; model_receipt_id: number | null;
  }[]>`SELECT id, stale, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
      information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons,
      comparison, model_receipt_id
    FROM own_judgments
    WHERE article_id = ${articleId} AND stale = false AND ruleset_version = ${binding.rulesetVersion}
      AND prompt_version = ${promptVersion} AND model_version = ${modelVersion}
    ORDER BY created_at DESC LIMIT 1`;
  if (!row) return null;
  return {
    id: row.id,
    stale: row.stale,
    idempotent: true,
    identity: {
      articleId, inputRevision: row.input_revision, evidenceHash: row.evidence_hash,
      rulesetVersion: row.ruleset_version, promptVersion: row.prompt_version, modelVersion: row.model_version,
    },
    body: bodyFromRow(row),
  };
}

/** 正文归属结果写在已有证据表上。ready 只表示可以做特征提取，不评分、不入 worker 队列。 */
export async function recordBodyGate(articleId: string, gate: BodyGate): Promise<{ version: number; evidenceHash: string }> {
  databaseUrl();
  return sql.begin(async (tx) => {
    const [article] = await tx<{ revision: number; raw: unknown }[]>`SELECT revision, raw FROM articles WHERE id = ${articleId}`;
    if (!article) throw new Error("文章不存在");
    const [latest] = await tx<{ version: number; raw_file: Buffer | null; raw_identity: unknown }[]>`
      SELECT version, raw_file, raw_identity FROM own_evidence_versions WHERE article_id = ${articleId} ORDER BY version DESC LIMIT 1`;
    const version = (latest?.version ?? 0) + 1;
    const evidenceHash = cumulativeEvidenceHash({
      title: gate.title, raw: { gate: gate.reason, start: gate.start, end: gate.end }, bodyText: gate.sectionText, quotedText: null, xPost: null,
    });
    await tx`INSERT INTO own_evidence_versions
      (article_id, version, article_revision, raw, body_text, quoted_text, x_post, evidence_hash, raw_identity, raw_file, body_gate)
      VALUES (${articleId}, ${version}, ${article.revision}, ${article.raw === null ? null : tx.json(article.raw as never)},
        ${gate.queue === "ready_for_features" ? gate.sectionText : null}, null, null, ${evidenceHash},
        ${latest?.raw_identity ? tx.json(latest.raw_identity as never) : null}, ${latest?.raw_file ?? null}, ${tx.json(gate as never)})`;
    await tx`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL
      WHERE id = ${articleId} AND processing_state = 'new'`;
    return { version, evidenceHash };
  });
}

/** 追加一版证据，正文保持原样，补料单独放在 body_gate.supplements。文章修订号不动。旧判断因哈希变化失效。 */
export async function appendLocatedSupplement(articleId: string, supplement: {
  kind: string;
  sourceUrl: string;
  httpStatus: number;
  responseSha256: string;
  parts: Array<{ id: string; role: string; byteStart: number; byteEnd: number; text: string }>;
}): Promise<{ version: number; evidenceHash: string; previousHash: string; articleRevision: number; staled: number }> {
  databaseUrl();
  return sql.begin(async (tx) => {
    const [article] = await tx<{ title: string; revision: number }[]>`SELECT title, revision FROM articles WHERE id = ${articleId}`;
    if (!article) throw new Error("文章不存在");
    const [latest] = await tx<{
      version: number; evidence_hash: string; article_revision: number; body_text: string | null; quoted_text: string | null;
      x_post: unknown; raw_file: Buffer | null; raw_identity: unknown; body_gate: Record<string, unknown> | null;
    }[]>`SELECT version, evidence_hash, article_revision, body_text, quoted_text, x_post, raw_file, raw_identity, body_gate
      FROM own_evidence_versions WHERE article_id = ${articleId} ORDER BY version DESC LIMIT 1`;
    if (!latest) throw new Error("没有持久证据，不能补料");
    const version = latest.version + 1;
    const located = {
      kind: supplement.kind, sourceUrl: supplement.sourceUrl, httpStatus: supplement.httpStatus,
      responseSha256: supplement.responseSha256,
      parts: supplement.parts.map((part) => ({ id: part.id, role: part.role, text: part.text })),
    };
    const evidenceHash = cumulativeEvidenceHash({
      title: article.title,
      raw: { previousEvidenceHash: latest.evidence_hash, supplement: located },
      bodyText: latest.body_text, quotedText: latest.quoted_text, xPost: latest.x_post as never,
    });
    const gate = { ...(latest.body_gate ?? {}), supplements: [...((latest.body_gate?.supplements as unknown[]) ?? []), { ...supplement, mainBodyUnchanged: true }] };
    await tx`INSERT INTO own_evidence_versions
      (article_id, version, article_revision, body_text, quoted_text, x_post, evidence_hash, raw_identity, raw_file, body_gate)
      VALUES (${articleId}, ${version}, ${latest.article_revision}, ${latest.body_text}, ${latest.quoted_text},
        ${latest.x_post ? tx.json(latest.x_post as never) : null}, ${evidenceHash},
        ${latest.raw_identity ? tx.json(latest.raw_identity as never) : null}, ${latest.raw_file}, ${tx.json(gate as never)})`;
    const staled = await tx<{ id: string }[]>`UPDATE own_judgments SET stale = true
      WHERE article_id = ${articleId} AND stale = false AND evidence_hash <> ${evidenceHash}
      RETURNING id`;
    return { version, evidenceHash, previousHash: latest.evidence_hash, articleRevision: Number(latest.article_revision), staled: staled.length };
  });
}

/** 评分和抽取只读最新证据。文章列上留下的旧正文不能绕过这次显式撤回。身份键不在这里。 */
export async function materialForScoring(articleId: string): Promise<{ bodyText: string | null; quotedText: string | null; xPost: unknown; evidenceHash: string } | null> {
  databaseUrl();
  const [row] = await sql<{ body_text: string | null; quoted_text: string | null; x_post: unknown; evidence_hash: string }[]>`
    SELECT body_text, quoted_text, x_post, evidence_hash FROM own_evidence_versions
    WHERE article_id = ${articleId} ORDER BY version DESC LIMIT 1`;
  if (!row) return null;
  return { bodyText: row.body_text, quotedText: row.quoted_text, xPost: row.x_post, evidenceHash: row.evidence_hash };
}

export async function listFeatureQueue(): Promise<Array<{ articleId: string; url: string; title: string; version: number; evidenceHash: string; gate: BodyGate }>> {
  databaseUrl();
  const rows = await sql<{ article_id: string; url: string; title: string; version: number; evidence_hash: string; body_gate: BodyGate }[]>`
    SELECT a.id AS article_id, a.url, a.title, v.version, v.evidence_hash, v.body_gate
    FROM (
      SELECT DISTINCT ON (article_id) article_id, version, evidence_hash, body_gate
      FROM own_evidence_versions WHERE body_gate IS NOT NULL
      ORDER BY article_id, version DESC
    ) v JOIN articles a ON a.id = v.article_id
    WHERE v.body_gate->>'queue' = 'ready_for_features'
    ORDER BY a.source_id, a.url`;
  return rows.map((row) => ({ articleId: row.article_id, url: row.url, title: row.title, version: row.version, evidenceHash: row.evidence_hash, gate: row.body_gate }));
}

/** 接受一份已经填好的模型输出。不调用模型，不写分数。对不上当前证据哈希就拒绝。 */
export async function attachModelFile(item: ModelFileItem): Promise<{ version: number }> {
  databaseUrl();
  return sql.begin(async (tx) => {
    const [current] = await tx<{ version: number; evidence_hash: string; article_revision: number }[]>`
      SELECT version, evidence_hash, article_revision FROM own_evidence_versions
      WHERE article_id = ${item.articleId} ORDER BY version DESC LIMIT 1`;
    if (!current || current.evidence_hash !== item.evidenceHash) throw new ImportRejected("模型文件没有对上当前证据哈希");
    const version = current.version + 1;
    const payload = { modelFile: { promptVersion: item.promptVersion, modelVersion: item.modelVersion, inputHash: item.inputHash, costUsd: item.costUsd, output: item.output } };
    await tx`INSERT INTO own_evidence_versions
      (article_id, version, article_revision, body_text, evidence_hash, body_gate)
      VALUES (${item.articleId}, ${version}, ${current.article_revision}, null, ${current.evidence_hash}, ${tx.json(payload as never)})`;
    return { version };
  });
}

/** 只追加证据，不写判断、不排队。不读采集或模型开关。 */
export async function appendControlledEvidence(item: ControlledImportItem): Promise<EvidenceWrite> {
  databaseUrl();
  return sql.begin((tx) => writeEvidence(tx, item));
}

/** 正常重复调用是幂等的。哈希和修订必须等于当前持久证据，不能由调用方另造。并发插入若撞上唯一约束，再读已提交的行；理由不同则拒绝。 */
export async function recordJudgment(identity: JudgmentIdentity, body: JudgmentBody, recordedAt: string): Promise<JudgmentWrite> {
  databaseUrl();
  try {
    return await sql.begin((tx) => writeJudgment(tx, identity, body, recordedAt));
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    return reread(identity, body);
  }
}

function quoteFits(text: string | null, excerpt: string, start: number | null, end: number | null): boolean {
  if (!text || !text.includes(excerpt)) return false;
  if (start === null || end === null) return true;
  return text.slice(start, end) === excerpt;
}

/** 待审选择决定。原条目整份保存。不改同一篇文章上的语义 fileResult，也不升级事实或许可。 */
export async function recordSelectionDecision(item: Record<string, unknown> & {
  articleId: string; evidenceHash: string; evidenceVersion: number; inputRevision: number;
  rulesetVersion: string; promptVersion: string;
}, recordedAt: string): Promise<JudgmentWrite> {
  databaseUrl();
  const [semantic] = await sql<{ id: string; n: number }[]>`
    SELECT id, count(*) OVER ()::int AS n FROM own_judgments
    WHERE article_id = ${item.articleId} AND stale = false AND origin = 'file'
      AND evidence_hash = ${item.evidenceHash} AND input_revision = ${item.inputRevision}
      AND comparison ? 'fileResult'`;
  if (!semantic || semantic.n !== 1) throw new JudgmentConflict("选择决定必须绑到唯一的当前语义判断");
  const [evidence] = await sql<{ body_text: string | null; quoted_text: string | null }[]>`
    SELECT body_text, quoted_text FROM own_evidence_versions
    WHERE article_id = ${item.articleId} ORDER BY version DESC LIMIT 1`;
  const materialStatus = !evidence?.body_text ? "missing_body" as const : evidence.quoted_text ? "complete" as const : "missing_quote" as const;
  const record = {
    status: "pending_review" as const,
    outputSha256: selectionOutputSha256(item),
    item,
    boundSemanticJudgmentId: semantic.id,
  };
  return recordJudgment({
    articleId: item.articleId,
    inputRevision: item.inputRevision,
    evidenceHash: item.evidenceHash,
    rulesetVersion: item.rulesetVersion,
    promptVersion: item.promptVersion,
    modelVersion: "",
  }, {
    informationTypeId: null,
    contentLine: null,
    materialStatus,
    factStatus: "unchecked",
    valueStatus: "incomplete_material",
    releaseStatus: "not_licensed",
    origin: "deterministic",
    reasons: ["选择决定待审，事实未核，未许可"],
    modelReceiptId: null,
    selectionDecision: record,
  }, recordedAt);
}

export async function listPendingSelections(): Promise<Array<{
  id: string; articleId: string; evidenceHash: string; inputRevision: number; promptVersion: string;
  status: "pending_review"; outputSha256: string; boundSemanticJudgmentId: string; item: Record<string, unknown>;
}>> {
  databaseUrl();
  const rows = await sql<{
    id: string; article_id: string; evidence_hash: string; input_revision: number; prompt_version: string;
    decision: JudgmentBody["selectionDecision"];
  }[]>`SELECT id, article_id, evidence_hash, input_revision, prompt_version, comparison->'selectionDecision' AS decision
    FROM own_judgments WHERE stale = false AND comparison->'selectionDecision'->>'status' = 'pending_review'
    ORDER BY article_id, created_at`;
  return rows.flatMap((row) => row.decision ? [{
    id: row.id, articleId: row.article_id, evidenceHash: row.evidence_hash, inputRevision: Number(row.input_revision),
    promptVersion: row.prompt_version, status: "pending_review" as const, outputSha256: row.decision.outputSha256,
    boundSemanticJudgmentId: row.decision.boundSemanticJudgmentId, item: row.decision.item,
  }] : []);
}

/** 把一份文件推理记到当前证据上。不写外部回执，不把事实标成已核，不发放许可。 */
export async function recordFileResult(item: FileResultItem, recordedAt: string, options?: { write?: boolean }): Promise<JudgmentWrite & { fileReceipt: { kind: "file-output"; vendorReceipt: false; outputSha256: string } }> {
  databaseUrl();
  const [current] = await sql<{ version: number; evidence_hash: string; article_revision: number; body_text: string | null; quoted_text: string | null }[]>`
    SELECT version, evidence_hash, article_revision, body_text, quoted_text FROM own_evidence_versions
    WHERE article_id = ${item.articleId} ORDER BY version DESC LIMIT 1`;
  if (!current) throw new JudgmentConflict("没有持久证据，拒绝判断");
  if (current.evidence_hash !== item.evidenceHash || Number(current.article_revision) !== item.inputRevision || Number(current.version) !== item.evidenceVersion) {
    throw new JudgmentConflict("输入证据不是当前版本");
  }
  const quote = item.output.quoteLocation;
  if (!quoteFits(current.body_text, quote.excerpt, quote.start, quote.end) && !quoteFits(current.quoted_text, quote.excerpt, quote.start, quote.end)) {
    throw new JudgmentConflict("引文不在当前正文或引用里");
  }
  const derived = !current.body_text ? "missing_body" as const : current.quoted_text ? "complete" as const : "missing_quote" as const;
  const fileResult: FileResultRecord = {
    executionSource: item.executionSource,
    modelKnowledge: item.modelKnowledge,
    knownModel: item.knownModel,
    output: item.output,
    outputSha256: fileOutputSha256(fileOutputCanonical(item)),
    vendorReceipt: false,
  };
  if (options?.write === false) {
    return {
      id: "",
      identity: {
        articleId: item.articleId, inputRevision: item.inputRevision, evidenceHash: item.evidenceHash,
        rulesetVersion: item.rulesetVersion, promptVersion: item.promptVersion, modelVersion: fileExecutionIdentity(item.executionSource),
      },
      body: {
        informationTypeId: null, contentLine: null, materialStatus: derived, factStatus: "unchecked",
        valueStatus: "incomplete_material", releaseStatus: "not_licensed", origin: "file",
        reasons: ["文件结果，事实未核，未许可"], modelReceiptId: null, fileResult,
      },
      stale: false,
      idempotent: false,
      fileReceipt: { kind: "file-output", vendorReceipt: false, outputSha256: fileResult.outputSha256 },
    };
  }
  const judgment = await recordJudgment({
    articleId: item.articleId,
    inputRevision: item.inputRevision,
    evidenceHash: item.evidenceHash,
    rulesetVersion: item.rulesetVersion,
    promptVersion: item.promptVersion,
    modelVersion: fileExecutionIdentity(item.executionSource),
  }, {
    informationTypeId: null,
    contentLine: null,
    materialStatus: derived,
    factStatus: "unchecked",
    valueStatus: "incomplete_material",
    releaseStatus: "not_licensed",
    origin: "file",
    reasons: ["文件结果，事实未核，未许可"],
    modelReceiptId: null,
    fileResult,
  }, recordedAt);
  return { ...judgment, fileReceipt: { kind: "file-output", vendorReceipt: false, outputSha256: fileResult.outputSha256 } };
}

export interface ClosedLoop {
  evidence: EvidenceWrite;
  judgment: JudgmentWrite;
}

/** 一条事务：材料入库、追加证据版本、写自有判断。不调用 queueProcessing。 */
export async function commitControlledLoop(
  item: ControlledImportItem,
  body: JudgmentBody,
  recordedAt: string,
  binding: Pick<JudgmentIdentity, "rulesetVersion" | "promptVersion" | "modelVersion">,
): Promise<ClosedLoop> {
  databaseUrl();
  return sql.begin(async (tx) => {
    const evidence = await writeEvidence(tx, item);
    const judgment = await writeJudgment(tx, {
      articleId: evidence.articleId,
      inputRevision: evidence.articleRevision,
      evidenceHash: evidence.evidenceHash,
      rulesetVersion: binding.rulesetVersion,
      promptVersion: binding.promptVersion,
      modelVersion: binding.modelVersion,
    }, body, recordedAt);
    return { evidence, judgment };
  });
}
