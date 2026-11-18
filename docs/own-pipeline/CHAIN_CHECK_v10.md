# 采集到文件语义：对照代码后的结论

对照的是 `399d27bd026006395fb4ae23a2acd7f8850d971e`。没有改 v6、v9 的库，也没有重跑当时的日志。

## 评分输入看得到旁路

`materialForScoring` 和编辑用的 `buildMaterial` 会读证据 `body_gate` 里的链接和图表轴。离线页的 817 字正文不变，评分对象里有 `https://example.org/paper.pdf` 和 `value.suffix: %`。

## 文件语义入口还不能引用这段旁路

`recordFileResult` 只在 `body_text` 和 `quoted_text` 里对引文。旁路里的地址或 `value.suffix: %` 不在正文里，按现在的入口会被拒绝，错误是「引文不在当前正文或引用里」。所以「评分输入显示了」不等于「文件语义可以引用这段补充」。

## 哈希和版本

带 `contentAside` 写入证据时，哈希把旁路算进去。只补 `body_gate.supplements` 的入口也会换证据哈希，并且只把这一篇里哈希对不上的判断标成失效，不升文章修订。文件语义同时要求证据哈希、证据版本和文章修订都是当前值。

## 普通入库没有把旁路写进证据

`readable` 和 `applyDetail` 会把旁路放在候选上。`collect.ts` 的 `store` 调用 `upsertMaterial` 时，文章表没有这个字段，候选上的旁路不会进 `own_evidence_versions`。v10 的离线证明是解析、`applyDetail`，再由调用方把 `contentAside` 交给 `appendControlledEvidence`。这不是只换了三条 URL 的补证脚本，也还不是采集 `store` 自己把旁路写入证据。

## v6 三篇只读

这三篇当前证据上没有未失效判断。新的读取能看见已经写在 `body_gate` 里的补充，但不会让旧判断变成仍然有效，也不会改它们的绑定哈希。
