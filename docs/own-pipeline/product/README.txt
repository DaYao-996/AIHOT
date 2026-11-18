这是可安装的源码树，不是业务验收。合同内容质量和全源覆盖没有通过。174 条 X 未跑。41 篇台账的缺日期字段仍是 12；按字段刷新后的缺日期是 11。可安装不能代替这两项。

版本前提写在 VERSION。配置示例是 config.example.json，里面没有数据库口令。样本是 samples/ 里的三份已保存原页和 PRIOR17.json，路径相对这个目录，不使用 ../ 跳回别的工作目录。回放只听 127.0.0.1 的临时端口。

标准依赖锁定为 Node.js 24.22.x（已核对 24.22.2）、npm 11（已核对 11.19.1）、PostgreSQL 16 客户端（已核对 16.15），以及 pg_dump、pg_restore、sha256sum。第一次安装需要能访问 npm 以执行 `npm ci`。DATABASE_URL 必须自带用户和口令，角色要能创建名字以 `_test` 或 `_ci` 结尾的库。安装不会改用本机超级用户，也不接受空口令。包内有 package-lock.json、scripts/own-run.ts、三份原页和 PRIOR17.json。不需要旁边的另一个仓库。

在解压后的源码根目录执行，不要用 `../` 跳出这个目录：

```
export DATABASE_URL=postgres://用户:口令@127.0.0.1:5432/名字_test
sh scripts/own-install.sh
node scripts/own-run.ts --step schedule --schedule-dir var/schedule
node scripts/own-run.ts --step file
node scripts/own-run.ts --step file-import --config docs/own-pipeline/product/config.example.json --out-dir var/file-import
sh var/schedule/run-once.sh
node scripts/own-run.ts --step stop --schedule-dir var/schedule
node scripts/own-run.ts --step stop --schedule-dir var/schedule
```

`--step schedule` 写下 launchd plist 和 `run-once.sh`。`loadedIntoLaunchd` 是 false，也没有调用 launchctl，所以 Mac 定时运行尚未通过。`sh var/schedule/run-once.sh` 跑当前这一轮。同一轮再跑不重复采集。`sh var/schedule/run-once.sh --new-round` 开始新的一轮，不会被上一轮的完成标记永远跳过。正在跑时再进入，退出码 75。`--step stop` 卸掉 plist 和触发脚本。再执行一次仍然退出码 0。

`--step once` 是夹具验收，串起保存原页、评分输入、文件判断、待审导出和备份恢复。它不是日常采集。日常入口是 `node scripts/own-daily.ts --step run --runtime <仅所有者可读写的配置>`。配置里有数据库地址和稳定的本机列表。调度 plist 只写这个路径，不写口令。缺少配置或权限过宽时退出码 1。`--step file` 只做模式检查，`importCompleted` 是 false，不写判断。`--step file-import` 才写判断；没有正文时退出码 1。`--step model` 在模型未配置时退出码 1，不发请求，不写回执。Mac 定时运行尚未通过。

`--step bind-proof` 用同一地址的两个已完成请求并发绑定，并让第三次在提交前失败。详情行用 `attempt_id` 指向自己的请求。失败的那次不留下修订号和详情行。这不请求官网。

PRIOR17.json 是只读的历史台账原件。41 篇的旧标签不改。缺日期字段仍按这份原件重数。

自动发布保持关闭。没有 Mac 部署。
