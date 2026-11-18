# 一次性导入与证据绑定 v6

日期：2026-11-18。新文件。v4、v5 和评估口径 v1 不改。

## 入口

支持的运行方式是 `scripts/own-import.ts`，不是 worker。

```bash
node scripts/own-import.ts --file items.json --dry-run
node scripts/own-import.ts --file items.json
node scripts/own-safety-check.ts
```

命令会：

- 拒绝未知字段、非 http(s) 链接、对不上的 `rawSha256`、不存在的源。
- `rawSha256` 是 `sha256(stableJson(raw))`。声明了就必须一致。输出里带回这个哈希。
- 正文、引用、`xPost` 只使用显式字段。raw 里的文字不会被提升。
- 追加 `own_evidence_versions`。重复运行计为 `idempotent`，不覆盖第一版 raw。
- 没有显式正文时不写 `own_judgments`。不评分，`valueJudgment` 为 false。
- 不调用 `queueProcessing`，不导入 worker。投影行数和投递行数分开打印。有投影也不等于发出消息。

`scripts/own-safety-check.ts` 读取当前环境。外发或模型开关为 `true` 时退出码是 1，导入命令同样拒绝执行。worker 没启动时，保留期删除不会跑。

## 判断必须对上当前证据

`recordJudgment` 在锁内读取 `own_evidence_versions` 的最新一行。传入的 `evidenceHash` 或 `inputRevision` 与该行不一致就拒绝，不插入。伪造哈希和补料前的旧哈希都走这条拒绝。

补证据的事务会把证据哈希已经对不上的有效判断标成失效。并发的「补证据」和「用旧哈希记判断」结束后，不存在一条仍有效、却指向旧证据的判断。

空的提示词或模型版本仍然归一成 `''`，这只避免空和 null 变成两条身份。`origin=deterministic` 可以空着，因为没有跑模型。`origin=model` 必须同时有非空的提示词版本和模型版本，数据库约束 `own_judgments_origin_check` 也拒绝空版本的模型判断。

## 网页测试对照

上一轮 `npm test` 的 26 个失败都在这三个文件：

- `tests/malformed-public-paths.standalone.test.ts`
- `tests/page-links.standalone.test.ts`
- `tests/page-metadata.standalone.test.ts`

原因是当时没有 `apps/web/build/server/index.js`。`apps/web` 相对钉住提交没有差异。

同一数据库、构建网页之后：

- 当前分支这 26 项通过。
- 钉住提交 `7b446b1` 的工作树单独构建网页后，同样 26 项通过。

所以这 26 项不是本轮表结构或导入命令引入的。

构建网页之后的全量 `npm test`：1182 项，1182 通过，0 失败。测试套件自己的模型调用走本地假服务；本轮导入命令在外发或模型开关为 true 时拒绝执行，测试里成功路径显式把这些开关写成 false。没有付费 API。
