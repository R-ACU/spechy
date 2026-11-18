// Guarded access to src/lib/leaderboard.ts (built by another agent) and to rank/RankBadge.tsx.
// import.meta.glob resolves to an empty map while a file does not exist, so Profile builds either way.
import type { ComponentType } from "react";

export interface LeaderboardApi {
  saveMyAvatar?: (bytes: Uint8Array, mime: string) => Promise<void>;
  getMyAvatar?: () => Promise<string | null>;
  removeMyAvatar?: () => Promise<void>;
  getStatus?: () => Promise<unknown>;
  join?: (...args: unknown[]) => Promise<unknown>;
  leave?: () => Promise<unknown>;
  updateMe?: (fields: { name?: string }) => Promise<void>;
  leaderboardErrorMessage?: (e: unknown) => string;
}

const lbMods = import.meta.glob("../../../lib/leaderboard.ts");
let lbCache: Promise<LeaderboardApi | null> | null = null;

/** The leaderboard module, or null while it does not exist. */
export function leaderboard(): Promise<LeaderboardApi | null> {
  const load = Object.values(lbMods)[0];
  if (!load) return Promise.resolve(null);
  lbCache ??= (load() as Promise<LeaderboardApi>).catch(() => null);
  return lbCache;
}

/** Joined? Tolerates the exact status shape. */
export function isJoined(status: unknown): boolean {
  return (status as { joined?: boolean } | null)?.joined === true;
}

/** False while no server is configured (release build before deployment). */
export function serverConfigured(status: unknown): boolean {
  return (status as { serverConfigured?: boolean } | null)?.serverConfigured !== false;
}

export function joinedName(status: unknown): string | null {
  return (status as { displayName?: string } | null)?.displayName ?? null;
}

/** This week's rank, if the status carries one. */
export function weekRank(status: unknown): number | null {
  const s = status as { thisWeek?: { rank?: number | null }; rank?: number | null } | null;
  const r = s?.thisWeek?.rank ?? s?.rank;
  return typeof r === "number" ? r : null;
}

export interface RankBadgeProps { tier: number; division: number | null; size?: number }
const badgeMods = import.meta.glob<{ default?: ComponentType<RankBadgeProps>; RankBadge?: ComponentType<RankBadgeProps> }>("../rank/RankBadge.tsx", { eager: true });
const badge = Object.values(badgeMods)[0];
/** Rank art from agent B; undefined until it exists (callers fall back to text). */
export const RankBadge: ComponentType<RankBadgeProps> | undefined = badge?.default ?? badge?.RankBadge;

// TODO leaderboard.ts: until saveMyAvatar/getMyAvatar exist the picture lives in memory only.
let memoryAvatar: string | null = null;
export async function loadAvatar(): Promise<string | null> {
  const lb = await leaderboard();
  if (lb?.getMyAvatar) return lb.getMyAvatar();
  return memoryAvatar;
}
/** Deletes the local picture and the server copy (when joined); the unlock stays owned. */
export async function removeAvatar(): Promise<void> {
  const lb = await leaderboard();
  if (lb?.removeMyAvatar) { await lb.removeMyAvatar(); return; }
  if (memoryAvatar) URL.revokeObjectURL(memoryAvatar);
  memoryAvatar = null;
}

export async function storeAvatar(bytes: Uint8Array, mime: string): Promise<string | null> {
  const lb = await leaderboard();
  if (lb?.saveMyAvatar) {
    await lb.saveMyAvatar(bytes, mime);
    return lb.getMyAvatar ? lb.getMyAvatar() : null;
  }
  // TODO leaderboard.ts
  if (memoryAvatar) URL.revokeObjectURL(memoryAvatar);
  memoryAvatar = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  return memoryAvatar;
}
