import type { Env } from "../env";
import { GAMES, type Game } from "../limits";
import { sha256Hex } from "./crypto";
import { unauthorized } from "./http";
import { hit, tokenKey } from "./ratelimit";
import { dayKey, isoWeek, previousWeek, weekStart, DAY } from "./time";

export interface PlayerRow {
  id: string;
  token_hash: string;
  name: string;
  title_id: string | null;
  tier: number;
  division: number;
  rp: number;
  best_tower: number;
  best_snake: number;
  best_comet: number;
  avatar_key: string | null;
  avatar_type: string | null;
  avatar_version: number;
  avatar_hidden: number;
  hidden: number;
  created_at: number;
  updated_at: number;
  last_seen_day: string;
}

export interface WeekRow {
  player_id: string;
  week: string;
  points: number; points_at: number;
  words: number; words_at: number;
  tower: number; tower_at: number;
  snake: number; snake_at: number;
  comet: number; comet_at: number;
}

export const CATEGORIES = ["overall", "words", ...GAMES] as const;
export type Category = (typeof CATEGORIES)[number];
/** Category -> weekly_scores column. Only these fixed strings are ever put into SQL. */
export const COLUMN: Record<Category, "points" | "words" | Game> = {
  overall: "points", words: "words", tower: "tower", snake: "snake", comet: "comet",
};

/** Resolves the bearer token to a player. Also counts the per-token rate limit. */
export async function authenticate(request: Request, env: Env, now: number): Promise<PlayerRow> {
  const header = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(spk_[A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!m) throw unauthorized();
  const hash = await sha256Hex(m[1]);
  const player = await env.DB.prepare("SELECT * FROM players WHERE token_hash = ?1").bind(hash).first<PlayerRow>();
  if (!player) throw unauthorized("Unknown token. The player may have left or was removed.");
  await hit(env, tokenKey(player.id), "tokenAll", now);
  const today = dayKey(now);
  if (player.last_seen_day !== today) {
    await env.DB.prepare("UPDATE players SET last_seen_day = ?1 WHERE id = ?2").bind(today, player.id).run();
    player.last_seen_day = today;
  }
  return player;
}

export function avatarUrl(p: Pick<PlayerRow, "id" | "avatar_key" | "avatar_hidden" | "avatar_version">): string | null {
  if (!p.avatar_key || p.avatar_hidden) return null;
  return `/v1/avatar/${p.id}?v=${p.avatar_version}`;
}

export function publicPlayer(p: PlayerRow) {
  return {
    id: p.id,
    name: p.name,
    titleId: p.title_id,
    rank: { tier: p.tier, division: p.division, rp: p.rp },
    avatar: avatarUrl(p),
  };
}

export async function getWeek(env: Env, playerId: string, week: string): Promise<WeekRow | null> {
  return env.DB.prepare("SELECT * FROM weekly_scores WHERE player_id = ?1 AND week = ?2").bind(playerId, week).first<WeekRow>();
}

/** 1-based position of a row in a category, same ordering as the leaderboard. null if not ranked. */
export async function rankOf(env: Env, week: string, cat: Category, row: WeekRow | null, player: PlayerRow): Promise<number | null> {
  const col = COLUMN[cat];
  if (!row || player.hidden || row[col] <= 0) return null;
  const at = row[`${col}_at` as keyof WeekRow] as number;
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS better FROM weekly_scores w JOIN players p ON p.id = w.player_id
     WHERE w.week = ?1 AND p.hidden = 0 AND w.${col} > 0
       AND (w.${col} > ?2 OR (w.${col} = ?2 AND (w.${col}_at < ?3 OR (w.${col}_at = ?3 AND p.id < ?4))))`,
  )
    .bind(week, row[col], at, player.id)
    .first<{ better: number }>();
  return (r?.better ?? 0) + 1;
}

function weekValues(row: WeekRow | null) {
  return {
    points: row?.points ?? 0,
    words: row?.words ?? 0,
    tower: row?.tower ?? 0,
    snake: row?.snake ?? 0,
    comet: row?.comet ?? 0,
  };
}

export function weekInfo(now: number) {
  const start = weekStart(now);
  return { key: isoWeek(now), startsAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * DAY).toISOString() };
}

/** The full view of the caller's own account (GET /v1/me and most write responses). */
export async function meView(env: Env, player: PlayerRow, now: number) {
  const week = isoWeek(now);
  const last = previousWeek(now);
  const [thisRow, lastRow] = await Promise.all([getWeek(env, player.id, week), getWeek(env, player.id, last)]);
  const [thisRank, lastRank] = await Promise.all([
    rankOf(env, week, "overall", thisRow, player),
    rankOf(env, last, "overall", lastRow, player),
  ]);
  return {
    player: {
      ...publicPlayer(player),
      bests: { tower: player.best_tower, snake: player.best_snake, comet: player.best_comet },
      createdAt: new Date(player.created_at).toISOString(),
      updatedAt: new Date(player.updated_at).toISOString(),
      moderation: { hidden: !!player.hidden, avatarHidden: !!player.avatar_hidden },
    },
    week: weekInfo(now),
    thisWeek: { ...weekValues(thisRow), rank: thisRank },
    lastWeek: lastRow ? { key: last, ...weekValues(lastRow), rank: lastRank } : null,
  };
}

/** Removes every trace of a player: rows (cascading) and all picture objects. */
export async function deletePlayer(env: Env, playerId: string): Promise<void> {
  const prefix = `avatars/${playerId}/`;
  let cursor: string | undefined;
  do {
    const list = await env.AVATARS.list({ prefix, cursor });
    if (list.objects.length) await env.AVATARS.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reports WHERE reporter_id = ?1 OR target_id = ?1").bind(playerId),
    env.DB.prepare("DELETE FROM score_batches WHERE player_id = ?1").bind(playerId),
    env.DB.prepare("DELETE FROM daily_usage WHERE player_id = ?1").bind(playerId),
    env.DB.prepare("DELETE FROM weekly_scores WHERE player_id = ?1").bind(playerId),
    env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE ?1").bind(`tok:${playerId}:%`),
    env.DB.prepare("DELETE FROM players WHERE id = ?1").bind(playerId),
  ]);
}
