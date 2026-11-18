// 未许可的自有判断不能进入自动分析、公开或发送。这不是导出脚本里的布尔常数。
import { sql, type Db } from "./db.ts";

const RELEASE_JOBS = ["content.analyze", "content.extract-body", "events.group", "notify.selected"];

/** 当前修订上还有未失效、未许可的自有判断。没有这类行的普通文章不受影响。 */
export async function unlicensedReleaseHold(db: Db, articleId: string): Promise<boolean> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM own_judgments j
    JOIN articles a ON a.id = j.article_id
    WHERE j.article_id = ${articleId} AND j.stale = false AND j.release_status = 'not_licensed'
      AND j.input_revision = a.revision`;
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
