import type { Env } from "../env";
import { constantTimeEqual } from "../lib/crypto";
import { ApiError, badRequest, json, notFound, readJson, unauthorized } from "../lib/http";
import { avatarUrl, deletePlayer, type PlayerRow } from "../lib/players";
import { serveAvatarObject } from "./avatar";

async function requireAdmin(request: Request, env: Env): Promise<void> {
  if (!env.ADMIN_TOKEN) throw new ApiError(503, "admin_disabled", "Admin API is disabled (no ADMIN_TOKEN secret set)");
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!m || !(await constantTimeEqual(m[1], env.ADMIN_TOKEN))) throw unauthorized("Invalid admin token");
}

function adminPlayer(p: PlayerRow) {
  return {
    id: p.id,
    name: p.name,
    titleId: p.title_id,
    rank: { tier: p.tier, division: p.division, rp: p.rp },
    bests: { tower: p.best_tower, snake: p.best_snake, comet: p.best_comet },
    hasAvatar: !!p.avatar_key,
    avatar: avatarUrl(p),
    adminAvatar: p.avatar_key ? `/v1/admin/avatar/${p.id}` : null,
    hidden: !!p.hidden,
    avatarHidden: !!p.avatar_hidden,
    createdAt: new Date(p.created_at).toISOString(),
    lastSeenDay: p.last_seen_day,
  };
}

async function loadPlayer(env: Env, id: string): Promise<PlayerRow> {
  const p = await env.DB.prepare("SELECT * FROM players WHERE id = ?1").bind(id).first<PlayerRow>();
  if (!p) throw notFound("Player not found");
  return p;
}

/** Everything under /v1/admin/*, guarded by the ADMIN_TOKEN secret. */
export async function admin(request: Request, env: Env, now: number, path: string): Promise<Response> {
  await requireAdmin(request, env);
  const method = request.method;
  let m: RegExpExecArray | null;

  // GET /v1/admin/reports?status=open|resolved|all
  if (path === "/v1/admin/reports" && method === "GET") {
    const status = new URL(request.url).searchParams.get("status") ?? "open";
    if (!["open", "resolved", "all"].includes(status)) throw badRequest("status must be open, resolved or all");
    const rows = await env.DB.prepare(
      `SELECT r.id, r.reporter_id, r.target_id, r.kind, r.note, r.status, r.created_at, r.resolved_at,
              p.name AS target_name, p.hidden AS target_hidden, p.avatar_hidden AS target_avatar_hidden
       FROM reports r JOIN players p ON p.id = r.target_id
       WHERE (?1 = 'all' OR r.status = ?1) ORDER BY r.created_at DESC LIMIT 500`,
    )
      .bind(status)
      .all<Record<string, unknown>>();
    return json({
      reports: rows.results.map((r) => ({
        id: r.id,
        reporterId: r.reporter_id,
        targetId: r.target_id,
        targetName: r.target_name,
        kind: r.kind,
        note: r.note,
        status: r.status,
        targetHidden: !!r.target_hidden,
        targetAvatarHidden: !!r.target_avatar_hidden,
        createdAt: new Date(r.created_at as number).toISOString(),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at as number).toISOString() : null,
      })),
    });
  }

  // POST /v1/admin/reports/:id/resolve
  if ((m = /^\/v1\/admin\/reports\/(\d+)\/resolve$/.exec(path)) && method === "POST") {
    const res = await env.DB.prepare("UPDATE reports SET status = 'resolved', resolved_at = ?1 WHERE id = ?2").bind(now, Number(m[1])).run();
    if (res.meta.changes === 0) throw notFound("Report not found");
    return json({ ok: true });
  }

  // GET /v1/admin/avatar/:id  (review a picture even if it is hidden)
  if ((m = /^\/v1\/admin\/avatar\/(p_[0-9a-f]{16})$/.exec(path)) && method === "GET") {
    return serveAvatarObject(request, env, await loadPlayer(env, m[1]), "no-store");
  }

  m = /^\/v1\/admin\/players\/(p_[0-9a-f]{16})(\/moderate)?$/.exec(path);
  if (m) {
    const id = m[1];
    if (!m[2] && method === "GET") return json({ player: adminPlayer(await loadPlayer(env, id)) });
    if (!m[2] && method === "DELETE") {
      await loadPlayer(env, id);
      await deletePlayer(env, id);
      return new Response(null, { status: 204 });
    }
    // POST /v1/admin/players/:id/moderate { hidden?, avatarHidden?, resetName?, resolveReports? }
    if (m[2] && method === "POST") {
      const p = await loadPlayer(env, id);
      const body = await readJson(request);
      for (const k of ["hidden", "avatarHidden", "resetName", "resolveReports"]) {
        if (body[k] !== undefined && typeof body[k] !== "boolean") throw badRequest(`${k} must be a boolean`, { field: k });
      }
      const hidden = body.hidden === undefined ? p.hidden : body.hidden ? 1 : 0;
      const avatarHidden = body.avatarHidden === undefined ? p.avatar_hidden : body.avatarHidden ? 1 : 0;
      const name = body.resetName ? `Speaker ${1000 + Math.floor(Math.random() * 9000)}` : p.name;
      const stmts = [
        env.DB.prepare("UPDATE players SET hidden = ?1, avatar_hidden = ?2, name = ?3, updated_at = ?4 WHERE id = ?5")
          .bind(hidden, avatarHidden, name, now, id),
      ];
      if (body.resolveReports !== false) {
        stmts.push(env.DB.prepare("UPDATE reports SET status = 'resolved', resolved_at = ?1 WHERE target_id = ?2 AND status = 'open'").bind(now, id));
      }
      await env.DB.batch(stmts);
      return json({ player: adminPlayer(await loadPlayer(env, id)) });
    }
  }

  throw notFound("Unknown admin endpoint");
}
