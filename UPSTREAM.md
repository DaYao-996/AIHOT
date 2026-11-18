# 上游钉住

本文件记录本轮工作根，不改写远端历史。

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/KKKKhazix/AIHOT |
| 本仓库 | https://github.com/DaYao-996/AIHOT |
| 钉住提交 | `7b446b1008d832ee25084f8e7baf62ce493f40c3` |
| 提交说明 | 同步引擎 |
| 提交时间 | 2026-11-18 02:11:45 +0800 |
| 工作区起点 | 游离 HEAD，就在该提交上 |
| `origin/main` | `cb5d4e533f85f07e9a417ac169d5225c5a69d2b8`（提交说明同为「同步引擎」） |

`git merge-base origin/main 7b446b1008d832ee25084f8e7baf62ce493f40c3` 等于 `cb5d4e5`。钉住提交比 `origin/main` 超前 40 个提交、落后 0 个。提交对象在本工作区能读到，不在 `origin/main` 上。没有执行 reset、force push，也没有改 `origin/main`。

本分支从钉住提交拉出。相对该提交的差异是本轮文件，不含那 40 个上游提交：

- `UPSTREAM.md`
- `docs/own-pipeline/STEP0_v4.md`
- `docs/own-pipeline/DB_LOOP_v5.md`
- `docs/own-pipeline/EVAL_PROTOCOL_v1.md`
- `site/own-pipeline.ts`
- `packages/backend/src/own-pipeline-store.ts`
- `tests/own-pipeline.standalone.test.ts`
- `tests/own-pipeline.test.ts`
- `scripts/own-migrate.ts`
- `scripts/own-gap-check.ts`
- `database/migrations/0170_own_judgments.sql`
- `database/migrations/0171_own_evidence_versions.sql`

复查：

```bash
git diff --stat 7b446b1008d832ee25084f8e7baf62ce493f40c3
git rev-list --count origin/main..7b446b1008d832ee25084f8e7baf62ce493f40c3
```

`0170` 尚未在任何数据库执行。
