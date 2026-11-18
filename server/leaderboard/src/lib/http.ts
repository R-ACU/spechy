import type { Env } from "../env";
import { LIMITS } from "../limits";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "validation_failed", message, {}, details);
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);
export const unauthorized = (message = "Missing or invalid token") =>
  new ApiError(401, "unauthorized", message, { "WWW-Authenticate": 'Bearer realm="spechy"' });
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...headers },
  });
}

/** Every error leaves the API in the same shape: { "error": { "code", "message", "details"? } }. */
export function errorResponse(err: ApiError): Response {
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.details !== undefined) body.details = err.details;
  return json({ error: body }, err.status, err.headers);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send JSON with Content-Type: application/json");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > LIMITS.maxJsonBytes) throw new ApiError(413, "payload_too_large", "JSON body too large");
  const text = await request.text();
  if (text.length > LIMITS.maxJsonBytes) throw new ApiError(413, "payload_too_large", "JSON body too large");
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_json", "Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

// ---------- CORS: only the app origins. Requests without Origin (native clients) need no CORS.

export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** null = no Origin header (native request), true/false = browser origin allowed or not. */
export function originAllowed(request: Request, env: Env): boolean | null {
  const origin = request.headers.get("Origin");
  if (origin === null) return null;
  return allowedOrigins(env).includes(origin);
}

export function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return response;
  const res = new Response(response.body, response);
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.append("Vary", "Origin");
  res.headers.set("Access-Control-Expose-Headers", "Retry-After, ETag");
  return res;
}

export function preflight(request: Request, env: Env): Response {
  if (originAllowed(request, env) !== true) {
    return errorResponse(new ApiError(403, "origin_not_allowed", "Origin not allowed"));
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("Origin")!,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}
