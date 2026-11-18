# 自有资讯流程第 0 步 v4

日期：2026-11-18。这是新文件。PLAN_v3、审阅 ZIP 和 17 / 00 / 11 的原文都没有被覆盖。

本文是可审设计和本轮离线证据，不是功能验收，也不是生产通过。80% 观察线、A–F、70/55/40 都没有被当成生产线。49 仍是包编号；已揭盲的 12 例只作调试。

## 推荐实现

自有判断不写入 `analyses`，也不从公开 all 取原料。

`analyses` 的 `selected`、`score`、`category` 会进入 `publications`。`publishArticle` 在条目首次变成精选、可见性为 public、且不是回填时，会把 `notifySelected` 放进队列（`packages/backend/src/publication/publish.ts` 约 422–425 行）。公开浏览下限在 `industry/selection.ts` 的 `browseFloor: 40`，只约束展示。把自有分数写进这张表，会让公开口味和通知队列碰到原料判断。

因此：

| 对象 | 决定 |
| --- | --- |
| 材料 | 继续走 `upsertMaterial`。身份、修订、时间线都由它决定。 |
| 上游编辑判断 | 保持 `analyses`。需要上游分析链的源，参与模式用 `editorial`。本轮不把任何源改成 editorial，也不调用 `queueProcessing`。 |
| 自有判断 | 新表 `own_judgments`（`database/migrations/0170_own_judgments.sql`）。追加写入。同一身份冲突即拒绝，不覆盖。 |
| 归组 | 上游 pg-boss 与 `groupArticle` 保留。自有判断不另建一套归组。 |
| 分类 | 不扩展 `CATEGORIES`。信息类型存在自有字段 `information_type_id`。 |
| 导入 | 一次性本地映射，不启临时公网 API。本轮只做纯函数，不写库。 |
| 展示门槛 | 不改 `browseFloor` 和 T 档。 |

`isolated` 不能当主路径。默认队列会跳过分析，归组消费者也会在执行前返回 skipped。见下方核验。

## 判断记录

一条当前判断的身份是：

`article_id + input_revision + evidence_hash + ruleset_version + prompt_version + model_version`

- `input_revision` 对应 `articles.revision` / `article_revisions`。
- `evidence_hash` 覆盖真正参与判断的正文、引用和显式 `xPost`。上游 `contentHash` 只含标题、正文、摘要，所以只改引用不会产生新修订。自有哈希把引用算进去。
- `ruleset_version` 本轮固定为 `17-v2.3-historical-unaccepted`。这是历史口径的名字，不是验收戳。
- `prompt_version` 沿用上游 `name@hash`。本轮在钉住提交上读到：`prefilter@20eab36cc7`、`selection-score@e55fa3b5de`、`structure@81c160f45a`、`understand@6e4c8d3d3e`。规则函数判断的 `prompt_version` 和 `model_version` 为空。
- 模型原输出以后放在理由和证据旁。本轮没有调用模型，没有原输出。

四个状态分开，不能合成一列：

| 状态 | 本轮允许的值 |
| --- | --- |
| 材料 | `complete`、`missing_body`、`missing_quote`、`missing_article_body` |
| 事实 | `unchecked`、`source_claim`、`checked` |
| 价值 | `incomplete_material`、`reference_only` |
| 发布 | 只有 `not_licensed` |

材料不是 `complete` 时，价值只能是 `incomplete_material`。缺正文不能记成低价值。`reference_only` 只表示对照分档，不表示该发。表约束和 `JudgmentLedger.record` 都拒绝发放发布许可。历史分档函数对 80 分也返回 `acceptedProductionLine: false`。

### 失效与幂等

账本在 `site/own-pipeline.ts` 的 `JudgmentLedger`。表的唯一键与它相同，并使用 `UNIQUE NULLS NOT DISTINCT`，避免空的提示词或模型版本被 PostgreSQL 当成不同的行。

- 同一身份再写一次：返回原行，不新增。
- 同一身份写出不同理由：拒绝，原行保持。
- 同一篇文章、同一规则、同一提示词、同一模型下，修订号或证据哈希变了：新行追加，旧行 `stale=true`，旧行不删除。
- 只改模型版本：旧模型那一行仍是该模型绑定下的当前判断。
- 只改规则版本：要用 `staleMatching` 把旧规则绑定标失效；其他文章、其他模型不受影响。
- 空的失效条件直接拒绝，避免一次扫掉全部记录。

重算范围就是被标失效的那些绑定。不因一条规则变化重跑全部文章，也不删原证据。

表还没有在数据库里执行。内存账本的行为由 `tests/own-pipeline.standalone.test.ts` 锁定。

## 导入与存储

受控入口是 `mapControlledImport`。它不建源、不写库、不排队、不访问网络。

调用方必须已经有源，并显式给出 `bodyText`、`quotedText` 或完整 `xPost`。`raw` 原样放进 `material.raw`。原件里的 `root_text`、`quote.text`、`bodies.paid_full_text` 不会被提升。

这和上游存储一致，本轮对照过源码：

- 首次插入把 `raw` 和 `body_text` 写成不同的列（`packages/backend/src/content/materials.ts` 的 INSERT 列清单）。
- 内容变化时的修订赋值更新标题、正文、`x_post`，赋值片段里没有 `raw`。
- `article_revisions` 只有 `title` 和 `body_text`，没有引用列。引用只可能在 `x_post` 里，而且必须调用方传入 `xPost`。
- `ingestItems` 只提交标题、链接和 `raw`。新建未知源时参与模式是 `isolated`（`packages/backend/src/ingest/items.ts`）。所以现成的 HTTP 导入既不映射正文，也不会进入 editorial 分析。本轮不开放这个 HTTP 入口。

只改 `raw` 不改变上游内容哈希，也不改变自有证据哈希。判断看的是显式正文和引用；原件整包还在 `raw` 里，但没有被当成已经接通的正文。

公开调试样本 `2117095432526700766`（已揭盲，不是新留出）实测：

- `raw.json` 74262 字节，SHA256 `3310e47ee85205900b84da7689fa3b66ba73e6ce78afcc5e1619b39c0c2191dc`，与该样本 `record.json` 里的 `source.raw_sha256` 一致。
- `record.root_text` 247 字，`quote.text` 519 字。
- 只把 `raw.json` 交给映射函数：身份 `x:2117095432526700766`，`bodyText`、`quotedText`、`xPost` 都是 null，缺口为 `missing_body`、`quote_absent`、`x_post_not_attached`、`raw_text_not_promoted`。
- 再显式传入正文和引用后，正文进入映射，引用仍不进入 `xPost`，缺口保留 `quote_not_in_body_or_revision`。上游内容哈希因此变化。

没有把这条样本写入数据库，也没有用它重算路由。

## 分类

00 的两条线是选题路由：`line1` 对齐线，`line2` 优势线。它们不是类别。

17 §4.2 的表有 25 行：24 个具名信息类型加「其他」。上游 `CATEGORIES` 是 6 个，`CATEGORY_TAGS` 是 13 个，`ITEM_TYPES` 是 7 个。没有任何一份是可以保送的「24 类」。信息类型 id 与 `CATEGORIES.key` 不相交；原先容易撞名的「论文」用了 `research-paper`，没有占用上游的 `paper`。

`UPSTREAM_CATEGORY_PROMOTION` 固定为 `refused`。分数仍按原文转录，其中赚钱/变现、强观点、API 单价、AI 硬件标为 `provisional`。价格爆料的表分是 6，原文另写线 2 为 40，只记在 `line2Points`，不自动选线。

帖型 L1/L2 本轮没有转录成枚举。未逐条核对「算什么 / 不算什么」之前，不把 25 行写进网址类别。

## 已独立核验的路径

下列都是在钉住提交上读源码，并用测试重新核对关键语句。不是运行中的生产观察。

| 风险 | 核验结果 |
| --- | --- |
| isolated 跳过分析 | `content.ts` 里非 editorial 且没有 `attemptTag` 时，进入 `group` 且 `signalOnly: true`，不进 `analyze`。 |
| 带 attemptTag 也跳过分析 | `processRevision` 先判断参与模式，非 editorial 就 `settleNonEditorial` 并返回 `skipped`。入队不等于执行了分析。 |
| isolated 连归组也跳过 | `events.ts` 的消费者在 `signalOnly` 且 `needsGrouping` 为假时直接 `skipped`。`needsGrouping` 对 isolated 恒为 false，对 hot_signal 只在非历史材料上为 true，对 editorial 还要 `relevance === "pass"`。测试把这三种模式都跑过。 |
| 直接调用 `groupArticle` | `group.ts` 对非 editorial 会进 `groupSignal`，那不是默认队列。默认路径到不了那里。 |
| BLOCK | `runAnalysis` 在预筛标签仍是 BLOCK 时立刻返回，`scores`、`writing`、`structure` 都是 null。材料缺失时，模型给出的 BLOCK 会被改成 UNKNOWN，不走这个截断。完全没有正文、摘要、帖子和引用时，`awaitsMaterial` 在付费步骤之前返回。测试调用了这两个函数。 |
| 关 web/api 不关外发 | `apps/worker/src/main.ts` 始终注册分析、归组、通知、发布队列；只有 `COLLECT_ENABLED===true` 才注册采集。`schedules.ts` 里翻译、日报、热榜、保留期删除、IndexNow、百度、告警、反馈转发都不看 web 是否启动。 |
| 开关只认 `true` | `COLLECT_ENABLED=TRUE` 在评估函数里仍是关。与 `config.ts` 的 `bool` 一致。 |
| 内容推送 | 队列会注册。`pushEnabled` 在本测试进程里对飞书和钉钉都是 false（`tests/setup.ts` 把飞书内容推送写成 false）。目的地表 `notify_targets.enabled` 是第二道门，本轮没有数据库，没有查表。 |
| 演示源 | `docker-compose.yml` 的 setup 是 `migrate` 接着 `seed`。本轮没有运行 compose。 |
| X 首轮 | `readXSearch` 没有水位时读完一页就停；空页或没有下一页也停。积压有页数、条数和 3 天期限。这只说明进度框架不等于窗口已完整，本轮没有抓取。 |

## 外发、任务、模块

权威清单是 `assessSwitches`。worker 没启动时，每一项 `armed` 都是 false。worker 启动且环境变量全空时：保留期删除和热榜计算会武装，采集、模型、SEO、内容推送、运维告警不会。

| id | worker 会注册 | 空环境启动 worker 后会不会动手 | 门 |
| --- | --- | --- | --- |
| collect.fetch | 会 | 不会 | `COLLECT_ENABLED===true` |
| collect.mp | 会 | 不会 | 采集打开且 `DAJIALA_KEY` 非空 |
| model.calls / content.translate / reports.compose / events.digest | 会 | 不会发模型请求 | `MODEL_CALLS_ENABLED===true`。关阀时请求在 `llm.ts` 抛错前不会发出 |
| notify.content.feishu / dingtalk | 会 | 不会 | 对应 `*_CONTENT_PUSH_ENABLED===true`，并且目的地行启用 |
| notify.ops / feedback.forward | 会 | 不会 | `FEISHU_INTERNAL_ENABLED===true` |
| seo.indexnow | 会 | 不会 | 开关为 true 且 `INDEXNOW_KEY` 为 32 位十六进制 |
| seo.baidu-push | 会 | 不会 | 开关为 true 且 `BAIDU_PUSH_TOKEN` 非空 |
| ops.backup | 会 | 不会 | 四个 `DB_BACKUP_STORE_*` 都有值 |
| ops.retention | 会 | 会删本地过期行 | 没有外发开关。不要对含有需保留原件的库启动 worker |
| hot.rank | 会 | 会做本地计算 | 不访问公网，但也不因关掉网站而消失 |
| modules | 会挂上模块队列 | 不会 | `SERVER_MODULES` 现为空数组 |

凭据文件是另一条读取路径。本评估只看传入的环境变量。验证方法就是跑 `assessSwitches(env, workerStarted)`，再对钉住源码做本测试里的语句核对。不要靠「没启动网站」推断后台安静。

本轮环境没有把上述开关设为 `true`，没有启动 worker、api、web。

## 成本输入

无厂商账单的不填金额。代码注释里的单价只说明程序会怎么估算，本轮没有对照现行价目，也没有发起调用。

| 服务 | 数量 | 币种 | 依据 |
| --- | --- | --- | --- |
| SocialData | 0.20 / 1000 个成功返回对象 | USD | `socialdata.ts` 的 `objectsCost`，basis 为 estimated |
| Jina | 0.36 / 100 万 tokens | CNY | `jina.ts` 注释；没有 usage 头就不估 |
| 极致了 post_history | 0.14 / 次 | CNY | `dajiala.ts` 文件头注释 |
| 极致了 article_detail | 0.03 / 次 | CNY | 同上 |
| 模型输入 | 空 | 空 | 仓库没有 `service_prices` 种子，`site/models.ts` 只有模型名 |
| 模型输出 | 空 | 空 | 无出处 |
| 此前 API 估算 | 2.06，上限 5 | USD | 审阅包 `ROUND2_STATUS.json` 的 `cost`。同文件 `vendor_actual_usd` 为 null。2.94 不是可花余额 |

订阅额度和 API 费用分开。本轮 API 花费为 0。

## 本轮命令与结果

Node 用 nvm 安装并运行 `v24.22.2`（仓库要求 `>=24.22.1`）。依赖是 `npm ci`，291 个包，没有改锁文件。没有调用采集或模型 API。

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"
node --import ./tests/standalone.ts --test --test-timeout=120000 tests/own-pipeline.standalone.test.ts
npx tsc -p tests --pretty false --noEmit
npx tsc -p site --pretty false --noEmit
node scripts/check-migrations.ts --base HEAD
```

测试 7 项全部通过。`tsc -p tests` 与 `tsc -p site` 通过。迁移检查通过，且 `migrationPlan` 把 `0170` 判为单条在线语句。

没有跑完整 `npm test`（会建库并可能跑示例行业的集成测试）。没有跑 `npm run build -w @aihot/web`。没有启动网站，所以也没有跑 `scripts/smoke.ts`。

公开样本映射用的是审阅 ZIP 解压后的本地文件，命令在本环境执行，输出已写入上面「导入与存储」。ZIP 自身 `VERIFY_BUNDLE.py` 为 PASS。样本不进入仓库。

## 未证事项

- `0170` 没有在 PostgreSQL 执行。本环境没有可用的数据库服务。
- `upsertMaterial` 的事务、并发和修订行为没有在本轮打到数据库。源码和纯函数只证明映射不会把 raw 当成正文。
- `notify_targets` 里是否已有启用行，没有查。
- 模型真实单价、SocialData / Jina / 极致了的现行价目，没有厂商凭证。
- 筛选是否选得对，没有新留出，也没有重放已揭盲样本的路由。
- 窗口是否零漏、归组是否正确、连续运行，都没有测。
- `origin/main` 仍是 `cb5d4e5`。本分支包含那之后的 40 个上游提交，因为工作根是钉住提交。不要把这 40 个提交理解成了本轮的业务改动。

## 下一步

不需要再选存储方案。按下面做，仍不启生产、不抓公网、不调用付费 API。

1. 只在名字以 `_test` 结尾的本地库执行 `npm run db:migrate`。不要跑 `scripts/seed.ts`，不要用 compose 的 setup。
2. 在该库插入一条合成源和一条合成材料，调用现成的 `upsertMaterial`：断言 `raw` 与 `body_text` 分离；只改 raw 的再次写入不增加 `article_revisions`；显式 `xPost.quoted` 才出现在 `x_post`。不要调用 `queueProcessing`。
3. 向 `own_judgments` 写入同一身份两次，第二次必须因唯一键失败；再写新修订，旧行还在且可标 `stale`。用空的 `prompt_version` 确认 `NULLS NOT DISTINCT` 不会插进第二行。
4. 三个已揭盲公开样本只输出缺口计数（正文、引用、xPost）。不打分，不把它们算进新留出。
5. 写新留出之前，先把口径冻结成一份新文件：硬错误、正例分母、弃权、缺正文、未核事实、低价值、发布许可各自一列。80% 仍不是验收线。
6. 有厂商价目或账单之前，不填模型单价，也不要消费那 2.94 的算术剩余。
