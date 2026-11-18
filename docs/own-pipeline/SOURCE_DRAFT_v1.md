# 源配置草案 v1

历史封存配置，不是正在运行的生产配置。全部 `enabled: false`。没有启动采集、worker 或模型。

- 来源包：SOURCE_MIGRATION_INPUTS_v1 sha256 a7177acd1acbd1f60eda49ddeed11f302a9caea898d92f35a725c331b2e333ec
- X 132 条。doc05 对不上的 handle 12 个：NousResearch, lasse_ai, k2sbhai, soumithchintala, antigravity, GoogleAIStudio, NVIDIAAI, NVIDIARobotics, SpaceXSI, PyTorch, DarioAmodei, demishassabis。不猜频率。
- 非 X 47 条。非空 endpoint 45，唯一 endpoint 42。不是 47 条可运行 feed。
- 状态计数：{"historical_snapshot_not_enabled":18,"parse_failed_historical":2,"blocked_or_login":2,"html_not_a_feed":4,"fetch_failed_historical":6,"excluded_do_not_enable":11,"missing_endpoint":4}

源频率档位没有写成精选 T 档。冻结查询是 `-filter:retweets`，不能改写成单独的 `-filter:replies`，否则会丢掉作者自己的续帖。

下一小批只列出最多 5 个历史上有 RSS 快照、endpoint 不重复的候选，仍然不启用。付费 X 搜索不在这批里。估算 2.06 美元不是厂商实扣。
