// TESTCODE (2026-11-18): browser stand-in for src-tauri/src/leaderboard.rs, loaded only by
// src/lib/leaderboard.ts in Vite dev without Tauri (dynamic import behind import.meta.env.DEV).
// State in localStorage "spechy.dev.leaderboard": { joined, name, playerId, avatar }.
// Show the "server is not configured" state with localStorage["spechy.dev.leaderboard.unconfigured"] = "1".
// Monday payout: localStorage["spechy.dev.leaderboard.lastRank"] = "1" makes last week a rank 1 finish.
// Nothing here makes a network request.
import type { LeaderboardBoardRaw, LeaderboardCategory, LeaderboardMeFields, LeaderboardRowRaw, LeaderboardStatus, ReportKind } from "./ipc";
import { TITLES_BY_RARITY } from "./titles";

const KEY = "spechy.dev.leaderboard";
interface Saved { joined: boolean; name: string; playerId: string; avatar: string | null }
const subs = new Set<(s: LeaderboardStatus) => void>();

const empty = (): Saved => ({ joined: false, name: "", playerId: "", avatar: null });
const load = (): Saved => {
  try { return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return empty(); }
};
const save = (s: Saved) => localStorage.setItem(KEY, JSON.stringify(s));
const configured = () => localStorage.getItem(`${KEY}.unconfigured`) !== "1";
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const err = (code: string, message: string, reason: string | null = null) => ({ code, message, reason, retryAfter: null, status: 0 });
const ME_ID = "p_00000000000000ff";

export function status(): LeaderboardStatus {
  const s = load();
  return s.joined
    ? { joined: true, serverConfigured: true, displayName: s.name, playerId: s.playerId, hidden: false, avatarHidden: false }
    : { joined: false, serverConfigured: configured() };
}
const notify = () => subs.forEach((f) => f(status()));
export function subscribe(f: (s: LeaderboardStatus) => void) { subs.add(f); return () => { subs.delete(f); }; }

export async function join(name: string): Promise<LeaderboardStatus> {
  await wait();
  if (!configured()) throw err("not_configured", "The leaderboard server is not available in this build.");
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length < 3 || n.length > 20) throw err("validation_failed", "Name length", "length");
  if (!/^[A-Za-z0-9 _.-]+$/.test(n)) throw err("validation_failed", "Name characters", "characters");
  if (/fuck|shit/i.test(n)) throw err("validation_failed", "Name not allowed", "profanity");
  save({ ...load(), joined: true, name: n, playerId: ME_ID });
  notify();
  return status();
}

export async function leave() {
  await wait();
  save({ ...load(), joined: false, name: "", playerId: "" });
  notify();
  return { serverDeleted: true };
}

const NAMES = ["Mara", "Jonas", "Lio", "Kenji", "Aurora", "Paulo", "Nia", "Theo", "Sunny", "Echo", "Fynn", "Yara", "Bruno", "Ines", "Oskar", "Maya", "Leif", "Ravi", "Zoe", "Hugo"];
const ALL_TITLES = Object.values(TITLES_BY_RARITY).flat();
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const fakeId = (i: number) => "p_" + (i + 1).toString(16).padStart(16, "0");

function fakeRows(cat: LeaderboardCategory): LeaderboardRowRaw[] {
  const base = { overall: 2400, words: 18000, tower: 120, snake: 60, comet: 90000 }[cat];
  return NAMES.map((name, i) => ({
    rank: i + 1,
    playerId: fakeId(i),
    name,
    title: i % 3 === 0 ? null : slug(ALL_TITLES[(i * 7) % ALL_TITLES.length]),
    tier: Math.max(0, 6 - Math.floor(i / 3)),
    division: i % 3,
    rp: (i * 37) % 100,
    score: Math.round(base * Math.pow(0.82, i)),
    hasAvatar: i % 2 === 0,
    avatarVersion: i % 2 === 0 ? "1" : null,
    me: false,
  }));
}

export async function board(cat: LeaderboardCategory): Promise<LeaderboardBoardRaw> {
  await wait();
  const s = load();
  if (!s.joined) throw err("not_joined", "Join the leaderboard first.");
  const rows = fakeRows(cat);
  const me: LeaderboardRowRaw = {
    rank: 8, playerId: s.playerId, name: s.name, title: null, tier: 1, division: 1, rp: 40,
    score: Math.round(rows[6].score * 0.9), hasAvatar: !!s.avatar, avatarVersion: s.avatar ? "1" : null, me: true,
  };
  const out = [...rows.slice(0, 7), me, ...rows.slice(7).map((r) => ({ ...r, rank: (r.rank ?? 0) + 1 }))];
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  return {
    cat, week: "2026-W47", startsAt: monday.toISOString(), endsAt: new Date(monday.getTime() + 7 * 86_400_000).toISOString(), current: true,
    total: out.length, rows: out, me,
  };
}

/** Initial-on-colour SVG as a data URL; stands in for a picture. */
export async function avatar(playerId: string): Promise<string | null> {
  await wait(60);
  const s = load();
  if (playerId === s.playerId) return s.avatar;
  const i = parseInt(playerId.slice(2), 16) - 1;
  if (!(i >= 0 && i < NAMES.length && i % 2 === 0)) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${(i * 47) % 360} 55% 55%)"/><text x="32" y="43" font-size="32" font-family="sans-serif" text-anchor="middle" fill="white">${NAMES[i][0]}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export async function report(_playerId: string, _kind: ReportKind) {
  await wait();
  if (!load().joined) throw err("not_joined", "Join the leaderboard first.");
}

export async function updateMe(fields: LeaderboardMeFields) {
  await wait();
  const s = load();
  if (!s.joined) throw err("not_joined", "Join the leaderboard first.");
  if (fields.name) save({ ...s, name: fields.name });
  notify();
}

/** Last week's ISO key ("2026-W46"). */
function lastWeekKey(): string {
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  const monday = (day - (((day + 3) % 7) + 7) % 7) * 86_400_000;
  const thursday = new Date(monday - 7 * 86_400_000 + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export async function claimPayout() {
  await wait();
  if (!load().joined) return null;
  const rank = Number(localStorage.getItem(`${KEY}.lastRank`)) || null;
  const m = await import("./economyMock");
  return m.claimWeeklyPayout(lastWeekKey(), rank);
}

export async function removeMyAvatar() {
  await wait();
  save({ ...load(), avatar: null });
  notify();
}

export async function myAvatar(): Promise<string | null> {
  return load().avatar;
}

export async function saveMyAvatar(bytes: Uint8Array, mime: string) {
  await wait();
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  save({ ...load(), avatar: `data:${mime};base64,${btoa(bin)}` });
  notify();
}
