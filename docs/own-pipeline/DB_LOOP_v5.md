# 数据库闭环 v5

日期：2026-11-18。这是新文件。`docs/own-pipeline/STEP0_v4.md` 不改。

本文件记录已经在临时库上跑过的导入、证据版本和自有判断。它不是筛选验收，也不是生产通过。

## 和 v4 的差别

v4 只证明了内存映射：上游修订不改 `articles.raw`，引用也不进 `article_revisions`。那是上游行为，不够作为原料完整性。

v5 在不改 `upsertMaterial` 的前提下加了追加表 `own_evidence_versions`：

- 第一版写下当时的 `raw`。
- 后补的正文、引用或另一份 raw 各插入新版本。
- 旧版本的 `raw` 列不做更新。
- 引用写在 `quoted_text`。不依赖 `x_post`，也不指望上游因此增加修订。
- 自有判断的 `evidence_hash` 用累计证据（每一份 raw、当前正文、当前引用、当前 xPost）。补料后哈希变化，旧判断标失效，旧行还在。

`articles.raw` 仍是首次插入的那一份。测试确认后来传入的另一份 raw 不会盖掉它，同时新 raw 出现在新的证据版本上。

## 幂等分成两层

| 层 | 相同身份、相同理由 | 相同身份、不同理由 | 空的 prompt/model |
| --- | --- | --- | --- |
| `recordJudgment` / `commitControlledLoop` | 返回已有行，`idempotent: true` | 抛 `JudgmentConflict`，不改旧行 | `null`、空白和 `""` 先收成 `""`，是同一身份 |
| 表上的 UNIQUE | 并发插入第二笔时数据库拒绝（23505）。应用捕到后再读；理由相同就返回旧行，不同就拒绝 | 同样拒绝覆盖 | 列是 `NOT NULL DEFAULT ''`，没有 NULL 第二条 |

「返回旧行」是应用层的正常重复。「唯一键拒绝」是并发兜底，不是让调用方每次都看到报错。

## 本环境

PostgreSQL 16，只监听本机。库名 `own_pipeline_test`，属主 `own_test`。地址 `postgres://own_test@127.0.0.1:5432/own_pipeline_test`。没有建 `aihot` 库，没有跑 Compose，没有 seed，没有启动 worker。`scripts/own-migrate.ts` 拒绝 `aihot` 和远程主机。

迁移第一次应用 94 个文件，含 `0170_own_judgments.sql` 与 `0171_own_evidence_versions.sql`。第二次输出 `database is up to date`，`applied: 0`。

## 已跑命令

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"
DATABASE_URL='postgres://own_test:own_test@127.0.0.1:5432/own_pipeline_test' \
  node scripts/own-migrate.ts   # 两次
node --import ./tests/standalone.ts --test --test-timeout=120000 tests/own-pipeline.standalone.test.ts
DATABASE_URL='postgres://own_test:own_test@127.0.0.1:5432/own_pipeline_test' \
  COLLECT_ENABLED=false MODEL_CALLS_ENABLED=false \
  OWN_PUBLIC_SAMPLES='/tmp/review-evidence/AIHOT_独立审阅资料/evidence/public_revealed_examples' \
  node --test-global-setup=tests/databases.ts --import ./tests/databases.ts \
  --test --test-concurrency=1 --test-timeout=120000 tests/own-pipeline.test.ts
node scripts/own-gap-check.ts "/tmp/review-evidence/AIHOT_独立审阅资料/evidence/public_revealed_examples"
```

离线测试 10 项通过。数据库测试 4 项通过：补料不覆盖原 raw、失败插入回滚失效标记、8 路并发仍是 1 行、三份已揭盲样本只记缺口。`tsc -p packages/backend` 与 `tsc -p tests` 通过。`node scripts/check-migrations.ts --base origin/main` 通过。`tests/architecture.test.ts` 16 项通过，新表的列被 `packages/backend/src/own-pipeline-store.ts` 用到。

## 三份已揭盲样本

只做缺口，`scored: false`，`holdout: false`。没有分数，没有信息类型。

| post_id | raw 字节 | SHA256 | 缺口 |
| --- | --- | --- | --- |
| 2117095432526700766 | 74262 | `3310e47ee85205900b84da7689fa3b66ba73e6ce78afcc5e1619b39c0c2191dc` | 正文待显式补入；引用在 record 里但 raw 导入未接上；raw 是搜索页快照；没有 x_post |
| 2120299157411790929 | 84820 | `00cc345d1a18da8e82101a8abba60a05edb0808bccecdbd155261df7202a2b28` | 正文待显式补入；quote 状态是 not_a_quote；搜索页快照；没有 x_post |
| 2120452474305904776 | 104588 | `8a7647e1c0b99c95e72ac255144e843715df080a6b88a72353ad762757250032` | 同上，引用不适用 |

库内测试把每份 raw 原样写入证据第 1 版，再显式补入 `root_text`（以及存在的引用）。第 1 版 raw 与 `articles.raw` 仍等于原件。判断的 `information_type_id` 为空，`release_status` 为 `not_licensed`，`analyses` 行数为 0。这三份不能进入以后的留出集。

## 全量 npm test

同一临时库上跑了 `npm test`：1178 项里 1152 通过、26 失败。失败全部是网页测试找不到 `apps/web/build/server/index.js`。本环境没有构建前端。其中本轮的数据库测试和离线身份测试是通过的，包括补料、回滚、并发和三份已揭盲样本。这 26 项不是本轮表结构引起的。没有因此去构建或启动网站。

## 还没有证明

- 筛选对不对。没有新留出口径下的打分。
- 模型单价和厂商实扣。本轮没有付费调用。
- 网页构建缺失，所以上面 26 项页面测试没有绿。
- 没有生产库，没有 private24，没有用户机器上的材料。
