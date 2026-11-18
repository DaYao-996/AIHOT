// 未许可的自有判断不能进入自动分析、公开或发送。这不是导出脚本里的布尔常数。
import { sql, type Db } from "./db.ts";

const RELEASE_JOBS = ["content.analyze", "content.extract-body", "events.group", "notify.selected"];

/**
 * 这篇文章进过自有判断。许可列只能是 not_licensed，失效或修订前进都不会变成批准。
 * 普通文章没有这类行，仍走原来的分析。判断历史留着，不在这里删。
 */
export async function unlicensedReleaseHold(db: Db, articleId: string): Promise<boolean> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM own_judgments WHERE article_id = ${articleId}`;
  return (row?.n ?? 0) > 0;
}

/** 扫队列只捡 new。已创建的分析、归组和发送作业也要撤掉，否则消费者仍会跑。 */
export async function holdBackAutomaticRelease(db: Db, articleId: string): Promise<void> {
  await db`UPDATE articles SET processing_state = 'skipped', processing_queued_at = NULL
    WHERE id = ${articleId} AND processing_state = 'new'`;
  const [table] = await db<{ ok: boolean }[]>`SELECT to_regclass('pgboss.job') IS NOT NULL AS ok`;
  if (!table?.ok) return;
  await db`DELETE FROM pgboss.job
    WHERE name IN ${sql(RELEASE_JOBS)} AND state IN ('created', 'retry') AND data->>'articleId' = ${articleId}`;
}
