// End-to-end own-import of the three already-public unblinded posts.
// No scores, no model, no worker. File-byte SHA256 and canonical JSON SHA256 stay distinct.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { stableJson } from "@aihot/backend/lib/ids";
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";
import type { XPostData } from "@aihot/backend/content/materials";

const samples = process.argv[2];
const SOURCE = "unblinded-public-debug";
if (!samples) throw new Error("usage: node scripts/own-unblinded-drill.ts <samples-dir>");
assertThrowawayDatabase(process.env.DATABASE_URL ?? "");

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function findTweet(raw: unknown, id: string): { name: string; handle: string; text: string; quoted: XPostData["quoted"] } | null {
  const stack: unknown[] = [raw];
  const seen = new Set<unknown>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const row = cur as Record<string, unknown>;
    if (row.id_str === id && row.user && typeof row.user === "object") {
      const user = row.user as { name?: string; screen_name?: string };
      const quoted = row.quoted_status && typeof row.quoted_status === "object" ? row.quoted_status as Record<string, unknown> : null;
      const quotedUser = quoted?.user && typeof quoted.user === "object" ? quoted.user as { name?: string; screen_name?: string } : null;
      return {
        name: String(user.name ?? ""),
        handle: String(user.screen_name ?? ""),
        text: String(row.full_text ?? row.text ?? ""),
        quoted: quoted && quotedUser ? {
          authorName: String(quotedUser.name ?? ""),
          handle: String(quotedUser.screen_name ?? ""),
          text: String(quoted.full_text ?? quoted.text ?? ""),
          url: `https://x.com/${quotedUser.screen_name}/status/${quoted.id_str}`,
        } : null,
      };
    }
    for (const value of Object.values(row)) if (value && typeof value === "object") stack.push(value);
  }
  return null;
}

await sql`INSERT INTO sources (id, name, kind, participation_mode, next_fetch_at)
  VALUES (${SOURCE}, 'Public unblinded debug', 'external', 'isolated', '2100-01-01')
  ON CONFLICT (id) DO NOTHING`;

const ids = ["2117095432526700766", "2120299157411790929", "2120452474305904776"];
const prepared = ids.map((id) => {
  const rawBytes = readFileSync(path.join(samples, id, "raw.json"));
  const record = JSON.parse(readFileSync(path.join(samples, id, "record.json"), "utf8")) as {
    handle: string; post_id: string; root_text: string; quote?: { status?: string; text?: string };
    source?: { raw_sha256?: string };
  };
  const raw = JSON.parse(rawBytes.toString("utf8")) as unknown;
  const fileSha256 = sha256(rawBytes);
  const declared = record.source?.raw_sha256 ?? "";
  if (fileSha256 !== declared) throw new Error(`${id} 文件字节哈希与审阅包声明不一致`);
  const canonicalSha256 = sha256(stableJson(raw));
  if (canonicalSha256 === fileSha256) throw new Error(`${id} 规范化 JSON 哈希不应被当成文件字节哈希`);
  const post = findTweet(raw, id);
  if (!post) throw new Error(`${id} 原件里没有这条帖的作者`);
  const base = {
    url: `https://x.com/${record.handle}/status/${record.post_id}`,
    title: record.root_text.slice(0, 80),
    raw, rawFileSha256: fileSha256, rawFileBase64: rawBytes.toString("base64"), rawCanonicalSha256: canonicalSha256,
  };
  const quoteText = record.quote?.status === "present" ? record.quote.text : undefined;
  const explicit = {
    ...base,
    bodyText: record.root_text,
    ...(quoteText ? { quotedText: quoteText } : {}),
    xPost: {
      tweetId: record.post_id, authorName: post.name, handle: post.handle, text: record.root_text,
      quoted: post.quoted,
    },
  };
  return { id, base, explicit, fileSha256, canonicalSha256, declared };
});

const dir = "/tmp/own-unblinded-drill";
mkdirSync(dir, { recursive: true });
const quiet = {
  ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
  FEISHU_CONTENT_PUSH_ENABLED: "false", DINGTALK_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false",
  INDEXNOW_SUBMIT_ENABLED: "false", BAIDU_PUSH_ENABLED: "false",
};
function run(name: string, items: unknown[]) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({ sourceId: SOURCE, items }));
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/own-import.ts"), "--file", file], {
    cwd: process.cwd(), encoding: "utf8", env: quiet,
  });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { counts: Record<string, number>; items: Array<Record<string, unknown>> };
}

const rawOnly = run("raw-only.json", prepared.map((row) => row.base));
const explicit = run("explicit.json", prepared.map((row) => row.explicit));
const repeated = run("explicit-repeat.json", prepared.map((row) => row.explicit));

const urls = prepared.map((row) => row.base.url);
const rows = await sql<{
  url: string; revision: number; processing_queued_at: Date | null; judgments: number; analyses: number; versions: Array<{
    version: number; has_raw: boolean; body_len: number | null; quote_len: number | null; has_x: boolean; file: string | null; canonical: string | null;
  }>;
}[]>`
  SELECT a.url, a.revision, a.processing_queued_at,
    (SELECT count(*)::int FROM own_judgments j WHERE j.article_id = a.id) AS judgments,
    (SELECT count(*)::int FROM analyses an WHERE an.article_id = a.id) AS analyses,
    (SELECT json_agg(json_build_object(
        'version', v.version, 'has_raw', v.raw IS NOT NULL, 'body_len', length(v.body_text),
        'quote_len', length(v.quoted_text), 'has_x', v.x_post IS NOT NULL,
        'file', v.raw_identity->>'fileSha256', 'canonical', v.raw_identity->>'canonicalSha256') ORDER BY v.version)
      FROM own_evidence_versions v WHERE v.article_id = a.id) AS versions
  FROM articles a WHERE a.url IN ${sql(urls)} ORDER BY a.url`;

for (const row of rows) {
  const sample = prepared.find((item) => item.base.url === row.url)!;
  const first = row.versions[0]!;
  if (row.judgments !== 0 || row.analyses !== 0 || row.processing_queued_at) throw new Error(`${row.url} 出现判断、分析或队列`);
  if (!first.has_raw || first.file !== sample.declared || first.canonical !== sample.canonicalSha256) throw new Error(`${row.url} 原件哈希没有按两种身份保留`);
  const [bytes] = await sql<{ raw_file: Buffer | null }[]>`
    SELECT raw_file FROM own_evidence_versions v JOIN articles a ON a.id = v.article_id
    WHERE a.url = ${row.url} AND v.version = 1`;
  if (!bytes?.raw_file || sha256(bytes.raw_file) !== sample.declared) throw new Error(`${row.url} 库里的原件字节取不回声明的文件哈希`);
  if (first.body_len) throw new Error(`${row.url} 第一版不该有正文`);
  const supplemented = row.versions[1];
  if (!supplemented || !supplemented.body_len || !supplemented.has_x) throw new Error(`${row.url} 补料没有形成新版本`);
  if (supplemented.has_raw && supplemented.canonical !== first.canonical) throw new Error(`${row.url} 补料换成了另一份原件`);
  if (sample.explicit.quotedText && !supplemented.quote_len) throw new Error(`${row.url} 显式引用没有写入`);
}
if (rawOnly.counts.evidenceAppended !== 3 || rawOnly.counts.judgmentRecorded !== 0 || rawOnly.counts.judgmentSkippedIncomplete !== 3) {
  throw new Error(`raw-only 计数不符 ${JSON.stringify(rawOnly.counts)}`);
}
if (explicit.counts.evidenceAppended !== 3 || explicit.counts.judgmentRecorded !== 0) throw new Error(`显式补料计数不符 ${JSON.stringify(explicit.counts)}`);
if (repeated.counts.idempotent !== 3 || repeated.counts.evidenceAppended !== 0 || repeated.counts.judgmentRecorded !== 0) {
  throw new Error(`重复运行计数不符 ${JSON.stringify(repeated.counts)}`);
}

const report = {
  scored: false, holdout: false, workerStarted: false, modelCalls: false,
  phases: { rawOnly: rawOnly.counts, explicit: explicit.counts, repeated: repeated.counts },
  samples: prepared.map((item) => ({ id: item.id, fileSha256: item.fileSha256, canonicalSha256: item.canonicalSha256, declaredFileSha256: item.declared })),
  rows,
};
console.log(JSON.stringify(report, null, 2));
await closeDb();
