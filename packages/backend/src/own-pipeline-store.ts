// 受控导入、证据版本和自有判断的数据库写入。不排队、不调用模型、不建源。
// 采集和模型开关只约束 CLI。这里不读那些开关，调用方要自己守住入口。
// 导入把 processing_state 收成 skipped，content.sweep 只捡 new，所以之后即使 worker 起来也不会把这些行入队。
import { identityKeyFor, upsertMaterial, type XPostData } from "./content/materials.ts";
import { sql, type Db } from "./db.ts";
import { sha256, stableJson } from "./lib/ids.ts";
import {
  ImportRejected,
  assertThrowawayDatabase,
  canonicalIdentity,
  cumulativeEvidenceHash,
  mapControlledImport,
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
  return { ...body, comparison: body.comparison ?? null, modelReceiptId: body.modelReceiptId ?? null };
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
  const fileSha256 = item.rawFileSha256 ?? (bytes ? sha256(bytes) : null);
  if (bytes && item.rawFileSha256 && item.rawFileSha256 !== sha256(bytes)) throw new ImportRejected("原件字节与声明的文件哈希不一致");
  const priorFile = versions.map((row) => row.raw_identity?.fileSha256).find((value) => value);
  if (fileSha256 && priorFile && priorFile !== fileSha256) throw new ImportRejected("原件文件哈希与已保存的审阅声明不一致");
  const rawIdentity = { fileSha256, canonicalSha256 };
  const [article] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${saved.articleId}`;
  const latest = versions.at(-1);
  // 缺省字段沿用当前一版（patch）。显式 null 清空。与当前快照不同才另记一版；完全相同则幂等。回到较早的另一份原件会另记一版，旧版仍留着。
  const bodyText = item.bodyText === undefined ? (latest?.body_text ?? null) : explicitText(item.bodyText);
  const quotedText = item.quotedText === undefined ? (latest?.quoted_text ?? null) : explicitText(item.quotedText);
  const xPost = item.xPost === undefined ? (latest?.x_post ?? null) : item.xPost;
  const evidenceHash = cumulativeEvidenceHash({ title: item.title, raw: item.raw, bodyText, quotedText, xPost });
  await tx`UPDATE articles SET raw = ${tx.json(item.raw as never)}
    WHERE id = ${saved.articleId} AND raw IS DISTINCT FROM ${tx.json(item.raw as never)}::jsonb`;
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
      idempotent: true, createdArticle: saved.created, revisedArticle: saved.revised, gaps: mapped.gaps,
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
    idempotent: false, createdArticle: saved.created, revisedArticle: saved.revised, gaps: mapped.gaps,
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
    comparison: row.comparison ?? null,
    modelReceiptId: row.model_receipt_id,
  };
}

function assertBody(body: JudgmentBody, identity: JudgmentIdentity): void {
  if (body.releaseStatus !== "not_licensed") throw new JudgmentConflict("判断不能发放发布许可");
  if (body.materialStatus !== "complete" && body.valueStatus !== "incomplete_material") {
    throw new JudgmentConflict("材料不完整时不能记成价值判断");
  }
  if (body.valueStatus === "reference_only") {
    if (!body.comparison || !body.comparison.algorithm.trim() || !/^[0-9a-f]{64}$/.test(body.comparison.inputHash)) {
      throw new JudgmentConflict("reference_only 必须带对照算法和输入哈希");
    }
  }
  if (body.origin === "model" && (!identity.promptVersion || !identity.modelVersion)) {
    throw new JudgmentConflict("模型判断必须带可追溯的提示词版本和模型版本");
  }
  if (body.origin === "model" && !(Number.isInteger(body.modelReceiptId) && (body.modelReceiptId ?? 0) > 0)) {
    throw new JudgmentConflict("模型判断必须带可追溯回执");
  }
  if (body.origin !== "model" && body.origin !== "deterministic") throw new JudgmentConflict("判断来源无法识别");
}

async function writeJudgment(tx: Db, identity: JudgmentIdentity, body: JudgmentBody, recordedAt: string): Promise<JudgmentWrite> {
  databaseUrl();
  const canonical = canonicalIdentity(identity);
  assertBody(body, canonical);
  const id = sha256(stableJson(canonical));
  await tx`SELECT pg_advisory_xact_lock(${advisoryKey(`judgment\0${canonical.articleId}`)}::bigint)`;
  const [current] = await tx<{ evidence_hash: string; article_revision: number }[]>`
    SELECT evidence_hash, article_revision FROM own_evidence_versions
    WHERE article_id = ${canonical.articleId} ORDER BY version DESC LIMIT 1`;
  if (!current) throw new JudgmentConflict("没有持久证据，拒绝判断");
  if (current.evidence_hash !== canonical.evidenceHash || current.article_revision !== canonical.inputRevision) {
    throw new JudgmentConflict("判断必须绑定当前持久证据");
  }
  if (body.origin === "model") {
    const [receipt] = await tx<{ id: number; model: string | null; status: string }[]>`
      SELECT id, model, status FROM receipts WHERE id = ${body.modelReceiptId!}`;
    if (!receipt || (receipt.status !== "received" && receipt.status !== "completed")) {
      throw new JudgmentConflict("模型判断的回执不存在或尚未完成");
    }
    if (!receipt.model || receipt.model !== canonical.modelVersion) {
      throw new JudgmentConflict("模型判断的回执模型与 modelVersion 不一致");
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
      ${body.comparison ? tx.json(body.comparison as never) : null}, ${body.modelReceiptId ?? null})`;
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
