// TESTCODE (2026-11-18): browser stand-in for src-tauri/src/economy.rs, loaded only by
// src/lib/economy.ts in Vite dev without Tauri. Same rules, state in localStorage
// ("spechy.dev.economy"). Never part of a release bundle (dynamic import behind import.meta.env.DEV).
import { TITLES_BY_RARITY } from "./titles";
import type { BoxId, BoxOpening, EconomyState, EquipSlot, GameAward, GameId, Promotion, RankState, RankUpResult, TitleRarity, WeeklyPayout } from "./ipc";

const KEY = "spechy.dev.economy";
/** Mirror of EARN_BOOST_PERCENT and `boost` in economy.rs (half up, never below the input). */
const EARN_BOOST_PERCENT = 115;
const boost = (n: number) => Math.max(n, Math.floor((n * EARN_BOOST_PERCENT + 50) / 100));
const TIERS: { id: string; name: string; coins: number; box: BoxId | null; title: string | null }[] = [
  { id: "bronze", name: "Bronze", coins: 0, box: null, title: null },
  { id: "silver", name: "Silver", coins: boost(200), box: "basic", title: null },
  { id: "gold", name: "Gold", coins: boost(400), box: "premium", title: null },
  { id: "platinum", name: "Platinum", coins: boost(600), box: "premium", title: null },
  { id: "diamond", name: "Diamond", coins: boost(900), box: "mythic", title: null },
  { id: "master", name: "Master", coins: boost(1200), box: "mythic", title: null },
  { id: "champion", name: "Champion", coins: boost(2000), box: null, title: "Champion" },
];
const GAME_COIN_CAP = boost(217), ROUND_COIN_MAX = boost(30), BEST_BONUS = boost(15), DIVISION_COINS = boost(50);
const WEEKLY_PAYOUT = [boost(150), boost(100), boost(60)];
const dayCoins = (streak: number) => boost(Math.min(20, 10 + 2 * (Math.max(1, streak) - 1)));
const EARN_RATES = {
  boostPercent: EARN_BOOST_PERCENT, dayCoins: dayCoins(1), dayCoinsMax: boost(20), nextDayCoins: dayCoins(5), wordsCoins: boost(5),
  roundCoinMax: ROUND_COIN_MAX, bestBonus: BEST_BONUS, divisionCoins: DIVISION_COINS, tierCoins: TIERS.map((t) => t.coins), weeklyPayout: WEEKLY_PAYOUT,
};
const SHOP: Record<string, { kind: string; price: number }> = {
  "snake-neon": { kind: "snake-skin", price: 120 }, "tower-sunset": { kind: "tower-skin", price: 150 }, "comet-ice": { kind: "comet-skin", price: 180 },
  "pill-amber": { kind: "pill", price: 350 }, "pill-mint": { kind: "pill", price: 350 }, "pill-coral": { kind: "pill", price: 350 },
  bloom: { kind: "theme", price: 4000 }, genesis: { kind: "theme", price: 5000 }, horizon: { kind: "theme", price: 5500 },
  "profile-picture": { kind: "profile", price: 10000 },
};
const BOXES: Record<BoxId, { price: number; odds: [TitleRarity, number][]; pity: number | null }> = {
  basic: { price: 200, odds: [["common", 75], ["rare", 21], ["epic", 3.5], ["legendary", 0.5]], pity: null },
  premium: { price: 600, odds: [["common", 30], ["rare", 48], ["epic", 18], ["legendary", 4]], pity: null },
  mythic: { price: 1500, odds: [["rare", 35], ["epic", 48], ["legendary", 17]], pity: 8 },
};
const TITLES = TITLES_BY_RARITY;
const REFUND: Record<TitleRarity, number> = { common: 40, rare: 120, epic: 300, legendary: 750 };

interface Db {
  balance: number; unlimited: boolean; tier: number; division: number; rp: number; totalRp: number;
  boxes: Record<BoxId, { keys: number; opened: number; since: number }>;
  inventory: { itemId: string; kind: string; acquiredAt: number; source: string }[];
  equipped: Partial<Record<EquipSlot, string>>;
  daily: Record<string, Record<string, number>>;
  /** Earnings as [time ms, coins] for the weekly figure. */
  earned?: [number, number][];
  /** ISO weeks whose Monday payout was paid. */
  payouts?: string[];
}

/** Monday 00:00 UTC of the current ISO week (same as week_start_ms in economy.rs). */
function weekStart(now = Date.now()): number {
  const day = Math.floor(now / 86_400_000);
  return (day - (((day + 3) % 7) + 7) % 7) * 86_400_000;
}

const fresh = (): Db => ({
  balance: 1240, unlimited: false, tier: 2, division: 1, rp: 72, totalRp: 772,
  boxes: { basic: { keys: 0, opened: 0, since: 0 }, premium: { keys: 0, opened: 0, since: 0 }, mythic: { keys: 0, opened: 0, since: 0 } },
  inventory: [], equipped: {}, daily: {},
});

function load(): Db {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? ""); if (v && typeof v.balance === "number") return v; } catch { /* fresh */ }
  return fresh();
}
function save(db: Db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* blocked */ } }
const today = () => new Date().toISOString().slice(0, 10);

function rank(db: Db): RankState {
  const t = TIERS[db.tier];
  return { tier: db.tier, tierId: t.id, tierName: t.name, division: db.tier >= 6 ? null : db.division, rp: db.rp, totalRp: db.totalRp };
}

function view(db: Db): EconomyState {
  const d = db.daily[today()] ?? {};
  return {
    balance: db.balance, unlimited: db.unlimited, devTools: true, rank: rank(db),
    boxes: (Object.keys(BOXES) as BoxId[]).map((id) => ({ id, price: BOXES[id].price, keys: db.boxes[id].keys, opened: db.boxes[id].opened, sinceLegendary: db.boxes[id].since, pity: BOXES[id].pity })),
    inventory: db.inventory, equipped: db.equipped,
    today: { day: today(), gameCoins: d.gameCoins ?? 0, gameCoinCap: GAME_COIN_CAP, bestBonuses: d.bestBonuses ?? 0, bestBonusCap: 3 },
    streak: 4, wordsTowardNext: 480,
    weekEarned: (db.earned ?? []).filter(([t]) => t >= weekStart()).reduce((n, [, c]) => n + c, 0),
    earnRates: EARN_RATES,
  };
}

function addRp(db: Db, amount: number): Promotion[] {
  const out: Promotion[] = [];
  db.rp += amount; db.totalRp += amount;
  while (db.tier < 6 && db.rp >= 100) {
    db.rp -= 100;
    if (db.division < 2) {
      db.division += 1; db.balance += DIVISION_COINS;
      out.push({ kind: "division", tier: db.tier, tierName: TIERS[db.tier].name, division: db.division, coins: DIVISION_COINS, boxKey: null, title: null });
    } else {
      db.tier += 1; db.division = 0;
      const t = TIERS[db.tier];
      db.balance += t.coins;
      if (t.box) db.boxes[t.box].keys += 1;
      if (t.title) { db.inventory.push({ itemId: t.title, kind: "title", acquiredAt: Date.now(), source: "rank" }); db.equipped.title = t.title; }
      out.push({ kind: "tier", tier: db.tier, tierName: t.name, division: db.tier >= 6 ? null : 0, coins: t.coins, boxKey: t.box, title: t.title });
    }
  }
  return out;
}

export function state(): EconomyState { return view(load()); }

export function awardGame(game: GameId, score: number, newBest: boolean, quit: boolean): GameAward {
  const db = load();
  const d = (db.daily[today()] ??= {});
  score = Math.max(0, score);
  newBest = newBest && score > 0;
  const before = rank(db);
  // Coins: tower 1 per 2 floors, snake 1 per apple, comet 1 per 375 points, max 30 before the boost.
  const raw = game === "tower" ? Math.floor(score / 2) : game === "snake" ? score : Math.floor(score / 375);
  const base = boost(Math.min(30, raw));
  // RP stay on the old formulas (max 10 base coins).
  const rpRaw = game === "tower" ? Math.floor(score / 6) : game === "snake" ? Math.floor(score / 3) : Math.floor(score / 1000);
  const baseRaw = Math.min(10, rpRaw);
  const room = Math.max(0, GAME_COIN_CAP - (d.gameCoins ?? 0));
  const coins = Math.min(base, room);
  const bestCapHit = newBest && (d.bestBonuses ?? 0) >= 3;
  const bestBonus = newBest && !bestCapHit ? Math.min(BEST_BONUS, room - coins) : 0;
  const dailyCapHit = coins < base || (newBest && !bestCapHit && bestBonus < BEST_BONUS);
  if (newBest && !bestCapHit) d.bestBonuses = (d.bestBonuses ?? 0) + 1;
  d.gameCoins = (d.gameCoins ?? 0) + coins + bestBonus;
  db.balance += coins + bestBonus;
  (db.earned ??= []).push([Date.now(), coins + bestBonus]);
  const rp = (baseRaw > 0 ? Math.max(4, Math.round(baseRaw * 1.2)) : 0) + (newBest ? 6 : 0);
  const promotions = addRp(db, rp);
  save(db);
  return { game, score, newBest, quit, baseCoins: base, coins, bestBonus, total: coins + bestBonus, rp, dailyCapHit, bestCapHit, rankBefore: before, promotions, state: view(db) };
}

function pay(db: Db, price: number) {
  if (db.unlimited) return;
  if (db.balance < price) throw new Error("Not enough coins.");
  db.balance -= price;
}

export function buy(itemId: string): EconomyState {
  const db = load();
  const it = SHOP[itemId];
  if (!it) throw new Error(`Unknown item: ${itemId}`);
  if (db.inventory.some((i) => i.itemId === itemId)) throw new Error("You already own this.");
  pay(db, it.price);
  db.inventory.push({ itemId, kind: it.kind, acquiredAt: Date.now(), source: "shop" });
  save(db);
  return view(db);
}

// TESTCODE (2026-11-18): dev screenshots, `window.__spechyForceBox = { rarity: "legendary", duplicate: true }` fixes the next roll.
function forced(): { rarity?: TitleRarity; duplicate?: boolean } | null {
  const w = window as unknown as { __spechyForceBox?: { rarity?: TitleRarity; duplicate?: boolean } };
  return w.__spechyForceBox ?? null;
}

export function openBox(boxId: BoxId): BoxOpening {
  const db = load();
  const def = BOXES[boxId], b = db.boxes[boxId];
  const usedKey = b.keys > 0;
  if (usedKey) b.keys -= 1; else pay(db, def.price);
  let rarity: TitleRarity = def.odds[0][0], pityHit = false;
  const force = forced();
  if (force?.rarity) rarity = force.rarity;
  else if (def.pity && b.since >= def.pity - 1) { rarity = "legendary"; pityHit = true; }
  else { let x = Math.random() * 100; for (const [r, p] of def.odds) { if ((x -= p) < 0) { rarity = r; break; } } }
  let title = TITLES[rarity][Math.floor(Math.random() * TITLES[rarity].length)];
  if (force?.duplicate) title = db.inventory.find((i) => i.kind === "title" && TITLES[rarity].includes(i.itemId))?.itemId ?? title;
  b.opened += 1; b.since = rarity === "legendary" ? 0 : b.since + 1;
  const isNew = !db.inventory.some((i) => i.itemId === title);
  if (isNew) db.inventory.push({ itemId: title, kind: "title", acquiredAt: Date.now(), source: "box" });
  const refund = isNew ? 0 : REFUND[rarity];
  db.balance += refund;
  save(db);
  return { boxId, rarity, title, isNew, refund, usedKey, pityHit, state: view(db) };
}

export function equip(slot: EquipSlot, itemId: string | null): EconomyState {
  const db = load();
  if (itemId == null) delete db.equipped[slot];
  else {
    const it = db.inventory.find((i) => i.itemId === itemId);
    if (!it) throw new Error("You do not own this yet.");
    if (it.kind !== slot) throw new Error(`${itemId} does not fit the ${slot} slot.`);
    db.equipped[slot] = itemId;
  }
  save(db);
  return view(db);
}

/** Monday payout, once per week (claim_weekly_payout_with in economy.rs). */
export function claimWeeklyPayout(week: string, rank: number | null): WeeklyPayout | null {
  if (rank == null || rank < 1 || rank > 3) return null;
  const db = load();
  if ((db.payouts ??= []).includes(week)) return null;
  const coins = WEEKLY_PAYOUT[rank - 1];
  db.payouts.push(week);
  db.balance += coins;
  (db.earned ??= []).push([Date.now(), coins]);
  save(db);
  return { week, rank, coins, state: view(db) };
}

export function devSetUnlimited(on: boolean): EconomyState { const db = load(); db.unlimited = on; save(db); return view(db); }
export function devAddCoins(amount: number): EconomyState { const db = load(); db.balance += amount; save(db); return view(db); }
export function devRankUp(): RankUpResult {
  const db = load();
  if (db.tier >= 6) throw new Error("Already Champion.");
  const promotions = addRp(db, 100 - db.rp);
  save(db);
  return { promotions, state: view(db) };
}
export function devGrantKeys(boxId: BoxId, count: number): EconomyState { const db = load(); db.boxes[boxId].keys = Math.max(0, db.boxes[boxId].keys + count); save(db); return view(db); }
export function devReset(): EconomyState { const db = { ...fresh(), balance: 0, tier: 0, division: 0, rp: 0, totalRp: 0 }; save(db); return view(db); }
