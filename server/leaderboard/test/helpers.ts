import { env } from "cloudflare:test";
import { handleRequest } from "../src/index";

export const BASE = "https://lb.test";
export const ADMIN = "test-admin-token";
const DAY = 86_400_000;

let ipCounter = 0;
/** Every call gets its own fake client IP unless one is given, so per-IP join limits do not leak between tests. */
const nextIp = () => `198.51.${Math.floor(ipCounter / 250) % 250}.${ipCounter++ % 250}`;

let weekCounter = 0;
/** A Wednesday noon in a week no other test uses, so every test sees an empty leaderboard. */
export function freshWeek(): number {
  return Date.UTC(2030, 0, 2, 12) + weekCounter++ * 7 * DAY;
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
  now?: number;
  ip?: string;
  envOverride?: Record<string, unknown>;
}

export async function call(method: string, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.ip ?? nextIp(), ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] ??= "application/json";
  }
  const res = await handleRequest(
    new Request(BASE + path, { method, headers, body }),
    (opts.envOverride ? { ...env, ...opts.envOverride } : env) as typeof env,
    opts.now ?? Date.now(),
  );
  const type = res.headers.get("Content-Type") ?? "";
  const json = type.startsWith("application/json") ? ((await res.json()) as any) : null;
  return { status: res.status, json, res };
}

export async function joinPlayer(name: string, now = Date.now()) {
  const r = await call("POST", "/v1/join", { body: { name }, now });
  if (r.status !== 201) throw new Error(`join failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.player.id as string, token: r.json.token as string };
}

let batch = 0;
export const batchId = () => `batch-${Date.now()}-${batch++}`;

export async function score(token: string, body: Record<string, unknown>, now = Date.now()) {
  return call("POST", "/v1/scores", { token, body: { batchId: batchId(), ...body }, now });
}

// ---------- minimal image headers: the server only sniffs magic bytes and dimensions

export function png(w: number, h: number, size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

export function jpeg(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9, ...new Array(32).fill(0)]);
}

export function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 8);
  const W = w - 1, H = h - 1;
  b.set([W & 0xff, (W >> 8) & 0xff, (W >> 16) & 0xff, H & 0xff, (H >> 8) & 0xff, (H >> 16) & 0xff], 24);
  return b;
}

export function webpLossless(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBPVP8L"].map((c) => c.charCodeAt(0)), 8);
  const W = w - 1, H = h - 1;
  b[20] = 0x2f;
  b[21] = W & 0xff;
  b[22] = ((W >> 8) & 0x3f) | ((H & 0x03) << 6);
  b[23] = (H >> 2) & 0xff;
  b[24] = (H >> 10) & 0x0f;
  return b;
}
