// Normal daily entry. It loads one runtime file before the database module starts.
// The fixture replay remains `node scripts/own-run.ts --step once`.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
};
const step = flag("--step") || "run";
const runtimePath = flag("--runtime");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function scheduleDaily() {
  const dir = flag("--schedule-dir") || "var/schedule-daily";
  if (!runtimePath || isAbsolute(dir) || dir.split(/[\\/]/).includes("..")) fail("日常调度需要相对的 --schedule-dir，以及 --runtime 指向的配置路径。");
  mkdirSync(dir, { recursive: true });
  const root = process.cwd();
  const trigger = join(dir, "run-daily.sh");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(trigger, `#!/bin/sh
set -eu
cd ${quote(root)}
exec node scripts/own-daily.ts --step run --runtime ${quote(runtimePath)}
`);
  chmodSync(trigger, 0o755);
  const plistPath = join(dir, "own-pipeline-daily.plist");
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.own-pipeline.daily.test</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xml(resolve(trigger))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COLLECT_ENABLED</key>
    <string>false</string>
    <key>MODEL_CALLS_ENABLED</key>
    <string>false</string>
  </dict>
</dict>
</plist>
`);
  writeFileSync(join(dir, "installed.json"), JSON.stringify({
    kind: "launchd-daily", timerRunning: false, loadedIntoLaunchd: false, launchctlInvoked: false, macSchedulePassed: false,
    publish: false, runtimePath, plist: plistPath, trigger,
    note: "plist 只有配置路径，没有数据库口令。这次没有调用 launchctl，Mac 定时运行尚未通过。",
  }, null, 2) + "\n");
  console.log(JSON.stringify({ step: "schedule-daily", installed: true, loadedIntoLaunchd: false, macSchedulePassed: false, runtimePath, plist: plistPath }));
}

if (step === "schedule-daily") {
  scheduleDaily();
  process.exit(0);
}

if (!runtimePath) fail("缺少 --runtime。正常运行不从环境猜测数据库，也不把口令写进调度工件。");
if (!existsSync(runtimePath)) fail(`缺少运行配置 ${runtimePath}`);
const info = statSync(runtimePath);
if ((info.mode & 0o077) !== 0) fail("运行配置权限过宽。需要仅所有者可读写。");
const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as { databaseUrl?: string; publish?: boolean; listen?: string; listingState?: string; samples?: Record<string, string> };
if (step === "serve") {
  const { serveDaily } = await import("./own-daily-serve.ts");
  await serveDaily({ listen: String(runtime.listen ?? ""), listingState: String(runtime.listingState ?? ""), samples: runtime.samples ?? {} });
} else if (step === "run") {
  if (!runtime.databaseUrl) fail("运行配置没有 databaseUrl。");
  if (runtime.publish === true) fail("发布必须保持关闭。");
  let url: URL;
  try { url = new URL(runtime.databaseUrl); }
  catch { fail("databaseUrl 无法解析。"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !["127.0.0.1", "localhost", "::1"].includes(host)) fail("databaseUrl 必须是本机 PostgreSQL。");
  if (!url.username || !url.password || !/^[A-Za-z0-9_]+_(test|ci)$/.test(name) || /prod|private24/i.test(name)) fail("databaseUrl 必须写明用户和口令，库名以 _test 或 _ci 结尾。");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true") fail("正常运行不打开采集开关或模型调用。");
  process.env.DATABASE_URL = runtime.databaseUrl;
  const { runDaily } = await import("./own-daily-run.ts");
  const summary = await runDaily(runtime);
  console.log(JSON.stringify(summary));
  process.exit(0);
} else fail("日常入口只接受 run、serve 或 schedule-daily。夹具回放用 scripts/own-run.ts --step once。");
