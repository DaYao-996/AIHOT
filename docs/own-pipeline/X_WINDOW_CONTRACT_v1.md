# X 窗口分页契约 v1

日期：2026-11-18。新文件。不包含 132 个源的名单，名单由使用者另行提供。

## 上游现在做不到的事

审阅包 `evidence/intake/ROUND2_STATUS.json` 的 `priority1_44.query_defect` 写的是：SocialData 的 Latest 搜索可以在窗口里还有帖子时返回空页或没有 `next_cursor`。NFT_Chen 的整窗在 20 条后游标结束，拆窗后又找回包括 22 个已知漏帖在内的更多帖。ElevenLabs、OpenBMB、SemiAnalysis_ 的整窗曾经是 0 条，按周或按天切开后才有结果。这不是平台已经证明窗口抓全。

钉住提交里的 `readXSearch` 把下面几种情况都当成这一轮可以停：

- 没有水位时只读一页，即使还有 cursor。
- 空页，或没有 cursor。
- 到达单轮页数上限。

停下来的原因和「窗口里已知的 id 都见到了」是两件事。空页或没有 cursor 不能当成覆盖证明。本轮补丁把 `stopReason` 和 `coverage` 分开。`coverage` 只有 `unproven` 和 `budget_limited`，没有 `complete`。

可续跑的位置在返回的 `backlog` 里。首轮单页如果还有 cursor，这一轮不再继续花钱读它，下一轮在积压预算内接着读。空页但还有 cursor 时保留这个 cursor，不在同一轮里空转。单轮新鲜页上限仍是 10，积压页上限仍是 10。同一 cursor 再放进来会得到同一批回执号，输出按帖子 id 去重。

## 回复过滤

`from:handle -filter:replies` 会丢掉所有回复，包括作者自己的续帖。根帖，以及不是回复的引用，本来就不是回复。

SocialData 公开算子页列出了 `filter:self_threads`（2026-11-18 读取 `docs.socialdata.tools/resources/twitter-search-operators`）。同一页没有给出 `(-filter:replies OR filter:self_threads)` 这个组合。这个组合不发给供应商。配置里的查询原样发送。冻结合同保持 `-filter:retweets`。这类结果里，父作者不是发帖人的回复在本地丢掉；作者回复自己的续帖保留。`-filter:replies` 已经在供应商一侧丢掉的续帖，本地规则补不回来。

已知的 22 个漏帖只能证明那一次拆窗里这 22 个 id 还在。它不证明以后能发现未知漏帖。页数和积压仍有上限，覆盖只有 `unproven` 或 `budget_limited`。

## 挂点

- `readXSearch` 的第三个参数可以换成假的翻页函数，测试不访问网络。
- `keptByParentAuthor` 只看已经返回的帖子。
- `fetchXSearch` 和 `collectXShard` 发送配置里的查询，不追加 `filter:self_threads`。

没有绝对抓全保证。没有新增真实 HTTP，也没有造 132 个源。
