// 自有资讯流程的第 0 步契约。未接入 worker、未建表、未改上游评分。
// 上游 articles / article_revisions / analyses 仍是材料与 AIHOT 编辑判断；
// 这里的记录只描述自有判断的身份、失效和导入映射，供离线测试锁定。
import { contentHash, identityKeyFor, type MaterialInput, type XPostData } from "../packages/backend/src/content/materials.ts";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";

/** 17 v2.3 的历史口径。转录用于追溯，不是已验收的生产线。 */
export const HISTORICAL_RULESET = "17-v2.3-historical-unaccepted";

/** 00 的两条内容线。它们是选题路由，不是上游 CATEGORIES。 */
export const CONTENT_LINES = [
  { id: "line1", label: "对齐线" },
  { id: "line2", label: "优势线" },
] as const;

export type ContentLine = (typeof CONTENT_LINES)[number]["id"];

/**
 * 17 §4.2 表的逐行转录。25 行 = 24 个具名类型 +「其他」。
 * 不写入 industry/taxonomy.ts 的 CATEGORIES，也不据此发放发布许可。
 * provisional：原文写明暂定或待确认。line2Points 只记录原文给出的另一个数。
 */
export const INFORMATION_TYPES = [
  { id: "oss-tool", label: "开源项目、工具、skill", points: 50, pointsStatus: "table" },
  { id: "tutorial", label: "教程、提示词、能照做的方法", points: 50, pointsStatus: "table" },
  { id: "reader-work", label: "读者向的工作", points: 45, pointsStatus: "table" },
  { id: "subscription-value", label: "订阅值不值、额度实测对比", points: 40, pointsStatus: "table" },
  { id: "monetization", label: "赚钱、变现", points: 40, pointsStatus: "provisional" },
  { id: "research-paper", label: "论文、研究成果", points: 38, pointsStatus: "table" },
  { id: "benchmark", label: "跑分、评测榜单", points: 30, pointsStatus: "table" },
  { id: "evidenced-leak", label: "有证据的爆料", points: 30, pointsStatus: "table" },
  { id: "hands-on", label: "实测、演示", points: 30, pointsStatus: "table" },
  { id: "cost-performance", label: "性价比", points: 25, pointsStatus: "table" },
  { id: "strong-opinion", label: "强观点", points: 25, pointsStatus: "provisional" },
  { id: "api-price", label: "API 公开单价、降价", points: 22, pointsStatus: "provisional" },
  { id: "minor-model-release", label: "新模型发布（非必发的）", points: 20, pointsStatus: "table" },
  { id: "product-update", label: "产品功能更新", points: 15, pointsStatus: "table" },
  { id: "plan-tweak", label: "官方套餐小调整", points: 15, pointsStatus: "table" },
  { id: "ordinary-opinion", label: "普通行业观点、访谈", points: 15, pointsStatus: "table" },
  { id: "personnel", label: "行业人事", points: 12, pointsStatus: "table" },
  { id: "hardware", label: "AI 硬件、芯片、算力", points: 12, pointsStatus: "provisional" },
  { id: "freebie", label: "限免、赠送、白嫖", points: 12, pointsStatus: "table" },
  { id: "policy", label: "政策、监管（非政治）", points: 12, pointsStatus: "table" },
  { id: "incident", label: "安全事件、事故", points: 10, pointsStatus: "table" },
  { id: "price-leak", label: "价格爆料", points: 6, pointsStatus: "table", line2Points: 40 },
  { id: "quota-reset", label: "日常额度重置", points: 4, pointsStatus: "table" },
  { id: "financing", label: "公司融资、营收、财报", points: 4, pointsStatus: "table" },
  { id: "other", label: "其他", points: 12, pointsStatus: "table" },
] as const;

export type InformationTypeId = (typeof INFORMATION_TYPES)[number]["id"];

/** 未核原规则前，不把信息类型提升成上游类别。 */
export const UPSTREAM_CATEGORY_PROMOTION = "refused" as const;

export function informationType(id: string): (typeof INFORMATION_TYPES)[number] | null {
  return INFORMATION_TYPES.find((row) => row.id === id) ?? null;
}

/** 历史分档只作对照。acceptedProductionLine 固定为 false：70/55/40 未经质量验收。 */
export function historicalBand(points: number | null): { band: "70+" | "55-69" | "40-54" | "<40" | "unscored"; acceptedProductionLine: false } {
  if (points === null || !Number.isFinite(points)) return { band: "unscored", acceptedProductionLine: false };
  if (points >= 70) return { band: "70+", acceptedProductionLine: false };
  if (points >= 55) return { band: "55-69", acceptedProductionLine: false };
  if (points >= 40) return { band: "40-54", acceptedProductionLine: false };
  return { band: "<40", acceptedProductionLine: false };
}

export interface JudgmentIdentity {
  articleId: string;
  inputRevision: number;
  evidenceHash: string;
  rulesetVersion: string;
  promptVersion: string | null;
  modelVersion: string | null;
}

export type MaterialStatus = "complete" | "missing_body" | "missing_quote" | "missing_article_body";
export type FactStatus = "unchecked" | "source_claim" | "checked";
export type ValueStatus = "incomplete_material" | "reference_only";
export type ReleaseStatus = "not_licensed";

export interface JudgmentBody {
  informationTypeId: InformationTypeId | null;
  contentLine: ContentLine | null;
  materialStatus: MaterialStatus;
  factStatus: FactStatus;
  valueStatus: ValueStatus;
  releaseStatus: ReleaseStatus;
  reasons: string[];
}

export interface JudgmentRow {
  id: string;
  identity: JudgmentIdentity;
  body: JudgmentBody;
  recordedAt: string;
  /** 同一绑定下被更新的修订或证据顶掉。行还在，只是不再作为该绑定的当前判断。 */
  stale: boolean;
}

function judgmentId(identity: JudgmentIdentity): string {
  return sha256(stableJson(identity));
}

function sameBinding(a: JudgmentIdentity, b: JudgmentIdentity): boolean {
  return a.articleId === b.articleId
    && a.rulesetVersion === b.rulesetVersion
    && a.promptVersion === b.promptVersion
    && a.modelVersion === b.modelVersion;
}

/**
 * 内存中的追加账本，键与将来的 own_judgments 唯一键相同。
 * 相同身份再次写入返回原行；同一绑定下修订或证据变化只把旧行标失效，不删除。
 * 规则、提示词或模型不同，是另一条绑定，不碰其他绑定和其他文章。
 */
export class JudgmentLedger {
  readonly rows: JudgmentRow[] = [];

  record(identity: JudgmentIdentity, body: JudgmentBody, recordedAt: string): { row: JudgmentRow; idempotent: boolean } {
    if (body.releaseStatus !== "not_licensed") throw new Error("判断不能发放发布许可");
    if (body.materialStatus !== "complete" && body.valueStatus !== "incomplete_material") {
      throw new Error("材料不完整时不能记成价值判断");
    }
    const id = judgmentId(identity);
    const existing = this.rows.find((row) => row.id === id);
    if (existing) {
      if (stableJson(existing.body) !== stableJson(body)) throw new Error(`同一判断身份出现不同结果：${id}`);
      return { row: existing, idempotent: true };
    }
    for (const row of this.rows) {
      if (row.stale || !sameBinding(row.identity, identity)) continue;
      if (row.identity.inputRevision !== identity.inputRevision || row.identity.evidenceHash !== identity.evidenceHash) row.stale = true;
    }
    const row: JudgmentRow = { id, identity, body, recordedAt, stale: false };
    this.rows.push(row);
    return { row, idempotent: false };
  }

  /** 按给定绑定把仍有效的行标失效。至少要指定一个字段，避免空条件扫掉全部。 */
  staleMatching(match: { articleId?: string; rulesetVersion?: string; promptVersion?: string | null; modelVersion?: string | null }): string[] {
    const keys = ["articleId", "rulesetVersion", "promptVersion", "modelVersion"] as const;
    if (!keys.some((key) => match[key] !== undefined)) throw new Error("失效条件不能为空");
    const ids: string[] = [];
    for (const row of this.rows) {
      if (row.stale) continue;
      if (match.articleId !== undefined && row.identity.articleId !== match.articleId) continue;
      if (match.rulesetVersion !== undefined && row.identity.rulesetVersion !== match.rulesetVersion) continue;
      if (match.promptVersion !== undefined && row.identity.promptVersion !== match.promptVersion) continue;
      if (match.modelVersion !== undefined && row.identity.modelVersion !== match.modelVersion) continue;
      row.stale = true;
      ids.push(row.id);
    }
    return ids;
  }

  current(articleId: string, binding: Pick<JudgmentIdentity, "rulesetVersion" | "promptVersion" | "modelVersion">): JudgmentRow | null {
    const hits = this.rows.filter((row) => !row.stale
      && row.identity.articleId === articleId
      && row.identity.rulesetVersion === binding.rulesetVersion
      && row.identity.promptVersion === binding.promptVersion
      && row.identity.modelVersion === binding.modelVersion);
    return hits.at(-1) ?? null;
  }
}

const RAW_TEXT_KEYS = new Set(["text", "root_text", "full_text", "body", "bodies", "paid_full_text"]);

function rawHasIgnoredText(raw: unknown): boolean {
  const stack: unknown[] = [raw];
  const seen = new Set<unknown>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    for (const [key, value] of Object.entries(cur)) {
      if (RAW_TEXT_KEYS.has(key) && typeof value === "string" && value.trim()) return true;
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return false;
}

function explicitText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export interface ControlledImportItem {
  sourceId: string;
  url: string;
  title: string;
  author?: string | null;
  publishedAt?: string | null;
  /** 原件原样保存。其中的正文、引用不会被读出来。 */
  raw: unknown;
  bodyText?: string | null;
  quotedText?: string | null;
  xPost?: XPostData | null;
}

export interface MappedMaterial {
  material: Pick<MaterialInput, "sourceId" | "url" | "title" | "author" | "raw" | "bodyText" | "xPost" | "via"> & { publishedAt: Date | null };
  identityKey: string;
  /** 上游修订哈希：标题、正文、摘要。不含 raw，不含引用。 */
  upstreamContentHash: string;
  /** 自有判断用的证据哈希：在上游哈希之外纳入引用和显式 xPost。 */
  evidenceHash: string;
  bodyText: string | null;
  quotedText: string | null;
  gaps: string[];
}

/**
 * 受控导入只做字段映射，不写库、不建源、不排队。
 * 正文和引用必须由调用方显式给出。raw 整包进入 material.raw，不提升为 body_text / x_post。
 */
export function mapControlledImport(item: ControlledImportItem): MappedMaterial {
  const bodyText = explicitText(item.bodyText);
  const quotedText = explicitText(item.quotedText);
  const gaps: string[] = [];
  if (!bodyText) gaps.push("missing_body");
  if (!quotedText) gaps.push("quote_absent");
  else gaps.push("quote_not_in_body_or_revision");
  if (!item.xPost) gaps.push("x_post_not_attached");
  if (rawHasIgnoredText(item.raw)) gaps.push("raw_text_not_promoted");
  const material = {
    sourceId: item.sourceId,
    url: item.url,
    title: item.title,
    author: item.author ?? null,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
    raw: item.raw,
    bodyText,
    xPost: item.xPost ?? null,
    via: "import" as const,
  };
  const upstreamContentHash = contentHash({ title: item.title, bodyText, excerpt: null });
  return {
    material,
    identityKey: identityKeyFor(material),
    upstreamContentHash,
    evidenceHash: sha256(stableJson({ upstreamContentHash, quotedText, xPost: item.xPost ?? null })),
    bodyText,
    quotedText,
    gaps,
  };
}

export type SwitchEffect = "network" | "model" | "local-delete" | "local-job" | "queue";

export interface SwitchAssessment {
  id: string;
  effect: SwitchEffect;
  /** worker 进程会注册它，与 web/api 是否启动无关。 */
  registeredWhenWorkerStarts: boolean;
  /** 本环境、本开关下，启动 worker 后会不会真正产生该效果。 */
  armed: boolean;
  gate: string;
}

function on(env: Record<string, string | undefined>, name: string): boolean {
  return env[name] === "true";
}

function present(env: Record<string, string | undefined>, name: string): boolean {
  return typeof env[name] === "string" && env[name] !== "";
}

/**
 * 外发与任务开关。只反映环境变量和 worker 是否启动，不连数据库。
 * notify_targets.enabled、凭据文件是第二道门，这里看不到，验证时要另查。
 */
export function assessSwitches(env: Record<string, string | undefined>, workerStarted: boolean): SwitchAssessment[] {
  const collect = on(env, "COLLECT_ENABLED");
  const models = on(env, "MODEL_CALLS_ENABLED");
  const feishuContent = on(env, "FEISHU_CONTENT_PUSH_ENABLED");
  const dingtalkContent = on(env, "DINGTALK_CONTENT_PUSH_ENABLED");
  const feishuInternal = on(env, "FEISHU_INTERNAL_ENABLED");
  const indexnow = on(env, "INDEXNOW_SUBMIT_ENABLED") && /^[0-9a-f]{32}$/.test(env.INDEXNOW_KEY ?? "");
  const baidu = on(env, "BAIDU_PUSH_ENABLED") && present(env, "BAIDU_PUSH_TOKEN");
  const dajiala = collect && present(env, "DAJIALA_KEY");
  const backup = ["DB_BACKUP_STORE_SECRET_ID", "DB_BACKUP_STORE_SECRET_KEY", "DB_BACKUP_STORE_BUCKET", "DB_BACKUP_STORE_REGION"]
    .every((name) => present(env, name));
  const row = (id: string, effect: SwitchEffect, registered: boolean, gateOpen: boolean, gate: string): SwitchAssessment => ({
    id, effect, registeredWhenWorkerStarts: registered, armed: workerStarted && registered && gateOpen, gate,
  });
  return [
    row("collect.fetch", "network", true, collect, "COLLECT_ENABLED===true 才注册 sources.* 与 fetch 队列"),
    row("collect.mp", "network", true, dajiala, "采集打开且 DAJIALA_KEY 非空才注册 sources.mp-reconcile"),
    row("model.calls", "model", true, models, "MODEL_CALLS_ENABLED===true 才允许 llm/embeddings 发出请求"),
    row("content.translate", "model", true, models, "cron 始终注册；模型阀关闭时调用在发出前抛错"),
    row("reports.compose", "model", true, models, "cron 始终注册；写日报会走模型"),
    row("events.digest", "model", true, models, "归组队列始终注册；摘要任务走模型"),
    row("notify.content.feishu", "network", true, feishuContent, "notify 队列始终注册；FEISHU_CONTENT_PUSH_ENABLED 与 notify_targets.enabled 都要开才发送"),
    row("notify.content.dingtalk", "network", true, dingtalkContent, "DINGTALK_CONTENT_PUSH_ENABLED 与目的地启用都要开才发送"),
    row("notify.ops", "network", true, feishuInternal, "ops.alerts / ops.digest / 周报在 FEISHU_INTERNAL_ENABLED 关闭时只记日志"),
    row("feedback.forward", "network", true, feishuInternal, "cron 始终注册；FEISHU_INTERNAL_ENABLED 关闭则不转发"),
    row("seo.indexnow", "network", true, indexnow, "cron 始终注册；INDEXNOW_SUBMIT_ENABLED 与 32 位 INDEXNOW_KEY 都在才提交"),
    row("seo.baidu-push", "network", true, baidu, "cron 始终注册；BAIDU_PUSH_ENABLED 与 BAIDU_PUSH_TOKEN 都在才提交"),
    row("ops.backup", "network", true, backup, "四个 DB_BACKUP_STORE_* 都在才注册并上传"),
    row("ops.retention", "local-delete", true, true, "cron 始终注册；worker 一跑就会按保留期删除本地行"),
    row("hot.rank", "local-job", true, true, "cron 始终注册；本地计算，不因关掉 web 而消失"),
    row("modules", "queue", true, false, "site/modules/server.ts 的 SERVER_MODULES 目前为空"),
  ];
}

export interface CostInput {
  service: string;
  unit: string;
  amount: number | null;
  currency: "USD" | "CNY" | null;
  basis: "code-comment" | "handoff-estimate" | "absent";
  source: string;
  note: string;
}

/** 只收录能指出处的数字。厂商实扣没有出处的保持 null。 */
export const COST_INPUTS: readonly CostInput[] = [
  {
    service: "socialdata",
    unit: "每 1000 个成功返回对象",
    amount: 0.2,
    currency: "USD",
    basis: "code-comment",
    source: "packages/backend/src/providers/socialdata.ts objectsCost",
    note: "代码内估算单价，本轮未对照厂商现行价目，也不是账单。",
  },
  {
    service: "jina",
    unit: "每 100 万 tokens",
    amount: 0.36,
    currency: "CNY",
    basis: "code-comment",
    source: "packages/backend/src/providers/jina.ts",
    note: "注释写约 ¥0.36/百万；没有 usage 头则不估算。本轮未对照厂商价目。",
  },
  {
    service: "dajiala.post_history",
    unit: "每次请求",
    amount: 0.14,
    currency: "CNY",
    basis: "code-comment",
    source: "packages/backend/src/providers/dajiala.ts 文件头",
    note: "注释单价。运行时另记响应里的 cost_money。本轮未调用、未对账。",
  },
  {
    service: "dajiala.article_detail",
    unit: "每次请求",
    amount: 0.03,
    currency: "CNY",
    basis: "code-comment",
    source: "packages/backend/src/providers/dajiala.ts 文件头",
    note: "注释单价。本轮未调用、未对账。",
  },
  {
    service: "llm.input",
    unit: "每百万输入 token",
    amount: null,
    currency: null,
    basis: "absent",
    source: "仓库无 service_prices 种子；site/models.ts 只有模型名",
    note: "无价格出处，留空。",
  },
  {
    service: "llm.output",
    unit: "每百万输出 token",
    amount: null,
    currency: null,
    basis: "absent",
    source: "仓库无输出单价",
    note: "无价格出处，留空。",
  },
  {
    service: "prior-api.estimate",
    unit: "此前项目累计估算",
    amount: 2.06,
    currency: "USD",
    basis: "handoff-estimate",
    source: "审阅包 evidence/intake/ROUND2_STATUS.json cost.now_estimated_usd",
    note: "同文件 vendor_actual_usd 为 null，cap 5。不是厂商实扣，也不能把 2.94 当可花余额。",
  },
];
