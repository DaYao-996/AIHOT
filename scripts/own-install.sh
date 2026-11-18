#!/bin/sh
# Install this source tree where it stands. It does not start a worker or a timer.
set -eu
cd "$(dirname "$0")/.."
if [ ! -f package.json ] || [ ! -f package-lock.json ]; then
  echo "要在含有 package.json 和 package-lock.json 的源码根目录运行。" >&2
  exit 1
fi
expected=$(sed -n 's/^lock-sha256 //p' docs/own-pipeline/product/VERSION)
actual=$(sha256sum package-lock.json | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
  echo "package-lock.json 与 VERSION 不一致：$actual" >&2
  exit 1
fi
node << 'EOF'
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const ok = major === 24 && minor === 22 && patch >= 1;
if (!ok) {
  console.error(`需要 Node.js 24.22.x（已核对 24.22.2），当前 ${process.version}`);
  process.exit(1);
}
EOF
npm_major=$(npm --version | cut -d. -f1)
if [ "$npm_major" != "11" ]; then
  echo "需要 npm 11（已核对 11.19.1），当前是 $(npm --version)。" >&2
  exit 1
fi
psql_major=$(psql --version | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p')
if [ "$psql_major" != "16" ]; then
  echo "需要 PostgreSQL 16 的客户端（已核对 16.15），当前是 $(psql --version)。" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "需要环境变量 DATABASE_URL，形状是 postgres://用户:口令@127.0.0.1:5432/名字_test。安装不会改用本机超级用户，也不接受空口令。" >&2
  exit 1
fi
db_name=$(node << 'EOF'
const url = new URL(process.env.DATABASE_URL);
const host = url.hostname.replace(/^\[|\]$/g, "");
if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
  console.error("拒绝非 PostgreSQL 地址");
  process.exit(1);
}
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  console.error(`拒绝非本机数据库：${host}`);
  process.exit(1);
}
if (!url.username || !url.password) {
  console.error("DATABASE_URL 必须同时写明用户和口令。安装不会改用本机超级用户，也不接受空口令。");
  process.exit(1);
}
const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!/^[A-Za-z0-9_]+_(test|ci)$/.test(name) || /prod|private24/i.test(name)) {
  console.error(`拒绝这个库名：${name}`);
  process.exit(1);
}
process.stdout.write(name);
EOF
)
admin=$(node << 'EOF'
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/postgres";
url.search = "";
url.hash = "";
process.stdout.write(url.toString());
EOF
)
exists=$(psql "$admin" -At -c "SELECT 1 FROM pg_database WHERE datname = '$db_name'")
if [ "$exists" != "1" ]; then
  psql "$admin" -c "CREATE DATABASE $db_name"
fi
npm ci
node scripts/migrate.ts
echo "安装完成。没有启动 worker，没有打开发布，没有安装定时器。下一步：node scripts/own-run.ts --step schedule --schedule-dir var/schedule"
