import type { Env } from "../env";
import { LIMITS } from "../limits";
import { badRequest, json, notFound, readJson } from "../lib/http";
import { authenticate } from "../lib/players";
import { hit, tokenKey } from "../lib/ratelimit";

const KINDS = ["name", "avatar", "player"] as const;

/**
 * POST /v1/report { playerId, kind: "name"|"avatar"|"player", note? }
 * One report per reporter, target and kind (repeats are accepted but not counted twice).
 * Enough distinct avatar reports hide the picture until an admin reviews it.
 */
export async function postReport(request: Request, env: Env, now: number): Promise<Response> {
  const reporter = await authenticate(request, env, now);
  await hit(env, tokenKey(reporter.id), "tokenReport", now);
  const body = await readJson(request);
  const { playerId, kind } = body;
  if (typeof playerId !== "string" || !/^p_[0-9a-f]{16}$/.test(playerId)) throw badRequest("playerId is invalid", { field: "playerId" });
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    throw badRequest("kind must be name, avatar or player", { field: "kind" });
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > LIMITS.report.maxNote) {
      throw badRequest(`note must be a string of at most ${LIMITS.report.maxNote} characters`, { field: "note" });
    }
    note = body.note.trim() || null;
  }
  if (playerId === reporter.id) throw badRequest("You cannot report yourself", { field: "playerId" });
  const target = await env.DB.prepare("SELECT id, hidden FROM players WHERE id = ?1").bind(playerId).first<{ id: string; hidden: number }>();
  if (!target || target.hidden) throw notFound("Player not found");

  const res = await env.DB.prepare(
    `INSERT INTO reports (reporter_id, target_id, kind, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (reporter_id, target_id, kind) DO NOTHING`,
  )
    .bind(reporter.id, playerId, kind, note, now)
    .run();

  let avatarHidden = false;
  const threshold = Number(env.AUTO_HIDE_AVATAR_REPORTS ?? "3");
  if (kind === "avatar" && threshold > 0) {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_id = ?1 AND kind = 'avatar' AND status = 'open'")
      .bind(playerId)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= threshold) {
      await env.DB.prepare("UPDATE players SET avatar_hidden = 1 WHERE id = ?1").bind(playerId).run();
      avatarHidden = true;
    }
  }
  return json({ ok: true, duplicate: res.meta.changes === 0, avatarHidden }, 202);
}
