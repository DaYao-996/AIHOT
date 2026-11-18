# 独立 v6 探针怎么跑

原件是 `INDEPENDENT_v6_probe.ts`，SHA256 `4a1eb6b49467ea566cd1016299d59d62b4fef56cf226557392aeeef505fa712e`。不要改它。

在当前 HEAD 上直接跑原件，会在第 174 行停下：`rawSha256` 已是未知字段，规范化哈希那次导入被拒绝，后面的 SQL 拿到空的文章号。这是字段改名，不是那五条缺陷还在。

`own-v6-probe-adapter.ts` 只做四件事，方便同一套记录跑完：

1. 文档里的 `rawSha256` 改送到 `rawCanonicalSha256`。文件字节哈希因此对不上规范化 JSON，仍然被拒绝。
2. 命令输出改读 `rawCanonicalSha256`。产品不再输出 `rawSha256`。
3. 不带 `comparison.inputHash` 的 `reference_only` 先试一次，预期拒绝。后面的库调用改用 `incomplete_material`，版本、身份和回滚记录才能继续。
4. 没有回执的 model 来源预期拒绝。不再假定 CLI 插过占位判断行。
