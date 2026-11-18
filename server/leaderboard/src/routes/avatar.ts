import type { Env } from "../env";
import { LIMITS } from "../limits";
import { ApiError, forbidden, json, notFound } from "../lib/http";
import { EXT, sniffImage } from "../lib/image";
import { authenticate, meView, type PlayerRow } from "../lib/players";
import { hit, tokenKey } from "../lib/ratelimit";

async function readLimitedBody(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > max) throw new ApiError(413, "payload_too_large", `Picture must be at most ${max / 1024} KB`);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ApiError(413, "payload_too_large", `Picture must be at most ${max / 1024} KB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** PUT /v1/me/avatar: raw image bytes as body (PNG, JPEG or WEBP, square, max 256 KB). */
export async function putAvatar(request: Request, env: Env, now: number): Promise<Response> {
  const player = await authenticate(request, env, now);
  await hit(env, tokenKey(player.id), "tokenAvatar", now);
  if (player.avatar_hidden) {
    throw forbidden("avatar_locked", "Your picture was hidden by moderation. Uploads are locked until it is reviewed.");
  }
  const bytes = await readLimitedBody(request, LIMITS.avatar.maxBytes);
  if (bytes.byteLength === 0) throw new ApiError(400, "validation_failed", "Empty body, send the image bytes");
  const info = sniffImage(bytes);
  if (!info) throw new ApiError(415, "unsupported_media_type", "Only PNG, JPEG and WEBP pictures are allowed");
  const { minSide, maxSide } = LIMITS.avatar;
  if (info.width !== info.height) {
    throw new ApiError(400, "validation_failed", "Picture must be square", {}, { width: info.width, height: info.height });
  }
  if (info.width < minSide || info.width > maxSide) {
    throw new ApiError(400, "validation_failed", `Picture must be ${minSide} to ${maxSide} pixels wide`, {}, { width: info.width });
  }

  const version = player.avatar_version + 1;
  const key = `avatars/${player.id}/${version}.${EXT[info.type]}`;
  await env.AVATARS.put(key, bytes, { httpMetadata: { contentType: info.type } });
  await env.DB.prepare("UPDATE players SET avatar_key = ?1, avatar_type = ?2, avatar_version = ?3, updated_at = ?4 WHERE id = ?5")
    .bind(key, info.type, version, now, player.id)
    .run();
  if (player.avatar_key) await env.AVATARS.delete(player.avatar_key);
  Object.assign(player, { avatar_key: key, avatar_type: info.type, avatar_version: version, updated_at: now });
  return json(await meView(env, player, now));
}

/** DELETE /v1/me/avatar: removes the picture from storage. A moderation lock stays in place. */
export async function deleteAvatar(request: Request, env: Env, now: number): Promise<Response> {
  const player = await authenticate(request, env, now);
  if (player.avatar_key) await env.AVATARS.delete(player.avatar_key);
  await env.DB.prepare("UPDATE players SET avatar_key = NULL, avatar_type = NULL, updated_at = ?1 WHERE id = ?2")
    .bind(now, player.id)
    .run();
  Object.assign(player, { avatar_key: null, avatar_type: null, updated_at: now });
  return json(await meView(env, player, now));
}

export async function serveAvatarObject(request: Request, env: Env, target: PlayerRow, cache: string): Promise<Response> {
  if (!target.avatar_key) throw notFound("No picture");
  const etag = `"${target.id}-${target.avatar_version}"`;
  const headers: Record<string, string> = {
    "Content-Type": target.avatar_type ?? "application/octet-stream",
    "Cache-Control": cache,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Disposition": "inline",
  };
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  const obj = await env.AVATARS.get(target.avatar_key);
  if (!obj) throw notFound("No picture");
  return new Response(obj.body, { status: 200, headers });
}

/**
 * GET /v1/avatar/:id: members only (bearer token), so nobody outside the leaderboard can pull pictures.
 * Hidden pictures and pictures of hidden players are never served.
 */
export async function getAvatar(request: Request, env: Env, now: number, id: string): Promise<Response> {
  const caller = await authenticate(request, env, now);
  const target = await env.DB.prepare("SELECT * FROM players WHERE id = ?1").bind(id).first<PlayerRow>();
  if (!target || target.avatar_hidden || (target.hidden && target.id !== caller.id)) throw notFound("No picture");
  return serveAvatarObject(request, env, target, `private, max-age=${LIMITS.avatar.cacheSeconds}`);
}
