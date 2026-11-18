import { runDaily } from "./cron";
import type { Env } from "./env";
import { ApiError, errorResponse, forbidden, json, notFound, originAllowed, preflight, withCors } from "./lib/http";
import { hit, ipKey } from "./lib/ratelimit";
import { weekInfo } from "./lib/players";
import { admin } from "./routes/admin";
import { deleteAvatar, getAvatar, putAvatar } from "./routes/avatar";
import { getLeaderboard } from "./routes/leaderboard";
import { deleteMe, getMe, join, postScores, putMe } from "./routes/player";
import { postReport } from "./routes/report";

export type { Env };

type Handler = (request: Request, env: Env, now: number) => Promise<Response>;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/v1/join": { POST: join },
  "/v1/me": { GET: getMe, PUT: putMe, DELETE: deleteMe },
  "/v1/me/avatar": { PUT: putAvatar, DELETE: deleteAvatar },
  "/v1/scores": { POST: postScores },
  "/v1/leaderboard": { GET: getLeaderboard },
  "/v1/report": { POST: postReport },
};

async function route(request: Request, env: Env, now: number): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

  if (path === "/v1/health" && request.method === "GET") return json({ ok: true, week: weekInfo(now) });

  const methods = ROUTES[path];
  if (methods) {
    const handler = methods[request.method];
    if (!handler) {
      throw new ApiError(405, "method_not_allowed", `Use ${Object.keys(methods).join(", ")}`, { Allow: Object.keys(methods).join(", ") });
    }
    return handler(request, env, now);
  }

  const avatar = /^\/v1\/avatar\/(p_[0-9a-f]{16})$/.exec(path);
  if (avatar) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Use GET", { Allow: "GET" });
    return getAvatar(request, env, now, avatar[1]);
  }

  if (path.startsWith("/v1/admin/")) return admin(request, env, now, path);

  throw notFound("Unknown endpoint");
}

/** The whole HTTP API. `now` is injectable so tests can travel in time (weekly rollover). */
export async function handleRequest(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  try {
    if (request.method === "OPTIONS") return preflight(request, env);
    if (originAllowed(request, env) === false) throw forbidden("origin_not_allowed", "Origin not allowed");
    await hit(env, await ipKey(request, env), "ipAll", now);
    return withCors(await route(request, env, now), request, env);
  } catch (err) {
    if (err instanceof ApiError) return withCors(errorResponse(err), request, env);
    console.error("unhandled", err instanceof Error ? err.stack : err);
    return withCors(errorResponse(new ApiError(500, "internal_error", "Something went wrong")), request, env);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runDaily(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
