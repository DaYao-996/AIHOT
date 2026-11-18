// Reproducible local rounds for the daily entry. It does not fetch public sites.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

mkdirSync("var/daily", { recursive: true });
const runtimePath = "var/daily/runtime.json";
const listingPath = "var/daily/listing.json";
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  console.error("实验需要 DATABASE_URL，只用于准备库和读取结果。日常运行本身从配置文件读取。");
  process.exit(1);
}

const runtime = {
  databaseUrl,
  publish: false,
  listen: "127.0.0.1:18765",
  sourceId: "daily-local",
  listingState: listingPath,
  stateFile: "var/daily/state.json",
  bodyGeneration: 0,
  samples: {
    a: "docs/own-pipeline/product/samples/nvidia-sparse.detail.bin",
    b: "docs/own-pipeline/product/samples/nvidia-slurm.detail.bin",
    c: "docs/own-pipeline/product/samples/apple-cn-keke.detail.bin",
  },
};

function writeRuntime(bodyGeneration = 0) {
  mkdirSync("var/daily", { recursive: true });
  writeFileSync(runtimePath, JSON.stringify({ ...runtime, bodyGeneration }), { mode: 0o600 });
  chmodSync(runtimePath, 0o600);
}

function writeListing(items: string[], hold: string[] = [], extend: string[] = []) {
  writeFileSync(listingPath, JSON.stringify({ items, denied: true, hold, extend }) + "\n");
}

function command(args: string[]) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function requireFail(args: string[], label: string) {
  const result = command(args);
  if (result.status === 0) throw new Error(`${label} 不应成功`);
}

const report: Record<string, unknown> = { macSchedulePassed: false, publish: false };
requireFail(["scripts/own-daily.ts", "--step", "run", "--runtime", "var/daily/missing.json"], "缺少配置");
writeFileSync("var/daily/loose.json", JSON.stringify({ databaseUrl }), { mode: 0o644 });
chmodSync("var/daily/loose.json", 0o644);
requireFail(["scripts/own-daily.ts", "--step", "run", "--runtime", "var/daily/loose.json"], "权限过宽");
writeRuntime(0);
const scheduled = command(["scripts/own-daily.ts", "--step", "schedule-daily", "--schedule-dir", "var/schedule-daily", "--runtime", runtimePath]);
if (scheduled.status !== 0) throw new Error(scheduled.stderr);
const plist = readFileSync("var/schedule-daily/own-pipeline-daily.plist", "utf8");
if (plist.includes(databaseUrl) || plist.includes("postgres://")) throw new Error("调度工件写进了数据库口令");
report.plistHasSecret = false;

spawnSync("psql", [databaseUrl.replace(/\/[^/]+$/, "/postgres"), "-c", "DROP DATABASE IF EXISTS own_daily_run_test"], { stdio: "ignore" });
const name = new URL(databaseUrl).pathname.slice(1);
spawnSync("psql", [databaseUrl.replace(/\/[^/]+$/, "/postgres"), "-c", `CREATE DATABASE ${name}`], { stdio: "inherit" });
const migrated = command(["scripts/migrate.ts"]);
if (migrated.status !== 0) throw new Error(migrated.stderr || migrated.stdout);

writeListing(["a", "b"]);
const server = spawn(process.execPath, ["scripts/own-daily.ts", "--step", "serve", "--runtime", runtimePath], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("本机服务没有起来")), 5000);
  server.stdout?.on("data", (chunk) => {
    if (String(chunk).includes("serving")) { clearTimeout(timer); resolve(); }
  });
  server.once("exit", () => reject(new Error("本机服务退出了")));
});

function runOnce() {
  const result = command(["scripts/own-daily.ts", "--step", "run", "--runtime", runtimePath]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

function counts() {
  const query = `SELECT regexp_replace(url, '.*/', '') AS key, count(*)::int AS n FROM articles WHERE source_id = 'daily-local' GROUP BY 1 ORDER BY 1`;
  const text = spawnSync("psql", [databaseUrl, "-At", "-c", query], { encoding: "utf8" }).stdout.trim();
  return Object.fromEntries(text.split("\n").filter(Boolean).map((line) => {
    const [key, n] = line.split("|");
    return [key, Number(n)];
  }));
}

function refused() {
  const query = `SELECT count(*) FROM own_request_attempts WHERE url LIKE '%/items/denied' AND phase = 'failed' AND http_status = 403`;
  return Number(spawnSync("psql", [databaseUrl, "-At", "-c", query], { encoding: "utf8" }).stdout.trim());
}

try {
  const round1 = runOnce();
  report.round1 = { ...round1, articles: counts(), refused: refused() };
  writeListing(["a", "b", "c"], ["c"]);
  const interrupted = spawn(process.execPath, ["scripts/own-daily.ts", "--step", "run", "--runtime", runtimePath], { stdio: "ignore" });
  const seen = Date.now();
  let started = false;
  while (Date.now() - seen < 15000) {
    const n = Number(spawnSync("psql", [databaseUrl, "-At", "-c", `SELECT count(*) FROM own_request_attempts WHERE url LIKE '%/items/c' AND phase = 'started'`], { encoding: "utf8" }).stdout.trim());
    if (n > 0) { started = true; break; }
    await sleep(200);
  }
  if (!started) throw new Error("中断前没有留下已开始的请求");
  interrupted.kill("SIGKILL");
  await sleep(300);
  writeListing(["a", "b", "c"]);
  const round2 = runOnce();
  report.round2 = { ...round2, articles: counts(), refused: refused(), interruptedStarted: true };
  const round3 = runOnce();
  report.round3 = { ...round3, articles: counts(), refused: refused() };
  writeListing(["a", "b", "c"], [], ["a"]);
  writeRuntime(1);
  const updated = runOnce();
  const stale = Number(spawnSync("psql", [databaseUrl, "-At", "-c", `SELECT count(*) FROM own_judgments j JOIN articles a ON a.id = j.article_id WHERE a.url LIKE '%/items/a' AND j.stale = true`], { encoding: "utf8" }).stdout.trim());
  report.updated = { ...updated, articles: counts(), refused: refused(), staleA: stale };
  const finalCounts = counts();
  if (finalCounts.a !== 1 || finalCounts.b !== 1 || finalCounts.c !== 1) throw new Error(`文章身份没有保持一份 ${JSON.stringify(finalCounts)}`);
  if (refused() !== 1) throw new Error("403 没有按一次失败保留");
  if (round3.created !== 0) throw new Error("同一列表又新增了文章");
  if (stale < 1 || updated.bodyRevisions < 1) throw new Error("正文更新没有使旧判断失效");
  if (updated.publications !== 0) throw new Error("出现了发布");
  report.ok = true;
} finally {
  server.kill("SIGKILL");
}

mkdirSync("var/daily-experiment", { recursive: true });
writeFileSync("var/daily-experiment/REPORT.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ok: report.ok, articles: report.updated && (report.updated as { articles: unknown }).articles, refused: 1 }));
