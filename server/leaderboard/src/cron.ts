import type { Env } from "./env";
import { LIMITS } from "./limits";
import { deletePlayer } from "./lib/players";
import { dayKey, isoWeek, DAY } from "./lib/time";

/**
 * Daily housekeeping (cron "17 0 * * *"). The weekly reset needs no work here: scores are keyed
 * by ISO week, so Monday 00:00 UTC simply starts a new, empty week (lazy rollover).
 */
export async function runDaily(env: Env, now: number): Promise<{ deletedPlayers: number }> {
  const db = env.DB;
  const oldestWeek = isoWeek(now - LIMITS.historyWeeks * 7 * DAY);
  await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE window < ?1").bind(Math.floor((now - 2 * DAY) / 1000)),
    db.prepare("DELETE FROM daily_usage WHERE day < ?1").bind(dayKey(now - 8 * DAY)),
    db.prepare("DELETE FROM score_batches WHERE created_at < ?1").bind(now - 14 * DAY),
    db.prepare("DELETE FROM weekly_scores WHERE week < ?1").bind(oldestWeek),
  ]);

  // Accounts whose token was lost (app reinstalled without leaving) disappear on their own.
  let deletedPlayers = 0;
  const days = Number(env.INACTIVE_DELETE_DAYS ?? "180");
  if (days > 0) {
    const stale = await db.prepare("SELECT id FROM players WHERE last_seen_day < ?1 LIMIT 200")
      .bind(dayKey(now - days * DAY))
      .all<{ id: string }>();
    for (const { id } of stale.results) {
      await deletePlayer(env, id);
      deletedPlayers++;
    }
  }
  return { deletedPlayers };
}
