import type { Env } from "../env";
import { LIMITS } from "../limits";
import { badRequest, json } from "../lib/http";
import { authenticate, avatarUrl, CATEGORIES, COLUMN, getWeek, rankOf, type Category, type PlayerRow } from "../lib/players";
import { isoWeek, weekKeyStart, DAY } from "../lib/time";

interface BoardRow extends PlayerRow {
  value: number;
}

function row(r: Pick<BoardRow, "id" | "name" | "title_id" | "tier" | "division" | "rp" | "avatar_key" | "avatar_hidden" | "avatar_version">, rank: number | null, value: number, me: boolean) {
  return {
    rank,
    id: r.id,
    name: r.name,
    titleId: r.title_id,
    tier: r.tier,
    division: r.division,
    rp: r.rp,
    value,
    avatar: avatarUrl(r),
    me,
  };
}

/**
 * GET /v1/leaderboard?cat=overall|words|tower|snake|comet[&week=YYYY-Www]
 * Top 100 of the week plus the caller's own row (also when outside the top 100).
 * Order: value desc, then whoever reached it first, then id. Hidden players never appear for others.
 */
export async function getLeaderboard(request: Request, env: Env, now: number): Promise<Response> {
  const caller = await authenticate(request, env, now);
  const url = new URL(request.url);
  const cat = (url.searchParams.get("cat") ?? "overall") as Category;
  if (!CATEGORIES.includes(cat)) throw badRequest(`cat must be one of ${CATEGORIES.join(", ")}`, { field: "cat" });

  const current = isoWeek(now);
  const week = url.searchParams.get("week") ?? current;
  const start = weekKeyStart(week);
  if (start === null) throw badRequest("week must look like 2026-W47", { field: "week" });
  if (week > current && start > now) throw badRequest("week is in the future", { field: "week" });

  const col = COLUMN[cat];
  const top = await env.DB.prepare(
    `SELECT p.*, w.${col} AS value FROM weekly_scores w JOIN players p ON p.id = w.player_id
     WHERE w.week = ?1 AND p.hidden = 0 AND w.${col} > 0
     ORDER BY w.${col} DESC, w.${col}_at ASC, p.id ASC
     LIMIT ?2`,
  )
    .bind(week, LIMITS.leaderboard.top)
    .all<BoardRow>();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM weekly_scores w JOIN players p ON p.id = w.player_id WHERE w.week = ?1 AND p.hidden = 0 AND w.${col} > 0`,
  )
    .bind(week)
    .first<{ n: number }>();

  const rows = top.results.map((r, i) => row(r, i + 1, r.value, r.id === caller.id));
  const myWeek = await getWeek(env, caller.id, week);
  const myRank = await rankOf(env, week, cat, myWeek, caller);
  const me = row(caller, myRank, myWeek?.[col] ?? 0, true);

  return json({
    cat,
    week: { key: week, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * DAY).toISOString(), current: week === current },
    total: total?.n ?? 0,
    rows,
    me: { ...me, hidden: !!caller.hidden },
  });
}
