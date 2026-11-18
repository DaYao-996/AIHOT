// 受控导入、证据版本和自有判断的数据库写入。不排队、不调用模型、不建源。
import { upsertMaterial, type XPostData } from "./content/materials.ts";
import { sql, type Db } from "./db.ts";
import { sha256, stableJson } from "./lib/ids.ts";
import {
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

interface EvidenceVersionRow {
  version: number;
  raw: unknown;
  body_text: string | null;
  quoted_text: string | null;
  x_post: XPost | null;
  evidence_hash: string;
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

function lastText(versions: EvidenceVersionRow[], key: "body_text" | "quoted_text"): string | null {
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const value = versions[i]![key];
    if (value) return value;
  }
  return null;
}

function lastPost(versions: EvidenceVersionRow[]): XPost | null {
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    if (versions[i]!.x_post) return versions[i]!.x_post;
  }
  return null;
}

function sameRaw(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export async function writeEvidence(tx: Db, item: ControlledImportItem): Promise<EvidenceWrite> {
  databaseUrl();
  const mapped = mapControlledImport(item);
  await tx`SELECT pg_advisory_xact_lock(${advisoryKey(`import\0${item.sourceId}\0${item.url}`)}::bigint)`;
  const [source] = await tx<{ id: string }[]>`SELECT id FROM sources WHERE id = ${item.sourceId}`;
  if (!source) throw new Error("源不存在，拒绝自动建源");
  const saved = await upsertMaterial({
    sourceId: item.sourceId,
    url: item.url,
    title: item.title,
    author: item.author ?? null,
    publishedAt: mapped.material.publishedAt ?? undefined,
    raw: item.raw,
    ...(mapped.bodyText ? { bodyText: mapped.bodyText, bodyStatus: "ok" as const } : {}),
    ...(item.xPost ? { xPost: item.xPost } : {}),
    via: "import",
  }, tx);
  await tx`SELECT pg_advisory_xact_lock(${advisoryKey(`judgment\0${saved.articleId}`)}::bigint)`;
  const versions = await tx<EvidenceVersionRow[]>`
    SELECT version, raw, body_text, quoted_text, x_post, evidence_hash
    FROM own_evidence_versions WHERE article_id = ${saved.articleId} ORDER BY version FOR UPDATE`;
  const [article] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${saved.articleId}`;
  const keptRaws = versions.filter((row) => row.raw !== null).map((row) => row.raw);
  const rawIsNew = !keptRaws.some((raw) => sameRaw(raw, item.raw));
  const rawVersions = rawIsNew ? [...keptRaws, item.raw] : keptRaws;
  const bodyText = mapped.bodyText ?? lastText(versions, "body_text");
  const quotedText = mapped.quotedText ?? lastText(versions, "quoted_text");
  const xPost = item.xPost === undefined ? lastPost(versions) : item.xPost;
  const evidenceHash = cumulativeEvidenceHash({ rawVersions, bodyText, quotedText, xPost });
  const latest = versions.at(-1);
  if (latest && latest.evidence_hash === evidenceHash) {
    return {
      articleId: saved.articleId, articleRevision: article!.revision, evidenceVersion: latest.version, evidenceHash,
      idempotent: true, createdArticle: saved.created, revisedArticle: saved.revised, gaps: mapped.gaps,
    };
  }
  const version = (latest?.version ?? 0) + 1;
  await tx`
    INSERT INTO own_evidence_versions (article_id, version, article_revision, raw, body_text, quoted_text, x_post, evidence_hash)
    VALUES (${saved.articleId}, ${version}, ${article!.revision}, ${rawIsNew ? tx.json(item.raw as never) : null},
            ${bodyText}, ${quotedText}, ${xPost ? tx.json(xPost as never) : null}, ${evidenceHash})`;
  await tx`UPDATE own_judgments SET stale = true
    WHERE article_id = ${saved.articleId} AND stale = false AND evidence_hash <> ${evidenceHash}`;
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
  const [existing] = await tx<{
    id: string; stale: boolean; information_type_id: JudgmentBody["informationTypeId"]; content_line: JudgmentBody["contentLine"];
    material_status: JudgmentBody["materialStatus"]; fact_status: JudgmentBody["factStatus"]; value_status: JudgmentBody["valueStatus"];
    release_status: JudgmentBody["releaseStatus"]; origin: JudgmentBody["origin"]; reasons: string[];
  }[]>`SELECT id, stale, information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons
      FROM own_judgments WHERE id = ${id} FOR UPDATE`;
  if (existing) {
    if (stableJson(bodyFromRow(existing)) !== stableJson(body)) throw new JudgmentConflict(`同一判断身份出现不同结果：${id}`);
    return { id, identity: canonical, body, stale: existing.stale, idempotent: true };
  }
  await tx`UPDATE own_judgments SET stale = true
    WHERE article_id = ${canonical.articleId} AND ruleset_version = ${canonical.rulesetVersion}
      AND prompt_version = ${canonical.promptVersion} AND model_version = ${canonical.modelVersion}
      AND stale = false AND (input_revision <> ${canonical.inputRevision} OR evidence_hash <> ${canonical.evidenceHash})`;
  await tx`INSERT INTO own_judgments (
      id, article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version,
      information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons, recorded_at)
    VALUES (${id}, ${canonical.articleId}, ${canonical.inputRevision}, ${canonical.evidenceHash}, ${canonical.rulesetVersion},
      ${canonical.promptVersion}, ${canonical.modelVersion}, ${body.informationTypeId}, ${body.contentLine},
      ${body.materialStatus}, ${body.factStatus}, ${body.valueStatus}, ${body.releaseStatus}, ${body.origin}, ${tx.json(body.reasons as never)}, ${recordedAt})`;
  return { id, identity: canonical, body, stale: false, idempotent: false };
}

async function reread(identity: JudgmentIdentity, body: JudgmentBody): Promise<JudgmentWrite> {
  const canonical = canonicalIdentity(identity);
  const [existing] = await sql<{
    id: string; stale: boolean; information_type_id: JudgmentBody["informationTypeId"]; content_line: JudgmentBody["contentLine"];
    material_status: JudgmentBody["materialStatus"]; fact_status: JudgmentBody["factStatus"]; value_status: JudgmentBody["valueStatus"];
    release_status: JudgmentBody["releaseStatus"]; origin: JudgmentBody["origin"]; reasons: string[];
  }[]>`SELECT id, stale, information_type_id, content_line, material_status, fact_status, value_status, release_status, origin, reasons
      FROM own_judgments
      WHERE article_id = ${canonical.articleId} AND input_revision = ${canonical.inputRevision}
        AND evidence_hash = ${canonical.evidenceHash} AND ruleset_version = ${canonical.rulesetVersion}
        AND prompt_version = ${canonical.promptVersion} AND model_version = ${canonical.modelVersion}`;
  if (!existing) throw new Error("唯一约束冲突后没有读到已有判断");
  if (stableJson(bodyFromRow(existing)) !== stableJson(body)) throw new JudgmentConflict(`同一判断身份出现不同结果：${existing.id}`);
  return { id: existing.id, identity: canonical, body, stale: existing.stale, idempotent: true };
}

/** 只追加证据，不写判断、不排队。 */
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
