# 导入绑定 v8

日期：2026-11-18。新文件。不改 v1–v7 的原文。

## 当前证据

权威哈希是 `cumulativeEvidenceHash` 的当前快照：标题、这一次的 raw、正文、引用、xPost。历史里出现过的 raw 集合不进哈希。`mapControlledImport(...).evidenceHash` 调用同一函数。上游内容哈希只描述 articles 的标题和正文，不能拿去 `recordJudgment`。

`rawFileSha256` 是原始文件字节的 SHA256。`rawCanonicalSha256` 是 `sha256(stableJson(raw))`。`articles.raw` 和证据表的 `raw` 是 jsonb 查询副本，不是文件字节。字节只在调用方给出 `rawFileBase64` 时写入 `own_evidence_versions.raw_file`（bytea）。旧字段名 `rawSha256` 不再接受。

## patch 和显式 null

字段缺省沿用当前一版。`quotedText: null` 和 `xPost: null` 清空当前值并产生新哈希。完全相同的当前快照且文章修订号没变，是幂等，不另起版本。回到较早的另一份 raw 会另记一版，并把仍指向旧快照的判断标失效。每一版都留下当次 raw，不覆盖更早的版本。

标题变化或补上 `publishedAt` 会推进 `articles.revision`。证据版本写下这个新修订号。判断必须在同一事务里绑当前证据行；对不上就整笔回滚。CLI 不写判断行。

## 判断

未评分不插入 `own_judgments`。`reference_only` 必须带 `comparison.algorithm` 和 64 位 `comparison.inputHash`。`origin=model` 必须有非空提示词版本、模型版本，以及 `receipts` 里一条状态为 received 或 completed、且 `model` 等于 `modelVersion` 的回执。版本字符串不能代替回执。

同一文章、同一规则集、提示词和模型上，当前判断是 `stale = false` 的那一行，由 `activeJudgment` 读取。别的规则集是另一条绑定，证据变化只让修订或哈希已经对不上的行失效。

## 调用边界

`COLLECT_ENABLED` 和 `MODEL_CALLS_ENABLED` 只约束 `scripts/own-import.ts`。`appendControlledEvidence` 不读这些开关。导入把 `processing_state` 收成 `skipped`。`content.sweep` 只捡 `new` 且创建超过 3 分钟的行。导入行不会因为后来启动 worker 就被这条扫进队列。这不是全局门禁。

## 身份

已有同一来源、同一 URL 的文章时，继续用它的 `identity_key`。省略 xPost 不另开 `url:` 行。已绑定的 `x:` 身份若这次带了另一个 tweetId，拒绝。不改采集用的 `identityKeyFor`。
