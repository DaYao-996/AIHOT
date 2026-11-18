# 特征提取到判断的下一清单

日期：2026-11-18。这不是本轮实现，也不是新留出。已揭盲的 12 条只可调试。A–F、70、55、40 不能自动通过。v46 仍是草稿，17 原文的条款字面不能改。

## 确定性，不调用模型

- 记录资格：同一 raw 的 post id、非转帖、`truncated=false`、引用在场时引用正文也在。
- 正文归属：片段或标题只切出一段，整页不算单条。对不上就是 missing 或 ambiguous。
- 材料状态从最新证据的正文和引用派生。缺引用不能写成 complete。
- 对照输入哈希按 `sha256(stableJson({ algorithm, evidenceHash }))` 重算。
- 模型回执的 subject、request 里的文章和证据哈希必须对上这次调用。未完成回执不能用。

## 要语义模型的

- `fact_source.source_type`、`direction_and_use` 的条款对应、`preference_sensitive_class`、`electronics_or_device_angle`。
- 模型只看见已归属的正文、引用和 raw 身份。看不到文章表里被撤回后留下的旧正文。
- 输出不得含 prioritize、verify、exclude、expected。`human_verification` 保持 unverified。
- `fact_status=checked` 只能来自人的摘录，模型不能把未核写成已核。`unchecked` 可以留在待核队列。

## 留存

每次调用留下 raw 身份、证据哈希、prompt 版本、model 版本、回执号、输入哈希和 costUsd。没有回执或没有报价时 costUsd 为空，不假装已扣费。文件入口是 `parseModelOutputFile`，不访问网络。
