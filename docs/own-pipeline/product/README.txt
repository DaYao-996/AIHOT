这是可安装的源码树，不是业务验收。合同内容质量和全源覆盖没有通过。174 条 X 未跑。41 篇台账的缺日期字段仍是 12；按字段刷新后的缺日期是 11。可安装不能代替这两项。

版本前提写在 VERSION。配置示例是 config.example.json，里面没有数据库口令。样本是 samples/ 里的三份已保存原页和 PRIOR17.json，路径相对这个目录，不使用 ../ 跳回别的工作目录。回放只听 127.0.0.1 的临时端口。

标准依赖是 Node.js 24.22.1 或更新、npm、本机 PostgreSQL，以及 psql、pg_dump、pg_restore、sha256sum。第一次安装需要能访问 npm 以执行 `npm ci`。包内有 package-lock.json、scripts/own-run.ts、三份原页和 PRIOR17.json。不需要旁边的另一个仓库。

在解压后的源码根目录执行，不要用 `../` 跳出这个目录：

```
export DATABASE_URL=postgres://用户:口令@127.0.0.1:5432/名字_test
sh scripts/own-install.sh
node scripts/own-run.ts --step schedule --schedule-dir var/schedule
node scripts/own-run.ts --step file
node scripts/own-run.ts --step model
node scripts/own-run.ts --step once --config docs/own-pipeline/product/config.example.json --out-dir var/once-out --schedule-dir var/schedule
node scripts/own-run.ts --step bind-proof --out-dir var/bind-out
node scripts/own-run.ts --step stop --schedule-dir var/schedule
```

`--step schedule` 退出码 0 只表示写下了 var/schedule/installed.json。timerRunning 是 false。没有 cron，没有 worker，没有正在跑的定时器。`--step once` 才执行这一次本机回放，从采集到待审导出和备份恢复。`--step stop` 删掉 installed.json，并写下 uninstalled.json。没有工件时 stop 退出码是 1，不用 0 表示已经停过。

`--step file` 退出码 0 表示文件判断模式可以运行，它不需要模型配置，也不在这一步写入判断。`--step model` 在模型未配置时退出码 1，说明缺少的变量，不发请求，不写回执。这是两种结果。

`--step bind-proof` 用同一地址的两个已完成请求并发绑定，并让第三次在提交前失败。详情行用 `attempt_id` 指向自己的请求。失败的那次不留下修订号和详情行。这不请求官网。

PRIOR17.json 是只读的历史台账原件。41 篇的旧标签不改。缺日期字段仍按这份原件重数。

自动发布保持关闭。没有 Mac 部署。
