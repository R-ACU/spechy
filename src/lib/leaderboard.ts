// Opt-in leaderboard on the page. Contract for the Leaderboard and Profile views; the backend is
// src-tauri/src/leaderboard.rs, the server server/leaderboard/. Rules that hold here:
// - Nothing is requested before join(): getStatus() is local, every other call rejects with
//   code "not_joined" without touching the network (fetchAvatar included, no pictures either).
// - The token never reaches JavaScript; pictures come as bytes through Rust and become object URLs.
// - Score syncing happens in the backend after each game and dictation; views never call it.
// In Vite without Tauri (dev only) every call is answered by `leaderboardMock.ts`.
import {
  leaderboardApi,
  onLeaderboardChanged,
  type LeaderboardBoardRaw,
  type LeaderboardCategory,
  type LeaderboardError,
  type LeaderboardMeFields,
  type LeaderboardRowRaw,
  type LeaderboardStatus,
  type ReportKind,
  type WeeklyPayout,
} from "./ipc";
import { TITLES_BY_RARITY, RANK_TITLE } from "./titles";

export type { LeaderboardCategory, LeaderboardError, LeaderboardMeFields, LeaderboardStatus, ReportKind };

export interface Row {
  /** null only for your own row while you have no value in this category. */
  rank: number | null;
  playerId: string;
  name: string;
  /** Display name of the equipped title ("Night Owl"), when there is one. */
  title?: string;
  /** 0 Bronze .. 6 Champion. */
  tier: number;
  /** 0..2 for I..III (0 at Champion). */
  division: number;
  /** RP inside the division, 0..100. */
  rp: number;
  /** Category value: weekly points, words, or the week's best in a game. */
  score: number;
  hasAvatar: boolean;
  /** Part of the cache key of the picture; changes with a new picture. */
  avatarVersion?: string;
  me: boolean;
}

export interface Board {
  week: string;
  /** ISO timestamps; endsAt drives "Ends in 4 days". */
  startsAt: string;
  endsAt: string;
  total: number;
  rows: Row[];
  me?: Row;
}

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// The mock must stay out of release bundles: every check is written out as `import.meta.env.DEV && ...`
// at the call site, so the bundler sees a literal false and drops the dynamic import (a helper
// function hid that and shipped leaderboardMock.ts).

type Mock = typeof import("./leaderboardMock");
async function call<T>(real: () => Promise<T>, mock: (m: Mock) => Promise<T> | T): Promise<T> {
  if ((import.meta.env.DEV && !inTauri())) return mock(await import("./leaderboardMock"));
  return real();
}

function localError(code: string, message: string): LeaderboardError {
  return { code, message, reason: null, retryAfter: null, status: 0 };
}

// ---------- titles ----------
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
let slugMap: Map<string, string> | null = null;
/** "night-owl" -> "Night Owl". Unknown ids are made readable instead of dropped. */
export function titleName(titleId: string | null | undefined): string | undefined {
  if (!titleId) return undefined;
  if (!slugMap) {
    slugMap = new Map([RANK_TITLE, ...Object.values(TITLES_BY_RARITY).flat()].map((t) => [slug(t), t]));
  }
  return slugMap.get(titleId) ?? titleId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The title id the server uses for a title name ("Night Owl" -> "night-owl"). */
export const titleId = slug;

function toRow(r: LeaderboardRowRaw): Row {
  return {
    rank: r.rank,
    playerId: r.playerId,
    name: r.name,
    title: titleName(r.title),
    tier: r.tier,
    division: r.division,
    rp: r.rp,
    score: r.score,
    hasAvatar: r.hasAvatar,
    avatarVersion: r.avatarVersion ?? undefined,
    me: r.me,
  };
}

// ---------- calls ----------
/** Local only, never a request. */
export function getStatus(): Promise<LeaderboardStatus> {
  return call(() => leaderboardApi.status(), (m) => m.status());
}

export function join(displayName: string): Promise<LeaderboardStatus> {
  return call(() => leaderboardApi.join(displayName), (m) => m.join(displayName));
}

/** serverDeleted false: the server was unreachable, the backend retries the deletion on its own. */
export async function leave(): Promise<{ serverDeleted: boolean }> {
  const out = await call(() => leaderboardApi.leave(), (m) => m.leave());
  clearAvatarCache();
  return out;
}

const versions = new Map<string, string | undefined>();

export async function fetchBoard(cat: LeaderboardCategory): Promise<Board> {
  const raw: LeaderboardBoardRaw = await call(() => leaderboardApi.board(cat), (m) => m.board(cat));
  const rows = raw.rows.map(toRow);
  const me = raw.me ? toRow(raw.me) : undefined;
  for (const r of me ? [...rows, me] : rows) {
    if (versions.has(r.playerId) && versions.get(r.playerId) !== r.avatarVersion) dropCached(r.playerId);
    versions.set(r.playerId, r.avatarVersion);
  }
  return { week: raw.week, startsAt: raw.startsAt, endsAt: raw.endsAt, total: raw.total, rows, me };
}

// ---------- pictures ----------
const urls = new Map<string, string>(); // "playerId|version" -> URL
const inflight = new Map<string, Promise<string | null>>();
let mine: string | null = null;

const revoke = (u: string) => { if (u.startsWith("blob:")) URL.revokeObjectURL(u); };

function dropCached(playerId: string) {
  for (const k of [...urls.keys()]) {
    if (k.startsWith(`${playerId}|`)) {
      revoke(urls.get(k)!);
      urls.delete(k);
    }
  }
}

function clearAvatarCache() {
  urls.forEach(revoke);
  urls.clear();
  inflight.clear();
  versions.clear();
  if (mine) revoke(mine);
  mine = null;
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  return "image/webp";
}

function toObjectUrl(buf: ArrayBuffer | Uint8Array | number[]): string | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
  if (bytes.byteLength === 0) return null;
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffMime(bytes) }));
}

/** Picture of a player as an object URL (cached per session and picture version), or null.
 *  Call it for rows with `hasAvatar` only, and only after joining. */
export function fetchAvatar(playerId: string): Promise<string | null> {
  const key = `${playerId}|${versions.get(playerId) ?? ""}`;
  const hit = urls.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const url = (import.meta.env.DEV && !inTauri())
        ? await (await import("./leaderboardMock")).avatar(playerId)
        : toObjectUrl(await leaderboardApi.avatar(playerId));
      if (url) urls.set(key, url);
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function report(playerId: string, reason: ReportKind, note?: string): Promise<void> {
  return call(() => leaderboardApi.report(playerId, reason, note), (m) => m.report(playerId, reason));
}

/** Change the name on the server (title and rank follow the economy on their own). */
export function updateMe(fields: LeaderboardMeFields): Promise<void> {
  return call(() => leaderboardApi.updateMe(fields), (m) => m.updateMe(fields));
}

/** Follow joins, leaves, moderation and finished syncs (e.g. to refresh the board). Returns the unsubscribe. */
export function onChanged(cb: (s: LeaderboardStatus) => void): () => void {
  if ((import.meta.env.DEV && !inTauri())) {
    let off: (() => void) | null = null;
    let dead = false;
    void import("./leaderboardMock").then((m) => { if (!dead) off = m.subscribe(cb); });
    return () => { dead = true; off?.(); };
  }
  if (!inTauri()) return () => {};
  let un: (() => void) | null = null;
  let dead = false;
  void onLeaderboardChanged(cb).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
  return () => { dead = true; un?.(); };
}

// ---------- own picture ----------
export const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** The local profile picture as an object URL, or null. Works without joining. */
export async function getMyAvatar(): Promise<string | null> {
  if (mine) return mine;
  if ((import.meta.env.DEV && !inTauri())) {
    mine = await (await import("./leaderboardMock")).myAvatar();
    return mine;
  }
  try {
    mine = toObjectUrl(await leaderboardApi.myAvatar());
  } catch {
    mine = null;
  }
  return mine;
}

/** Stores the picture locally and uploads it when joined. Same rules as the server: PNG, JPEG or
 *  WEBP, square 32 to 1024 px, at most 256 KB (`prepareAvatar` gets a file there). Rejects with
 *  code "locked" until the profile picture is unlocked in the shop. */
export async function saveMyAvatar(bytes: Uint8Array, mime: string): Promise<void> {
  if (!AVATAR_TYPES.includes(mime)) throw localError("invalid", "Use a PNG, JPEG or WEBP picture.");
  if (bytes.byteLength > AVATAR_MAX_BYTES) throw localError("invalid", "The picture is larger than 256 KB.");
  await call(() => leaderboardApi.avatarSave(bytes, mime), (m) => m.saveMyAvatar(bytes, mime));
  if (mine) revoke(mine);
  mine = null;
}

/** Deletes the local picture and, when joined, the server copy. The unlock stays owned. */
export async function removeMyAvatar(): Promise<void> {
  await call(() => leaderboardApi.avatarRemove(), (m) => m.removeMyAvatar());
  if (mine) revoke(mine);
  mine = null;
}

// ---------- Monday payout ----------
let payoutRun: Promise<WeeklyPayout | null> | null = null;

/** Reads last week's rank (one request a week at most, none before joining) and pays the boosted 150, 100 or 60 (see EARN_BOOST_PERCENT in economy.rs)
 *  coins for rank 1, 2 or 3, once per week. Concurrent callers share one run. Never rejects. */
export function claimWeeklyPayout(): Promise<WeeklyPayout | null> {
  payoutRun ??= call(() => leaderboardApi.claimPayout(), (m) => m.claimPayout())
    .catch(() => null)
    .finally(() => { payoutRun = null; });
  return payoutRun;
}

/** Crop a chosen image to a centred square and scale it to 256 px (PNG, else WEBP, else smaller)
 *  so it fits in 256 KB. Feed the result to `saveMyAvatar`. */
export async function prepareAvatar(file: Blob): Promise<{ bytes: Uint8Array; mime: string }> {
  const bmp = await createImageBitmap(file);
  try {
    const side = Math.min(bmp.width, bmp.height);
    const sx = Math.floor((bmp.width - side) / 2);
    const sy = Math.floor((bmp.height - side) / 2);
    for (const size of [256, 192, 128, 64]) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
      for (const type of ["image/png", "image/webp"]) {
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
        if (blob && blob.type === type && blob.size <= AVATAR_MAX_BYTES) {
          return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: type };
        }
      }
    }
  } finally {
    bmp.close?.();
  }
  throw localError("invalid", "The picture could not be made small enough.");
}

/** A readable sentence for any rejection of the calls above. */
export function leaderboardErrorMessage(e: unknown): string {
  const err = e as Partial<LeaderboardError> | undefined;
  if (err?.code === "validation_failed" && err.reason) {
    return ({
      length: "Use 3 to 20 characters.",
      characters: "Use letters, digits, spaces, and _ . - only.",
      profanity: "That name is not allowed.",
      reserved: "That name is reserved.",
    } as Record<string, string>)[err.reason] ?? err.message ?? "That name is not accepted.";
  }
  if (err?.code === "rate_limited") return `Try again later${err.retryAfter ? ` (in ${err.retryAfter} s)` : ""}.`;
  return err?.message ?? (typeof e === "string" ? e : "Something went wrong.");
}
