import type { Env } from "../env";
import { LIMITS, type Game } from "../limits";
import { newPlayerId, newToken, sha256Hex } from "../lib/crypto";
import { badRequest, json, readJson } from "../lib/http";
import { authenticate, deletePlayer, meView, type PlayerRow } from "../lib/players";
import { hit, ipKey, tokenKey } from "../lib/ratelimit";
import { dayKey, isoWeek } from "../lib/time";
import { cleanName, cleanTitleId, intInRange, isGame } from "../lib/validate";

function readRank(body: Record<string, unknown>) {
  const out: { tier?: number; division?: number; rp?: number } = {};
  if (body.tier !== undefined) out.tier = intInRange(body.tier, "tier", 0, LIMITS.rank.maxTier);
  if (body.division !== undefined) out.division = intInRange(body.division, "division", 0, LIMITS.rank.maxDivision);
  if (body.rp !== undefined) out.rp = intInRange(body.rp, "rp", 0, LIMITS.rank.maxRp);
  return out;
}

/** POST /v1/join: creates an anonymous player. The token is returned exactly once. */
export async function join(request: Request, env: Env, now: number): Promise<Response> {
  await hit(env, await ipKey(request, env), "ipJoin", now);
  const body = await readJson(request);
  const name = body.name === undefined ? `Speaker ${1000 + Math.floor(Math.random() * 9000)}` : cleanName(body.name);
  const titleId = body.titleId === undefined ? null : cleanTitleId(body.titleId);
  const rank = readRank(body);

  const id = newPlayerId();
  const token = newToken();
  await env.DB.prepare(
    `INSERT INTO players (id, token_hash, name, title_id, tier, division, rp, created_at, updated_at, last_seen_day)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
  )
    .bind(id, await sha256Hex(token), name, titleId, rank.tier ?? 0, rank.division ?? 0, rank.rp ?? 0, now, dayKey(now))
    .run();
  const player = await env.DB.prepare("SELECT * FROM players WHERE id = ?1").bind(id).first<PlayerRow>();
  return json({ token, ...(await meView(env, player!, now)) }, 201);
}

export async function getMe(request: Request, env: Env, now: number): Promise<Response> {
  const player = await authenticate(request, env, now);
  return json(await meView(env, player, now));
}

/** PUT /v1/me: partial update of name, titleId, tier, division, rp. */
export async function putMe(request: Request, env: Env, now: number): Promise<Response> {
  const player = await authenticate(request, env, now);
  await hit(env, tokenKey(player.id), "tokenProfile", now);
  const body = await readJson(request);
  const known = new Set(["name", "titleId", "tier", "division", "rp"]);
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length) throw badRequest(`Unknown fields: ${unknown.join(", ")}`, { fields: unknown });

  const next = {
    name: body.name === undefined ? player.name : cleanName(body.name),
    title_id: body.titleId === undefined ? player.title_id : cleanTitleId(body.titleId),
    ...{ tier: player.tier, division: player.division, rp: player.rp },
    ...readRank(body),
  };
  await env.DB.prepare(
    "UPDATE players SET name = ?1, title_id = ?2, tier = ?3, division = ?4, rp = ?5, updated_at = ?6 WHERE id = ?7",
  )
    .bind(next.name, next.title_id, next.tier, next.division, next.rp, now, player.id)
    .run();
  Object.assign(player, next, { updated_at: now });
  return json(await meView(env, player, now));
}

/** DELETE /v1/me: leaving deletes everything, including the picture. */
export async function deleteMe(request: Request, env: Env, now: number): Promise<Response> {
  const player = await authenticate(request, env, now);
  await deletePlayer(env, player.id);
  return new Response(null, { status: 204 });
}

interface GameResult { game: Game; score: number }

/**
 * POST /v1/scores: adds weekly points and words (deltas since the last sync) and game results.
 * `batchId` makes the call idempotent: a retried batch is never counted twice.
 * Per-request limits reject the call, per-day limits clamp it (accepted amounts are returned).
 */
export async function postScores(request: Request, env: Env, now: number): Promise<Response> {
  const player = await authenticate(request, env, now);
  await hit(env, tokenKey(player.id), "tokenScores", now);
  const body = await readJson(request);
  const req = LIMITS.scores.perRequest;

  const batchId = body.batchId;
  if (typeof batchId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(batchId)) {
    throw badRequest("batchId must be 8 to 64 characters of A-Z a-z 0-9 _ - (a fresh UUID per sync)", { field: "batchId" });
  }
  const points = body.points === undefined ? 0 : intInRange(body.points, "points", 0, req.points);
  const words = body.words === undefined ? 0 : intInRange(body.words, "words", 0, req.words);
  const rawGames = body.games === undefined ? [] : body.games;
  if (!Array.isArray(rawGames) || rawGames.length > req.games) {
    throw badRequest(`games must be an array with at most ${req.games} results`, { field: "games" });
  }
  const games: GameResult[] = rawGames.map((g, i) => {
    if (typeof g !== "object" || g === null || !isGame((g as GameResult).game)) {
      throw badRequest(`games[${i}].game must be tower, snake or comet`, { field: `games[${i}].game` });
    }
    const game = (g as GameResult).game;
    const score = intInRange((g as GameResult).score, `games[${i}].score`, 0, LIMITS.scores.maxGameScore[game]);
    return { game, score };
  });

  const duplicate = await env.DB.prepare("SELECT 1 FROM score_batches WHERE player_id = ?1 AND batch_id = ?2")
    .bind(player.id, batchId)
    .first();
  if (duplicate) {
    return json({ duplicate: true, accepted: { points: 0, words: 0, games: 0 }, capped: false, ...(await meView(env, player, now)) });
  }

  const day = dayKey(now);
  const week = isoWeek(now);
  const usage = (await env.DB.prepare("SELECT points, words, games FROM daily_usage WHERE player_id = ?1 AND day = ?2")
    .bind(player.id, day)
    .first<{ points: number; words: number; games: number }>()) ?? { points: 0, words: 0, games: 0 };
  const cap = LIMITS.scores.perDay;
  const accPoints = Math.max(0, Math.min(points, cap.points - usage.points));
  const accWords = Math.max(0, Math.min(words, cap.words - usage.words));
  const accGames = games.slice(0, Math.max(0, cap.games - usage.games));
  const capped = accPoints < points || accWords < words || accGames.length < games.length;

  const best: Partial<Record<Game, number>> = {};
  for (const g of accGames) best[g.game] = Math.max(best[g.game] ?? 0, g.score);

  const db = env.DB;
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO score_batches (player_id, batch_id, created_at) VALUES (?1, ?2, ?3)").bind(player.id, batchId, now),
    db.prepare(
      `INSERT INTO daily_usage (player_id, day, points, words, games) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (player_id, day) DO UPDATE SET points = points + excluded.points,
         words = words + excluded.words, games = games + excluded.games`,
    ).bind(player.id, day, accPoints, accWords, accGames.length),
    db.prepare("INSERT INTO weekly_scores (player_id, week) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(player.id, week),
  ];
  if (accPoints > 0) {
    stmts.push(db.prepare("UPDATE weekly_scores SET points = points + ?1, points_at = ?2 WHERE player_id = ?3 AND week = ?4")
      .bind(accPoints, now, player.id, week));
  }
  if (accWords > 0) {
    stmts.push(db.prepare("UPDATE weekly_scores SET words = words + ?1, words_at = ?2 WHERE player_id = ?3 AND week = ?4")
      .bind(accWords, now, player.id, week));
  }
  for (const [game, score] of Object.entries(best) as [Game, number][]) {
    if (score <= 0) continue;
    // `game` is one of the fixed GAMES strings, safe to interpolate as a column name
    stmts.push(db.prepare(`UPDATE weekly_scores SET ${game} = ?1, ${game}_at = ?2 WHERE player_id = ?3 AND week = ?4 AND ${game} < ?1`)
      .bind(score, now, player.id, week));
    stmts.push(db.prepare(`UPDATE players SET best_${game} = ?1 WHERE id = ?2 AND best_${game} < ?1`).bind(score, player.id));
  }
  stmts.push(db.prepare("UPDATE players SET updated_at = ?1 WHERE id = ?2").bind(now, player.id));

  try {
    await db.batch(stmts); // one transaction: all or nothing
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      // the same batch raced in from a parallel retry, the other one counted it
      return json({ duplicate: true, accepted: { points: 0, words: 0, games: 0 }, capped: false, ...(await meView(env, player, now)) });
    }
    throw err;
  }

  const fresh = await db.prepare("SELECT * FROM players WHERE id = ?1").bind(player.id).first<PlayerRow>();
  return json({
    duplicate: false,
    accepted: { points: accPoints, words: accWords, games: accGames.length },
    capped,
    ...(await meView(env, fresh!, now)),
  });
}
