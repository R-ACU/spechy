//! Games economy: coins, rank, inventory, equipped items, title boxes.
//!
//! Coins are only earned, never bought. Everything lives in `spechy.db` (tables `econ_*`):
//! a wallet row, an append-only ledger, the inventory, equipped slots, the rank, box keys
//! with the Mythic pity counter, daily counters for the caps and a small meta table for the
//! dictation streak and the word carry. The rules are pure functions over a `Connection`
//! so the unit tests run against an in-memory database.
//!
//! Developer helpers (unlimited coins, add coins, rank up, keys, reset) exist only in debug
//! builds: their commands return an error in release, and the unlimited flag is ignored there.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::model::now_ms;

/// Event with the full `EconomyState` after a change the page did not ask for (dictation awards).
pub const EV_ECONOMY_CHANGED: &str = "spechy://economy-changed";

#[allow(dead_code)]
const DEV_ONLY: &str = "Developer tools are only available in debug builds.";

// ---------------------------------------------------------------- rules (single source of truth)

/// Global earnings multiplier in percent. Every coin the player EARNS (dictation, words, game
/// rounds, best bonus, daily game cap, division and tier rewards, Monday payout) is the base value
/// below run through `boost`. Not boosted: duplicate refunds, prices, dev grants and RP.
/// Change this one number to retune earnings (115 = +15 %).
pub const EARN_BOOST_PERCENT: i64 = 115;

/// `n` times `EARN_BOOST_PERCENT`, rounded half up, never below `n`.
pub const fn boost(n: i64) -> i64 {
    let b = (n * EARN_BOOST_PERCENT + 50).div_euclid(100);
    if b < n {
        n
    } else {
        b
    }
}

/// Daily ceiling for all coins from games (round coins plus best bonuses): 217 before the boost, 250 after.
pub const GAME_COIN_CAP: i64 = boost(217);
/// Coins for one round never exceed this: 30 before the boost, 35 after.
pub const ROUND_COIN_MAX: i64 = boost(ROUND_COIN_BASE_MAX);
/// Largest round payout before the boost.
const ROUND_COIN_BASE_MAX: i64 = 30;
/// Largest value of the old coin formula, which still drives the RP (see `round_rp_base`).
const ROUND_RP_BASE_MAX: i64 = 10;
/// Bonus for a new personal best, at most `BEST_BONUS_MAX` times a day: 15 before the boost.
pub const BEST_BONUS: i64 = boost(15);
pub const BEST_BONUS_MAX: i64 = 3;
/// Extra RP for a new best.
pub const BEST_RP: i64 = 6;
/// Minimum RP for a round that scored anything.
pub const ROUND_RP_MIN: i64 = 4;
/// Dictation: first dictation of a day, growing with the streak up to the max (base values,
/// `day_coins` applies the boost).
pub const DAY_COINS: i64 = 10;
pub const DAY_COINS_MAX: i64 = 20;
pub const DAY_COINS_STEP: i64 = 2;
/// Dictation: coins per full 1,000 words: 5 before the boost.
pub const WORDS_PER_REWARD: i64 = 1000;
pub const WORDS_COINS: i64 = boost(5);
/// RP for a dictation day (half the day coins) and per 1,000 words.
pub const WORDS_RP: i64 = 3;
/// RP per division; Champion has no divisions.
pub const RP_PER_DIVISION: i64 = 100;
/// Coins for a division up inside a tier: 50 before the boost.
pub const DIVISION_COINS: i64 = boost(50);
/// Unlocking a custom profile picture.
pub const PROFILE_PICTURE_PRICE: i64 = 10_000;
pub const PROFILE_PICTURE_ID: &str = "profile-picture";
/// Mythic box: a legendary title is guaranteed on the 8th opening without one.
pub const MYTHIC_PITY: i64 = 8;
/// Monday payout for the top three of last week's overall leaderboard (rank 1, 2, 3): 150, 100, 60
/// before the boost.
pub const WEEKLY_PAYOUT: [i64; 3] = [boost(150), boost(100), boost(60)];
/// Ledger reasons that count as earned for the shop's "this week" figure.
const EARNED_REASONS: &str = "'game', 'best_bonus', 'dictation_day', 'words', 'division', 'promotion', 'weekly-payout'";

pub struct Tier {
    pub id: &'static str,
    pub name: &'static str,
    pub coins: i64,
    pub box_key: Option<&'static str>,
    pub title: Option<&'static str>,
}

pub const TIERS: [Tier; 7] = [
    Tier { id: "bronze", name: "Bronze", coins: 0, box_key: None, title: None },
    Tier { id: "silver", name: "Silver", coins: boost(200), box_key: Some("basic"), title: None },
    Tier { id: "gold", name: "Gold", coins: boost(400), box_key: Some("premium"), title: None },
    Tier { id: "platinum", name: "Platinum", coins: boost(600), box_key: Some("premium"), title: None },
    Tier { id: "diamond", name: "Diamond", coins: boost(900), box_key: Some("mythic"), title: None },
    Tier { id: "master", name: "Master", coins: boost(1200), box_key: Some("mythic"), title: None },
    Tier { id: "champion", name: "Champion", coins: boost(2000), box_key: None, title: Some("Champion") },
];
const CHAMPION: i64 = 6;
const DIVISIONS: i64 = 3;

/// Round coins before the boost and before caps: `min(30, f(score))`. A good minute lands at about
/// 22 to 26 (25 to 30 boosted): Pixel Tower 1 coin per 2 floors (about 40 to 60 floors),
/// Voice Snake 1 coin per apple (about 20 to 26), Comet Keeper 1 coin per 375 points (about 9,000).
pub fn round_base(game: &str, score: i64) -> i64 {
    let s = score.max(0);
    let raw = match game {
        "tower" => s / 2,
        "snake" => s,
        "comet" => s / 375,
        _ => 0,
    };
    raw.min(ROUND_COIN_BASE_MAX)
}

/// The old round coin formula (before the boost, max 10). RP are computed from this and must not
/// grow when the coin formulas are retuned.
pub fn round_rp_base(game: &str, score: i64) -> i64 {
    let s = score.max(0);
    let raw = match game {
        "tower" => s / 6,
        "snake" => s / 3,
        "comet" => s / 1000,
        _ => 0,
    };
    raw.min(ROUND_RP_BASE_MAX)
}

/// Coins for one game round before the daily cap: the boosted `round_base` (at most `ROUND_COIN_MAX`).
pub fn round_coins(game: &str, score: i64) -> i64 {
    boost(round_base(game, score))
}

/// RP for a round: about 1.2 x the round coins (before caps), at least 4 when the round
/// earned anything, plus 6 for a new best.
pub fn round_rp(base_coins: i64, new_best: bool) -> i64 {
    let rp = if base_coins > 0 { ((base_coins as f64) * 1.2).round() as i64 } else { 0 };
    let rp = if base_coins > 0 { rp.max(ROUND_RP_MIN) } else { 0 };
    rp + if new_best { BEST_RP } else { 0 }
}

/// Day coins before the boost at the given streak (1 = first day). Half of it is the RP.
pub fn day_coins_base(streak: i64) -> i64 {
    (DAY_COINS + DAY_COINS_STEP * (streak.max(1) - 1)).min(DAY_COINS_MAX)
}

/// Coins for the first dictation of a day at the given streak (1 = first day), boosted.
pub fn day_coins(streak: i64) -> i64 {
    boost(day_coins_base(streak))
}

// ---------------------------------------------------------------- catalogue

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    Theme,
    Pill,
    TowerSkin,
    SnakeSkin,
    CometSkin,
    Profile,
    Title,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Theme => "theme",
            ItemKind::Pill => "pill",
            ItemKind::TowerSkin => "tower-skin",
            ItemKind::SnakeSkin => "snake-skin",
            ItemKind::CometSkin => "comet-skin",
            ItemKind::Profile => "profile",
            ItemKind::Title => "title",
        }
    }
}

pub struct ShopItem {
    pub id: &'static str,
    pub kind: ItemKind,
    pub price: i64,
}

/// Buyable items. Prices from cheap to expensive: game skins, pill, boxes, themes.
pub const SHOP: [ShopItem; 10] = [
    ShopItem { id: "snake-neon", kind: ItemKind::SnakeSkin, price: 120 },
    ShopItem { id: "tower-sunset", kind: ItemKind::TowerSkin, price: 150 },
    ShopItem { id: "comet-ice", kind: ItemKind::CometSkin, price: 180 },
    ShopItem { id: "pill-amber", kind: ItemKind::Pill, price: 350 },
    ShopItem { id: "pill-mint", kind: ItemKind::Pill, price: 350 },
    ShopItem { id: "pill-coral", kind: ItemKind::Pill, price: 350 },
    ShopItem { id: "bloom", kind: ItemKind::Theme, price: 4000 },
    ShopItem { id: "genesis", kind: ItemKind::Theme, price: 5000 },
    ShopItem { id: "horizon", kind: ItemKind::Theme, price: 5500 },
    ShopItem { id: PROFILE_PICTURE_ID, kind: ItemKind::Profile, price: PROFILE_PICTURE_PRICE },
];

pub fn shop_item(id: &str) -> Option<&'static ShopItem> {
    SHOP.iter().find(|i| i.id == id)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rarity {
    Common,
    Rare,
    Epic,
    Legendary,
}

impl Rarity {
    pub fn as_str(self) -> &'static str {
        match self {
            Rarity::Common => "common",
            Rarity::Rare => "rare",
            Rarity::Epic => "epic",
            Rarity::Legendary => "legendary",
        }
    }
    /// Coins back for a duplicate title.
    pub fn refund(self) -> i64 {
        match self {
            Rarity::Common => 40,
            Rarity::Rare => 120,
            Rarity::Epic => 300,
            Rarity::Legendary => 750,
        }
    }
    fn titles(self) -> &'static [&'static str] {
        match self {
            Rarity::Common => &TITLES_COMMON,
            Rarity::Rare => &TITLES_RARE,
            Rarity::Epic => &TITLES_EPIC,
            Rarity::Legendary => &TITLES_LEGENDARY,
        }
    }
}

pub struct BoxDef {
    pub id: &'static str,
    pub price: i64,
    /// Chances in percent, in order; they add up to 100.
    pub odds: &'static [(Rarity, f64)],
    /// Openings without a legendary after which the next one is guaranteed legendary.
    pub pity: Option<i64>,
}

pub const BOXES: [BoxDef; 3] = [
    BoxDef { id: "basic", price: 200, odds: &[(Rarity::Common, 75.0), (Rarity::Rare, 21.0), (Rarity::Epic, 3.5), (Rarity::Legendary, 0.5)], pity: None },
    BoxDef { id: "premium", price: 600, odds: &[(Rarity::Common, 30.0), (Rarity::Rare, 48.0), (Rarity::Epic, 18.0), (Rarity::Legendary, 4.0)], pity: None },
    BoxDef { id: "mythic", price: 1500, odds: &[(Rarity::Rare, 35.0), (Rarity::Epic, 48.0), (Rarity::Legendary, 17.0)], pity: Some(MYTHIC_PITY) },
];

pub fn box_def(id: &str) -> Option<&'static BoxDef> {
    BOXES.iter().find(|b| b.id == id)
}

pub const TITLES_COMMON: [&str; 50] = [
    "Talker", "Note Taker", "Early Bird", "Night Owl", "Coffee Fueled", "Inbox Zero", "Quick Draft", "Daydreamer", "Mumbler", "Chatterbox",
    "Rambler", "Thinker", "Desk Pilot", "Lunch Break Hero", "Sticky Note", "Plain Speaker", "Small Talker", "Snack Break", "Keyboard Retiree", "First Draft",
    "Voice Memo", "Typo Hunter", "Comma Fan", "Backspacer", "Mic Check", "Loud Thinker", "Spell Checker", "Autocorrected", "Tab Hoarder", "Late Riser",
    "Couch Writer", "Desk Plant", "Muted Mic", "Quiet Hour", "Pixel Stacker", "Snake Rookie", "Comet Spotter", "Ctrl Z", "Word Counter", "Bullet Pointer",
    "Draft Saver", "Hold to Talk", "Coffee Refill", "Hello World", "Long Pause", "Um Collector", "Sunday Typist", "Tea Sipper", "Power Napper", "Walk and Talk",
];
pub const TITLES_RARE: [&str; 38] = [
    "Wordsmith", "Speedtalker", "Silver Tongue", "Echo", "Voice Actor", "Podcaster", "Storyteller", "Tower Builder", "Snake Charmer", "Comet Chaser",
    "Midnight Writer", "Prompt Smith", "Polyglot", "Narrator", "Keyboard Ninja", "Fast Fingers", "Night Typist", "Focus Mode", "Deep Worker", "Sunrise Writer",
    "Wall of Text", "Essay Machine", "Tower Climber", "Snake Wrangler", "Comet Guard", "Hotkey Hero", "Clean Copy", "Streak Keeper", "Story Spinner", "Pun Master",
    "Rubber Duck", "Sudo Speaker", "Bug Squasher", "Mic Drop", "Live Wire", "Tongue Twister", "Brainstormer", "Caps Lock Rebel",
];
pub const TITLES_EPIC: [&str; 22] = [
    "Speedrunner", "Night Shift", "Golden Voice", "Prompt Whisperer", "Mind Reader", "Thunder Mouth", "Ghostwriter", "Orbit Keeper", "Grand Narrator", "Syntax Sage",
    "Word Wizard", "Sky Architect", "Serpent King", "Comet Warden", "Voice Conductor", "Zen Typist", "Silent Storm", "Dawn Breaker", "Lord of Drafts", "Keymaster",
    "Night Sovereign", "Mind Palace",
];
pub const TITLES_LEGENDARY: [&str; 10] = [
    "The Oracle", "Voice of Thunder", "Infinite Monologue", "Time Bender", "Event Horizon", "The Last Word", "Eternal Echo", "Star Forger", "Keeper of Words", "Supernova",
];

/// Rarity of a title; "Champion" is the rank title and has none.
pub fn title_rarity(title: &str) -> Option<Rarity> {
    [Rarity::Common, Rarity::Rare, Rarity::Epic, Rarity::Legendary].into_iter().find(|r| r.titles().contains(&title))
}

// ---------------------------------------------------------------- IPC types (mirror src/lib/ipc.ts)

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RankState {
    /// 0 Bronze .. 6 Champion.
    pub tier: i64,
    pub tier_id: String,
    pub tier_name: String,
    /// 0..2 for I..III; None for Champion.
    pub division: Option<i64>,
    /// RP inside the current division (0..99); keeps growing at Champion.
    pub rp: i64,
    pub total_rp: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxState {
    pub id: String,
    pub price: i64,
    pub keys: i64,
    pub opened: i64,
    /// Openings since the last legendary title (pity counter).
    pub since_legendary: i64,
    pub pity: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OwnedItem {
    pub item_id: String,
    pub kind: String,
    pub acquired_at: i64,
    /// "shop", "box", "rank" or "dev".
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyState {
    pub day: String,
    pub game_coins: i64,
    pub game_coin_cap: i64,
    pub best_bonuses: i64,
    pub best_bonus_cap: i64,
}

/// The effective (boosted) earning values, so the UI never hard-codes them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EarnRates {
    pub boost_percent: i64,
    /// First dictation of a day at streak 1.
    pub day_coins: i64,
    /// The streak ceiling of the day bonus.
    pub day_coins_max: i64,
    /// What the next dictation day pays (streak + 1).
    pub next_day_coins: i64,
    /// Per full 1,000 words.
    pub words_coins: i64,
    /// Largest round payout before the daily cap.
    pub round_coin_max: i64,
    pub best_bonus: i64,
    pub division_coins: i64,
    /// Tier promotion coins by tier index 0 Bronze .. 6 Champion.
    pub tier_coins: Vec<i64>,
    /// Monday payout for rank 1, 2, 3.
    pub weekly_payout: Vec<i64>,
}

pub fn earn_rates(streak: i64) -> EarnRates {
    EarnRates {
        boost_percent: EARN_BOOST_PERCENT,
        day_coins: day_coins(1),
        day_coins_max: boost(DAY_COINS_MAX),
        next_day_coins: day_coins(streak + 1),
        words_coins: WORDS_COINS,
        round_coin_max: ROUND_COIN_MAX,
        best_bonus: BEST_BONUS,
        division_coins: DIVISION_COINS,
        tier_coins: TIERS.iter().map(|t| t.coins).collect(),
        weekly_payout: WEEKLY_PAYOUT.to_vec(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EconomyState {
    pub balance: i64,
    /// Developer "unlimited coins": purchases do not reduce the balance. Always false in release.
    pub unlimited: bool,
    /// True in debug builds, where the developer commands work.
    pub dev_tools: bool,
    pub rank: RankState,
    pub boxes: Vec<BoxState>,
    pub inventory: Vec<OwnedItem>,
    /// Slot -> item id. Slots: "title", "theme", "pill", "tower-skin", "snake-skin", "comet-skin".
    pub equipped: std::collections::BTreeMap<String, String>,
    pub today: DailyState,
    /// Consecutive dictation days up to the last one.
    pub streak: i64,
    /// Words counted toward the next 1,000-word reward.
    pub words_toward_next: i64,
    /// Coins earned this ISO week, Monday 00:00 UTC until now (games, bests, dictation, ranks,
    /// weekly payout; not refunds or dev grants). Same week as the leaderboard server.
    pub week_earned: i64,
    /// Effective earning values (with `EARN_BOOST_PERCENT`).
    pub earn_rates: EarnRates,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    /// "division" (inside a tier) or "tier" (a new league).
    pub kind: String,
    pub tier: i64,
    pub tier_name: String,
    pub division: Option<i64>,
    pub coins: i64,
    pub box_key: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameAward {
    pub game: String,
    pub score: i64,
    pub new_best: bool,
    pub quit: bool,
    /// Round coins before the daily cap: boosted min(30, f(score)), so at most 35.
    pub base_coins: i64,
    /// Round coins actually paid.
    pub coins: i64,
    /// Best bonus actually paid (0 or 17, less when the daily cap cut it).
    pub best_bonus: i64,
    /// coins + best_bonus.
    pub total: i64,
    pub rp: i64,
    /// The 250 a day game coin cap cut this award.
    pub daily_cap_hit: bool,
    /// A new best that got no bonus because 3 were paid today already.
    pub best_cap_hit: bool,
    /// Rank before the RP were added, so the UI can animate the bar.
    pub rank_before: RankState,
    /// Every division or tier crossed, in order. Their coins are already in the balance.
    pub promotions: Vec<Promotion>,
    pub state: EconomyState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictationAward {
    /// First dictation of the day bonus (0 if not the first).
    pub day_coins: i64,
    pub words_coins: i64,
    pub rp: i64,
    pub promotions: Vec<Promotion>,
    pub state: EconomyState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxOpening {
    pub box_id: String,
    pub rarity: String,
    pub title: String,
    pub is_new: bool,
    /// Coins back for a duplicate.
    pub refund: i64,
    pub used_key: bool,
    /// The pity rule forced this legendary.
    pub pity_hit: bool,
    pub state: EconomyState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RankUpResult {
    pub promotions: Vec<Promotion>,
    pub state: EconomyState,
}

// ---------------------------------------------------------------- schema

pub fn init_schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS econ_wallet (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            balance INTEGER NOT NULL DEFAULT 0,
            unlimited INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO econ_wallet (id, balance, unlimited) VALUES (1, 0, 0);
         CREATE TABLE IF NOT EXISTS econ_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            reason TEXT NOT NULL,
            amount INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            detail TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS econ_inventory (
            item_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            acquired_at INTEGER NOT NULL,
            source TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS econ_equipped (
            slot TEXT PRIMARY KEY,
            item_id TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS econ_rank (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            tier INTEGER NOT NULL DEFAULT 0,
            division INTEGER NOT NULL DEFAULT 0,
            rp INTEGER NOT NULL DEFAULT 0,
            total_rp INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO econ_rank (id, tier, division, rp, total_rp) VALUES (1, 0, 0, 0, 0);
         CREATE TABLE IF NOT EXISTS econ_boxes (
            box_id TEXT PRIMARY KEY,
            keys INTEGER NOT NULL DEFAULT 0,
            opened INTEGER NOT NULL DEFAULT 0,
            since_legendary INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO econ_boxes (box_id) VALUES ('basic'), ('premium'), ('mythic');
         CREATE TABLE IF NOT EXISTS econ_daily (
            day TEXT NOT NULL,
            counter TEXT NOT NULL,
            value INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, counter)
         );
         CREATE TABLE IF NOT EXISTS econ_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("Could not create the economy tables: {e}"))
}

// ---------------------------------------------------------------- helpers

fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| format!("Economy storage failed: {e}"))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn balance(c: &Connection) -> Result<i64, String> {
    sql(c.query_row("SELECT balance FROM econ_wallet WHERE id = 1", [], |r| r.get(0)))
}

fn unlimited(c: &Connection) -> Result<bool, String> {
    #[cfg(debug_assertions)]
    {
        sql(c.query_row("SELECT unlimited FROM econ_wallet WHERE id = 1", [], |r| r.get::<_, i64>(0))).map(|v| v != 0)
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = c;
        Ok(false)
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Monday 00:00 UTC of the ISO week that contains `now_ms` (the leaderboard server's week).
pub fn week_start_ms(now_ms: i64) -> i64 {
    let day = now_ms.div_euclid(DAY_MS);
    // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
    (day - (day + 3).rem_euclid(7)) * DAY_MS
}

/// Coins earned this ISO week (Monday 00:00 UTC until now): the shop's "this week" figure.
fn week_earned(c: &Connection) -> Result<i64, String> {
    sql(c.query_row(
        &format!("SELECT COALESCE(SUM(amount), 0) FROM econ_ledger WHERE created_at >= ?1 AND amount > 0 AND reason IN ({EARNED_REASONS})"),
        params![week_start_ms(now_ms())],
        |r| r.get(0),
    ))
}

/// Change the balance and append the ledger row. Never lets the balance go negative.
fn post(c: &Connection, reason: &str, amount: i64, detail: &str) -> Result<i64, String> {
    let after = balance(c)? + amount;
    if after < 0 {
        return Err("Not enough coins.".into());
    }
    sql(c.execute("UPDATE econ_wallet SET balance = ?1 WHERE id = 1", params![after]))?;
    sql(c.execute(
        "INSERT INTO econ_ledger (created_at, reason, amount, balance_after, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![now_ms(), reason, amount, after, detail],
    ))?;
    Ok(after)
}

/// Pay a price, or with unlimited coins on record it at 0 and keep the balance.
fn pay(c: &Connection, reason: &str, price: i64, detail: &str) -> Result<(), String> {
    if unlimited(c)? {
        post(c, reason, 0, &format!("{detail} (unlimited, price {price})"))?;
        return Ok(());
    }
    if balance(c)? < price {
        return Err("Not enough coins.".into());
    }
    post(c, reason, -price, detail).map(|_| ())
}

fn daily(c: &Connection, day: &str, counter: &str) -> Result<i64, String> {
    sql(c
        .query_row("SELECT value FROM econ_daily WHERE day = ?1 AND counter = ?2", params![day, counter], |r| r.get(0))
        .optional())
    .map(|v| v.unwrap_or(0))
}

fn add_daily(c: &Connection, day: &str, counter: &str, by: i64) -> Result<(), String> {
    sql(c.execute(
        "INSERT INTO econ_daily (day, counter, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(day, counter) DO UPDATE SET value = value + excluded.value",
        params![day, counter, by],
    ))
    .map(|_| ())
}

fn meta(c: &Connection, key: &str) -> Result<Option<String>, String> {
    sql(c.query_row("SELECT value FROM econ_meta WHERE key = ?1", params![key], |r| r.get(0)).optional())
}

fn set_meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    sql(c.execute("INSERT OR REPLACE INTO econ_meta (key, value) VALUES (?1, ?2)", params![key, value])).map(|_| ())
}

fn meta_i64(c: &Connection, key: &str) -> Result<i64, String> {
    Ok(meta(c, key)?.and_then(|v| v.parse().ok()).unwrap_or(0))
}

fn owns(c: &Connection, item_id: &str) -> Result<bool, String> {
    sql(c.query_row("SELECT COUNT(*) FROM econ_inventory WHERE item_id = ?1", params![item_id], |r| r.get::<_, i64>(0))).map(|n| n > 0)
}

fn add_item(c: &Connection, item_id: &str, kind: ItemKind, source: &str) -> Result<bool, String> {
    let n = sql(c.execute(
        "INSERT OR IGNORE INTO econ_inventory (item_id, kind, acquired_at, source) VALUES (?1, ?2, ?3, ?4)",
        params![item_id, kind.as_str(), now_ms(), source],
    ))?;
    Ok(n > 0)
}

fn add_keys(c: &Connection, box_id: &str, count: i64) -> Result<(), String> {
    box_def(box_id).ok_or_else(|| format!("Unknown box: {box_id}"))?;
    sql(c.execute("UPDATE econ_boxes SET keys = MAX(0, keys + ?2) WHERE box_id = ?1", params![box_id, count])).map(|_| ())
}

fn rank_row(c: &Connection) -> Result<(i64, i64, i64, i64), String> {
    sql(c.query_row("SELECT tier, division, rp, total_rp FROM econ_rank WHERE id = 1", [], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    }))
}

fn rank_state(c: &Connection) -> Result<RankState, String> {
    let (tier, division, rp, total_rp) = rank_row(c)?;
    let t = &TIERS[tier.clamp(0, CHAMPION) as usize];
    Ok(RankState {
        tier,
        tier_id: t.id.into(),
        tier_name: t.name.into(),
        division: if tier >= CHAMPION { None } else { Some(division) },
        rp,
        total_rp,
    })
}

/// Add RP, cross as many divisions as they reach and pay every promotion.
fn add_rp(c: &Connection, amount: i64) -> Result<Vec<Promotion>, String> {
    if amount <= 0 {
        return Ok(vec![]);
    }
    let (mut tier, mut division, mut rp, total) = rank_row(c)?;
    rp += amount;
    let mut promotions = vec![];
    while tier < CHAMPION && rp >= RP_PER_DIVISION {
        rp -= RP_PER_DIVISION;
        if division < DIVISIONS - 1 {
            division += 1;
            post(c, "division", DIVISION_COINS, &format!("{} {}", TIERS[tier as usize].name, division + 1))?;
            promotions.push(Promotion {
                kind: "division".into(),
                tier,
                tier_name: TIERS[tier as usize].name.into(),
                division: Some(division),
                coins: DIVISION_COINS,
                box_key: None,
                title: None,
            });
        } else {
            tier += 1;
            division = 0;
            let t = &TIERS[tier as usize];
            post(c, "promotion", t.coins, t.name)?;
            if let Some(b) = t.box_key {
                add_keys(c, b, 1)?;
            }
            if let Some(title) = t.title {
                add_item(c, title, ItemKind::Title, "rank")?;
                set_equipped(c, "title", title)?;
            }
            promotions.push(Promotion {
                kind: "tier".into(),
                tier,
                tier_name: t.name.into(),
                division: if tier >= CHAMPION { None } else { Some(0) },
                coins: t.coins,
                box_key: t.box_key.map(String::from),
                title: t.title.map(String::from),
            });
        }
    }
    sql(c.execute(
        "UPDATE econ_rank SET tier = ?1, division = ?2, rp = ?3, total_rp = ?4 WHERE id = 1",
        params![tier, division, rp, total + amount],
    ))?;
    Ok(promotions)
}

fn set_equipped(c: &Connection, slot: &str, item_id: &str) -> Result<(), String> {
    sql(c.execute("INSERT OR REPLACE INTO econ_equipped (slot, item_id) VALUES (?1, ?2)", params![slot, item_id])).map(|_| ())
}

/// Random number in [0, 1) without an extra crate (uuid v4 is random).
fn random_unit() -> f64 {
    let bits = (uuid::Uuid::new_v4().as_u128() >> 64) as u64 >> 11;
    bits as f64 / (1u64 << 53) as f64
}

fn random_index(len: usize) -> usize {
    ((random_unit() * len as f64) as usize).min(len.saturating_sub(1))
}

/// Pick a rarity from the odds; `x` in [0, 100).
fn roll_rarity(def: &BoxDef, since_legendary: i64, x: f64) -> (Rarity, bool) {
    if let Some(p) = def.pity {
        if since_legendary >= p - 1 {
            return (Rarity::Legendary, true);
        }
    }
    let mut left = x;
    for (r, chance) in def.odds {
        left -= chance;
        if left < 0.0 {
            return (*r, false);
        }
    }
    (def.odds[0].0, false)
}

// ---------------------------------------------------------------- core (testable, take a connection)

pub fn state_with(c: &Connection, day: &str) -> Result<EconomyState, String> {
    let boxes = {
        let mut stmt = sql(c.prepare("SELECT box_id, keys, opened, since_legendary FROM econ_boxes"))?;
        let rows = sql(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?))))?;
        let mut found: Vec<(String, i64, i64, i64)> = vec![];
        for row in rows {
            found.push(sql(row)?);
        }
        BOXES
            .iter()
            .map(|d| {
                let (keys, opened, since) = found.iter().find(|f| f.0 == d.id).map(|f| (f.1, f.2, f.3)).unwrap_or((0, 0, 0));
                BoxState { id: d.id.into(), price: d.price, keys, opened, since_legendary: since, pity: d.pity }
            })
            .collect()
    };
    let inventory = {
        let mut stmt = sql(c.prepare("SELECT item_id, kind, acquired_at, source FROM econ_inventory ORDER BY acquired_at, item_id"))?;
        let rows = sql(stmt.query_map([], |r| {
            Ok(OwnedItem { item_id: r.get(0)?, kind: r.get(1)?, acquired_at: r.get(2)?, source: r.get(3)? })
        }))?;
        let mut v = vec![];
        for row in rows {
            v.push(sql(row)?);
        }
        v
    };
    let equipped = {
        let mut stmt = sql(c.prepare("SELECT slot, item_id FROM econ_equipped"))?;
        let rows = sql(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?;
        let mut m = std::collections::BTreeMap::new();
        for row in rows {
            let (k, v) = sql(row)?;
            m.insert(k, v);
        }
        m
    };
    let streak = meta_i64(c, "streak")?;
    Ok(EconomyState {
        balance: balance(c)?,
        unlimited: unlimited(c)?,
        dev_tools: cfg!(debug_assertions),
        rank: rank_state(c)?,
        boxes,
        inventory,
        equipped,
        today: DailyState {
            day: day.into(),
            game_coins: daily(c, day, "game_coins")?,
            game_coin_cap: GAME_COIN_CAP,
            best_bonuses: daily(c, day, "best_bonuses")?,
            best_bonus_cap: BEST_BONUS_MAX,
        },
        streak,
        words_toward_next: meta_i64(c, "words_carry")?,
        week_earned: week_earned(c)?,
        earn_rates: earn_rates(streak),
    })
}

pub fn award_game_with(c: &Connection, day: &str, game: &str, score: i64, new_best: bool, quit: bool) -> Result<GameAward, String> {
    if !matches!(game, "tower" | "snake" | "comet") {
        return Err(format!("Unknown game: {game}"));
    }
    let score = score.max(0);
    // A best only counts when the round scored something.
    let new_best = new_best && score > 0;
    let rank_before = rank_state(c)?;
    let raw = round_base(game, score);
    let base = boost(raw);
    let room = (GAME_COIN_CAP - daily(c, day, "game_coins")?).max(0);
    let coins = base.min(room);
    let bests_today = daily(c, day, "best_bonuses")?;
    let best_cap_hit = new_best && bests_today >= BEST_BONUS_MAX;
    let best_bonus = if new_best && !best_cap_hit { BEST_BONUS.min(room - coins) } else { 0 };
    let daily_cap_hit = coins < base || (new_best && !best_cap_hit && best_bonus < BEST_BONUS);
    let detail = format!("{game} {score}{}", if quit { " (left)" } else { "" });
    if coins > 0 {
        post(c, "game", coins, &detail)?;
    }
    if best_bonus > 0 {
        post(c, "best_bonus", best_bonus, &detail)?;
    }
    if new_best && !best_cap_hit {
        add_daily(c, day, "best_bonuses", 1)?;
    }
    add_daily(c, day, "game_coins", coins + best_bonus)?;
    add_daily(c, day, "rounds", 1)?;
    let rp = round_rp(round_rp_base(game, score), new_best);
    let promotions = add_rp(c, rp)?;
    Ok(GameAward {
        game: game.into(),
        score,
        new_best,
        quit,
        base_coins: base,
        coins,
        best_bonus,
        total: coins + best_bonus,
        rp,
        daily_cap_hit,
        best_cap_hit,
        rank_before,
        promotions,
        state: state_with(c, day)?,
    })
}

/// A saved dictation: the first one of a day pays the day bonus (growing with the streak),
/// and every full 1,000 words pay `WORDS_COINS` coins. `prev_day` is the day before `day`.
pub fn award_dictation_with(c: &Connection, day: &str, prev_day: &str, words: i64) -> Result<DictationAward, String> {
    let mut day_coins_paid = 0;
    let mut rp = 0;
    let last = meta(c, "last_dictation_day")?;
    if last.as_deref() != Some(day) {
        let streak = if last.as_deref() == Some(prev_day) { meta_i64(c, "streak")? + 1 } else { 1 };
        set_meta(c, "streak", &streak.to_string())?;
        set_meta(c, "last_dictation_day", day)?;
        day_coins_paid = day_coins(streak);
        post(c, "dictation_day", day_coins_paid, &format!("streak {streak}"))?;
        rp += day_coins_base(streak) / 2;
    }
    let mut carry = meta_i64(c, "words_carry")? + words.max(0);
    let mut words_coins = 0;
    while carry >= WORDS_PER_REWARD {
        carry -= WORDS_PER_REWARD;
        words_coins += WORDS_COINS;
        rp += WORDS_RP;
    }
    set_meta(c, "words_carry", &carry.to_string())?;
    if words_coins > 0 {
        post(c, "words", words_coins, &format!("{} x 1,000 words", words_coins / WORDS_COINS))?;
    }
    let promotions = add_rp(c, rp)?;
    Ok(DictationAward { day_coins: day_coins_paid, words_coins, rp, promotions, state: state_with(c, day)? })
}

pub fn buy_with(c: &Connection, day: &str, item_id: &str) -> Result<EconomyState, String> {
    let item = shop_item(item_id).ok_or_else(|| format!("Unknown item: {item_id}"))?;
    if owns(c, item_id)? {
        return Err("You already own this.".into());
    }
    pay(c, "buy", item.price, item_id)?;
    add_item(c, item_id, item.kind, "shop")?;
    state_with(c, day)
}

pub fn open_box_with(c: &Connection, day: &str, box_id: &str, x: f64, pick: usize) -> Result<BoxOpening, String> {
    let def = box_def(box_id).ok_or_else(|| format!("Unknown box: {box_id}"))?;
    let (keys, since): (i64, i64) =
        sql(c.query_row("SELECT keys, since_legendary FROM econ_boxes WHERE box_id = ?1", params![box_id], |r| Ok((r.get(0)?, r.get(1)?))))?;
    let used_key = keys > 0;
    if used_key {
        sql(c.execute("UPDATE econ_boxes SET keys = keys - 1 WHERE box_id = ?1", params![box_id]))?;
        post(c, "box", 0, &format!("{box_id} (key)"))?;
    } else {
        pay(c, "box", def.price, box_id)?;
    }
    let (rarity, pity_hit) = roll_rarity(def, since, x);
    let list = rarity.titles();
    let title = list[pick % list.len()];
    let since_after = if rarity == Rarity::Legendary { 0 } else { since + 1 };
    sql(c.execute(
        "UPDATE econ_boxes SET opened = opened + 1, since_legendary = ?2 WHERE box_id = ?1",
        params![box_id, since_after],
    ))?;
    let is_new = add_item(c, title, ItemKind::Title, "box")?;
    let refund = if is_new { 0 } else { rarity.refund() };
    if refund > 0 {
        post(c, "refund", refund, title)?;
    }
    Ok(BoxOpening {
        box_id: box_id.into(),
        rarity: rarity.as_str().into(),
        title: title.into(),
        is_new,
        refund,
        used_key,
        pity_hit,
        state: state_with(c, day)?,
    })
}

/// Equip an owned item in a slot; `item_id` None clears the slot.
pub fn equip_with(c: &Connection, day: &str, slot: &str, item_id: Option<&str>) -> Result<EconomyState, String> {
    const SLOTS: [&str; 6] = ["title", "theme", "pill", "tower-skin", "snake-skin", "comet-skin"];
    if !SLOTS.contains(&slot) {
        return Err(format!("Unknown slot: {slot}"));
    }
    match item_id {
        None => {
            sql(c.execute("DELETE FROM econ_equipped WHERE slot = ?1", params![slot]))?;
        }
        Some(id) => {
            let kind: Option<String> =
                sql(c.query_row("SELECT kind FROM econ_inventory WHERE item_id = ?1", params![id], |r| r.get(0)).optional())?;
            let kind = kind.ok_or_else(|| "You do not own this yet.".to_string())?;
            if kind != slot {
                return Err(format!("{id} does not fit the {slot} slot."));
            }
            set_equipped(c, slot, id)?;
        }
    }
    state_with(c, day)
}

/// Result of the Monday payout check.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyPayout {
    /// ISO week key of the paid week, "2026-W46".
    pub week: String,
    /// Overall rank in that week (1..3).
    pub rank: i64,
    pub coins: i64,
    pub state: EconomyState,
}

/// "2026-W47": four digits, "-W", two digits 01..53.
fn valid_week_key(key: &str) -> bool {
    let b = key.as_bytes();
    b.len() == 8
        && b[..4].iter().all(u8::is_ascii_digit)
        && &b[4..6] == b"-W"
        && b[6..].iter().all(u8::is_ascii_digit)
        && matches!(key[6..].parse::<u32>(), Ok(1..=53))
}

/// Pay the Monday payout for `week` (last week's key from `GET /v1/me`) when the player finished
/// rank 1, 2 or 3 there. Exactly once per week: the claim is stored in `econ_meta` as
/// `weekly_payout:<week>` in the same transaction as the ledger row ("weekly-payout").
/// Returns None when nothing is due (no top three rank, or this week was paid already).
pub fn claim_weekly_payout_with(c: &Connection, day: &str, week: &str, rank: Option<i64>) -> Result<Option<WeeklyPayout>, String> {
    if !valid_week_key(week) {
        return Err(format!("Unknown week: {week}"));
    }
    let Some(rank) = rank.filter(|r| (1..=3).contains(r)) else { return Ok(None) };
    let key = format!("weekly_payout:{week}");
    if meta(c, &key)?.is_some() {
        return Ok(None);
    }
    let coins = WEEKLY_PAYOUT[(rank - 1) as usize];
    post(c, "weekly-payout", coins, &format!("{week} rank {rank}"))?;
    set_meta(c, &key, &coins.to_string())?;
    Ok(Some(WeeklyPayout { week: week.into(), rank, coins, state: state_with(c, day)? }))
}

/// Called by `leaderboard::claim_weekly_payout` after it read `lastWeek` from the server.
pub fn claim_weekly_payout(week: &str, rank: Option<i64>) -> Result<Option<WeeklyPayout>, String> {
    tx(|c, day| claim_weekly_payout_with(c, day, week, rank))
}

/// Everything of the economy for the data export: balance, ledger, inventory, equipped items,
/// rank, titles and box state. Holds no leaderboard data (the token lives in leaderboard.json).
pub fn export_with(c: &Connection, day: &str) -> Result<serde_json::Value, String> {
    let s = state_with(c, day)?;
    let ledger = {
        let mut stmt = sql(c.prepare("SELECT created_at, reason, amount, balance_after, detail FROM econ_ledger ORDER BY id"))?;
        let rows = sql(stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "createdAt": r.get::<_, i64>(0)?,
                "reason": r.get::<_, String>(1)?,
                "amount": r.get::<_, i64>(2)?,
                "balanceAfter": r.get::<_, i64>(3)?,
                "detail": r.get::<_, String>(4)?,
            }))
        }))?;
        let mut v = vec![];
        for row in rows {
            v.push(sql(row)?);
        }
        v
    };
    let titles: Vec<&str> = s.inventory.iter().filter(|i| i.kind == ItemKind::Title.as_str()).map(|i| i.item_id.as_str()).collect();
    Ok(serde_json::json!({
        "balance": s.balance,
        "rank": s.rank,
        "titles": titles,
        "equipped": s.equipped,
        "inventory": s.inventory,
        "boxes": s.boxes,
        "streak": s.streak,
        "ledger": ledger,
    }))
}

/// The economy part of `db::export_json`.
pub fn export_value() -> Result<serde_json::Value, String> {
    tx(export_with)
}

// ---------------------------------------------------------------- developer helpers (debug builds and tests only)

#[cfg(any(debug_assertions, test))]
mod dev {
    use super::*;

    pub fn set_unlimited(c: &Connection, day: &str, on: bool) -> Result<EconomyState, String> {
        sql(c.execute("UPDATE econ_wallet SET unlimited = ?1 WHERE id = 1", params![on as i64]))?;
        state_with(c, day)
    }

    pub fn add_coins(c: &Connection, day: &str, amount: i64) -> Result<EconomyState, String> {
        post(c, "dev", amount, "developer coins")?;
        state_with(c, day)
    }

    /// Exactly enough RP for the next division (or tier).
    pub fn rank_up(c: &Connection, day: &str) -> Result<RankUpResult, String> {
        let (tier, _, rp, _) = rank_row(c)?;
        if tier >= CHAMPION {
            return Err("Already Champion.".into());
        }
        let promotions = add_rp(c, RP_PER_DIVISION - rp)?;
        Ok(RankUpResult { promotions, state: state_with(c, day)? })
    }

    pub fn grant_keys(c: &Connection, day: &str, box_id: &str, count: i64) -> Result<EconomyState, String> {
        add_keys(c, box_id, count)?;
        state_with(c, day)
    }

    pub fn reset(c: &Connection, day: &str) -> Result<EconomyState, String> {
        sql(c.execute_batch(
            "DROP TABLE IF EXISTS econ_wallet; DROP TABLE IF EXISTS econ_ledger; DROP TABLE IF EXISTS econ_inventory;
             DROP TABLE IF EXISTS econ_equipped; DROP TABLE IF EXISTS econ_rank; DROP TABLE IF EXISTS econ_boxes;
             DROP TABLE IF EXISTS econ_daily; DROP TABLE IF EXISTS econ_meta;",
        ))?;
        init_schema(c)?;
        state_with(c, day)
    }
}

// ---------------------------------------------------------------- app entry points

/// Run `f` in one transaction on the app database.
fn tx<T>(f: impl FnOnce(&Connection, &str) -> Result<T, String>) -> Result<T, String> {
    crate::db::with_conn(|c| {
        let t = sql(c.transaction())?;
        let out = f(&t, &today())?;
        sql(t.commit())?;
        Ok(out)
    })
}

/// Called off the dictation thread after a dictation was saved.
pub fn record_dictation(words: i64) -> Result<DictationAward, String> {
    let prev = (chrono::Local::now().date_naive() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    tx(|c, day| award_dictation_with(c, day, &prev, words))
}

/// Fire and forget from the pipeline: never blocks the dictation, emits the new state.
pub fn on_dictation_saved(words: i64) {
    std::thread::spawn(move || match record_dictation(words) {
        Ok(award) => {
            // Leaderboard outbox (no-op unless the player joined).
            crate::leaderboard::on_dictation(words, award.rp);
            if let Some(app) = crate::pipeline::app_handle() {
                use tauri::Emitter;
                let _ = app.emit(EV_ECONOMY_CHANGED, &award.state);
            }
        }
        Err(e) => {
            crate::leaderboard::on_dictation(words, 0);
            log::warn!("dictation reward failed: {e}");
        }
    });
}

#[tauri::command]
pub fn economy_state() -> Result<EconomyState, String> {
    tx(state_with)
}

/// `game`: "tower" | "snake" | "comet". `quit`: the player left mid round.
#[tauri::command]
pub fn economy_award_game(game: String, score: i64, new_best: bool, quit: bool) -> Result<GameAward, String> {
    let award = tx(|c, day| award_game_with(c, day, &game, score, new_best, quit))?;
    // Leaderboard outbox and background sync (no-op unless the player joined, never blocks).
    crate::leaderboard::on_game(&award.game, award.score, award.rp);
    Ok(award)
}

#[tauri::command]
pub fn economy_buy(item_id: String) -> Result<EconomyState, String> {
    tx(|c, day| buy_with(c, day, &item_id))
}

/// Opens a box with a key if there is one, else pays its price.
#[tauri::command]
pub fn economy_open_box(box_id: String) -> Result<BoxOpening, String> {
    let (x, pick) = (random_unit() * 100.0, random_index(1 << 16));
    tx(|c, day| open_box_with(c, day, &box_id, x, pick))
}

#[tauri::command]
pub fn economy_equip(slot: String, item_id: Option<String>) -> Result<EconomyState, String> {
    let state = tx(|c, day| equip_with(c, day, &slot, item_id.as_deref()))?;
    if slot == "title" {
        crate::leaderboard::on_profile_changed();
    }
    if slot == "pill" {
        crate::pill::set_skin(state.equipped.get("pill").map(String::as_str));
    }
    Ok(state)
}

/// The equipped pill skin item id, if any.
pub fn equipped_pill_with(c: &Connection) -> Result<Option<String>, String> {
    sql(c
        .query_row("SELECT item_id FROM econ_equipped WHERE slot = 'pill'", [], |r| r.get(0))
        .optional())
}

/// Pushes the equipped pill skin into the pill's cache. Called once at
/// startup and after a reset; equipping updates the cache directly.
pub fn sync_pill_skin() {
    match crate::db::with_conn(|c| equipped_pill_with(c)) {
        Ok(skin) => crate::pill::set_skin(skin.as_deref()),
        Err(e) => log::warn!("pill skin could not be read: {e}"),
    }
}

#[tauri::command]
pub fn economy_dev_set_unlimited(on: bool) -> Result<EconomyState, String> {
    #[cfg(debug_assertions)]
    {
        tx(|c, day| dev::set_unlimited(c, day, on))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = on;
        Err(DEV_ONLY.into())
    }
}

#[tauri::command]
pub fn economy_dev_add_coins(amount: i64) -> Result<EconomyState, String> {
    #[cfg(debug_assertions)]
    {
        tx(|c, day| dev::add_coins(c, day, amount))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = amount;
        Err(DEV_ONLY.into())
    }
}

#[tauri::command]
pub fn economy_dev_rank_up() -> Result<RankUpResult, String> {
    #[cfg(debug_assertions)]
    {
        tx(dev::rank_up)
    }
    #[cfg(not(debug_assertions))]
    {
        Err(DEV_ONLY.into())
    }
}

#[tauri::command]
pub fn economy_dev_grant_keys(box_id: String, count: i64) -> Result<EconomyState, String> {
    #[cfg(debug_assertions)]
    {
        tx(|c, day| dev::grant_keys(c, day, &box_id, count))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (box_id, count);
        Err(DEV_ONLY.into())
    }
}

#[tauri::command]
pub fn economy_dev_reset() -> Result<EconomyState, String> {
    #[cfg(debug_assertions)]
    {
        let state = tx(dev::reset)?;
        crate::pill::set_skin(state.equipped.get("pill").map(String::as_str));
        Ok(state)
    }
    #[cfg(not(debug_assertions))]
    {
        Err(DEV_ONLY.into())
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    const D: &str = "2026-11-18";
    const D_PREV: &str = "2026-11-17";

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    fn ledger_sum(c: &Connection) -> i64 {
        c.query_row("SELECT COALESCE(SUM(amount), 0) FROM econ_ledger", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn round_coin_formulas_cap_at_thirty_five() {
        // Pixel Tower: 1 coin per 2 floors. Weak 12, good 48, great 70 floors.
        assert_eq!((round_coins("tower", 12), round_coins("tower", 48), round_coins("tower", 70)), (7, 28, 35));
        assert_eq!(round_coins("tower", 1), 0);
        // Voice Snake: 1 coin per apple. Weak 6, good 22, great 40.
        assert_eq!((round_coins("snake", 6), round_coins("snake", 22), round_coins("snake", 40)), (7, 25, 35));
        assert_eq!(round_coins("snake", 0), 0);
        // Comet Keeper: 1 coin per 375 points. Weak 3,000, good 9,115, great 15,000.
        assert_eq!((round_coins("comet", 3000), round_coins("comet", 9115), round_coins("comet", 15_000)), (9, 28, 35));
        assert_eq!(round_coins("comet", 150_000), 35);
        assert_eq!(round_coins("tower", -5), 0);
        assert_eq!((round_base("tower", 70), round_base("comet", 150_000)), (30, 30));
    }

    /// RP stay on the old coin formulas (max 10 base coins), whatever the coins pay now.
    #[test]
    fn round_rp_is_unchanged_by_the_coin_formulas() {
        let rp = |g: &str, s: i64, best: bool| round_rp(round_rp_base(g, s), best);
        assert_eq!((rp("tower", 61, false), rp("tower", 35, false), rp("tower", 6, false), rp("tower", 5, false)), (12, 6, 4, 0));
        assert_eq!((rp("snake", 24, false), rp("snake", 30, false), rp("snake", 300, true), rp("snake", 2, false)), (10, 12, 18, 0));
        assert_eq!((rp("comet", 9800, false), rp("comet", 9115, false), rp("comet", 150_000, false), rp("comet", 999, false)), (11, 11, 12, 0));
        assert_eq!(round_rp_base("tower", 61), 10);
        assert_eq!(round_rp_base("comet", 9115), 9);
        // A round paying 35 coins gives the same RP as before: 12, not 42.
        let c = db();
        let a = award_game_with(&c, D, "tower", 70, false, false).unwrap();
        assert_eq!((a.coins, a.rp), (35, 12));
        let b = award_game_with(&c, D, "comet", 9115, false, false).unwrap();
        assert_eq!((b.coins, b.rp), (28, 11));
    }

    /// The multiplier is applied in every earning place, and only there.
    #[test]
    fn earn_boost_is_applied_everywhere_it_should() {
        // The helper: half up, never below the input.
        assert_eq!((boost(0), boost(1), boost(5), boost(10), boost(15), boost(30), boost(50), boost(60), boost(217)), (0, 1, 6, 12, 17, 35, 58, 69, 250));
        for n in 0..500 {
            assert!(boost(n) >= n);
        }
        // Constants and tables.
        assert_eq!((GAME_COIN_CAP, ROUND_COIN_MAX, BEST_BONUS, WORDS_COINS, DIVISION_COINS), (250, 35, 17, 6, 58));
        assert_eq!(WEEKLY_PAYOUT, [173, 115, 69]);
        assert_eq!(TIERS.iter().map(|t| t.coins).collect::<Vec<_>>(), vec![0, 230, 460, 690, 1035, 1380, 2300]);
        // Dictation: day bonus with streak, words.
        assert_eq!((day_coins(1), day_coins(2), day_coins(6), day_coins(40)), (12, 14, 23, 23));
        let c = db();
        let d = award_dictation_with(&c, D, D_PREV, 1000).unwrap();
        assert_eq!((d.day_coins, d.words_coins), (12, 6));
        assert_eq!(d.rp, 5 + 3, "RP stay on the base values");
        // Game round, best bonus.
        let g = award_game_with(&c, D, "tower", 61, true, false).unwrap();
        assert_eq!((g.base_coins, g.coins, g.best_bonus, g.rp), (35, 35, 17, 18));
        // Rank rewards: division up and tier promotion.
        let p = add_rp(&c, 100).unwrap();
        assert_eq!(p[0].coins, 58);
        add_rp(&c, 100).unwrap();
        let p = add_rp(&c, 100).unwrap();
        assert_eq!((p[0].kind.as_str(), p[0].coins), ("tier", 230));
        // Monday payout.
        let w = claim_weekly_payout_with(&c, D, "2026-W46", Some(1)).unwrap().unwrap();
        assert_eq!(w.coins, 173);
        // Reported rates mirror the same values.
        let r = state_with(&c, D).unwrap().earn_rates;
        assert_eq!((r.boost_percent, r.day_coins, r.day_coins_max, r.words_coins, r.round_coin_max, r.best_bonus, r.division_coins), (115, 12, 23, 6, 35, 17, 58));
        assert_eq!(r.next_day_coins, day_coins(2));
        assert_eq!(r.tier_coins, vec![0, 230, 460, 690, 1035, 1380, 2300]);
        assert_eq!(r.weekly_payout, vec![173, 115, 69]);
        // Not boosted: refunds and prices.
        assert_eq!((Rarity::Common.refund(), Rarity::Legendary.refund()), (40, 750));
        assert_eq!(shop_item("pill-mint").unwrap().price, 350);
        assert_eq!(box_def("basic").unwrap().price, 200);
        let rp = round_rp(10, false);
        assert_eq!(rp, 12);
    }

    #[test]
    fn rp_is_about_1_2_times_coins_plus_best() {
        assert_eq!(round_rp(10, false), 12);
        assert_eq!(round_rp(1, false), 4);
        assert_eq!(round_rp(0, false), 0);
        assert_eq!(round_rp(0, true), 6);
        assert_eq!(round_rp(8, true), 10 + 6);
    }

    #[test]
    fn game_award_pays_base_and_best_bonus() {
        let c = db();
        let a = award_game_with(&c, D, "tower", 61, true, false).unwrap();
        assert_eq!((a.base_coins, a.coins, a.best_bonus, a.total, a.rp), (35, 35, 17, 52, 18));
        assert!(!a.daily_cap_hit && !a.best_cap_hit);
        assert_eq!(a.state.balance, 52);
        assert_eq!(ledger_sum(&c), 52);
    }

    #[test]
    fn game_coins_cap_at_two_hundred_fifty_a_day() {
        assert_eq!(GAME_COIN_CAP, 250);
        let c = db();
        for _ in 0..7 {
            award_game_with(&c, D, "tower", 70, false, false).unwrap(); // 35 each, 245
        }
        let a = award_game_with(&c, D, "tower", 70, true, false).unwrap(); // 5 room left
        assert_eq!((a.coins, a.best_bonus), (5, 0));
        assert!(a.daily_cap_hit);
        let b = award_game_with(&c, D, "snake", 30, false, false).unwrap();
        assert_eq!(b.total, 0);
        assert!(b.daily_cap_hit);
        assert_eq!(b.rp, 12, "RP keep coming after the coin cap");
        assert_eq!(b.state.today.game_coins, 250);
        // a new day starts over
        let n = award_game_with(&c, "2026-11-19", "tower", 70, false, false).unwrap();
        assert_eq!(n.coins, 35);
    }

    #[test]
    fn best_bonus_three_times_a_day() {
        let c = db();
        for i in 0..3 {
            let a = award_game_with(&c, D, "snake", 3, true, false).unwrap();
            assert_eq!(a.best_bonus, 17, "best {i}");
        }
        let a = award_game_with(&c, D, "snake", 3, true, false).unwrap();
        assert_eq!(a.best_bonus, 0);
        assert!(a.best_cap_hit);
        assert_eq!(a.rp, 4 + 6, "the best still earns RP");
    }

    #[test]
    fn best_with_zero_score_does_not_count() {
        let c = db();
        let a = award_game_with(&c, D, "comet", 0, true, true).unwrap();
        assert_eq!((a.total, a.rp, a.new_best), (0, 0, false));
    }

    #[test]
    fn unknown_game_is_rejected() {
        assert!(award_game_with(&db(), D, "pong", 10, false, false).is_err());
    }

    #[test]
    fn divisions_and_tiers_pay_their_rewards() {
        let c = db();
        let p = add_rp(&c, 100).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].kind.as_str(), p[0].division, p[0].coins), ("division", Some(1), 58));
        let p = add_rp(&c, 100).unwrap(); // Bronze III
        assert_eq!(p[0].division, Some(2));
        let p = add_rp(&c, 130).unwrap(); // Silver I with 30 RP
        assert_eq!(p[0].kind, "tier");
        assert_eq!((p[0].tier_name.as_str(), p[0].coins, p[0].box_key.as_deref()), ("Silver", 230, Some("basic")));
        let s = state_with(&c, D).unwrap();
        assert_eq!((s.rank.tier, s.rank.division, s.rank.rp, s.rank.total_rp), (1, Some(0), 30, 330));
        assert_eq!(s.balance, 58 + 58 + 230);
        assert_eq!(s.boxes.iter().find(|b| b.id == "basic").unwrap().keys, 1);
    }

    #[test]
    fn many_rp_cross_several_divisions_at_once() {
        let c = db();
        let p = add_rp(&c, 350).unwrap();
        assert_eq!(p.len(), 3);
        assert_eq!(p[2].tier_name, "Silver");
    }

    #[test]
    fn champion_has_no_division_and_gets_the_title() {
        let c = db();
        let p = add_rp(&c, 18 * 100).unwrap(); // 6 tiers x 3 divisions
        let last = p.last().unwrap();
        assert_eq!((last.tier_name.as_str(), last.division, last.title.as_deref()), ("Champion", None, Some("Champion")));
        let s = state_with(&c, D).unwrap();
        assert_eq!(s.rank.division, None);
        assert_eq!(s.equipped.get("title").map(String::as_str), Some("Champion"));
        assert!(s.inventory.iter().any(|i| i.item_id == "Champion"));
        let keys: i64 = s.boxes.iter().map(|b| b.keys).sum();
        assert_eq!(keys, 5, "silver, gold, platinum, diamond, master each give one key");
        // RP keep growing at Champion, no more promotions
        assert!(add_rp(&c, 500).unwrap().is_empty());
        assert_eq!(state_with(&c, D).unwrap().rank.rp, 500);
        let expected: i64 = TIERS.iter().map(|t| t.coins).sum::<i64>() + 6 * 2 * DIVISION_COINS;
        assert_eq!(state_with(&c, D).unwrap().balance, expected);
    }

    #[test]
    fn dictation_day_bonus_grows_with_the_streak() {
        let c = db();
        let a = award_dictation_with(&c, D_PREV, "2026-11-16", 10).unwrap();
        assert_eq!(a.day_coins, 12);
        let again = award_dictation_with(&c, D_PREV, "2026-11-16", 10).unwrap();
        assert_eq!(again.day_coins, 0, "only the first dictation of a day");
        let b = award_dictation_with(&c, D, D_PREV, 10).unwrap();
        assert_eq!((b.day_coins, b.state.streak), (14, 2));
        // a gap resets the streak
        let g = award_dictation_with(&c, "2026-11-25", "2026-11-24", 10).unwrap();
        assert_eq!((g.day_coins, g.state.streak), (12, 1));
        assert_eq!(day_coins(6), 23);
        assert_eq!(day_coins(40), 23);
    }

    #[test]
    fn every_thousand_words_pays_six() {
        let c = db();
        award_dictation_with(&c, D, D_PREV, 600).unwrap();
        let a = award_dictation_with(&c, D, D_PREV, 900).unwrap();
        assert_eq!((a.words_coins, a.state.words_toward_next), (6, 500));
        let b = award_dictation_with(&c, D, D_PREV, 2600).unwrap();
        assert_eq!((b.words_coins, b.state.words_toward_next), (18, 100));
    }

    #[test]
    fn buying_needs_coins_and_only_once() {
        let c = db();
        assert!(buy_with(&c, D, "pill-mint").is_err());
        post(&c, "dev", 1000, "").unwrap();
        let s = buy_with(&c, D, "pill-mint").unwrap();
        assert_eq!(s.balance, 650);
        assert!(buy_with(&c, D, "pill-mint").is_err());
        assert!(buy_with(&c, D, "nope").is_err());
        let s = equip_with(&c, D, "pill", Some("pill-mint")).unwrap();
        assert_eq!(s.equipped.get("pill").map(String::as_str), Some("pill-mint"));
        assert_eq!(equipped_pill_with(&c).unwrap().as_deref(), Some("pill-mint"));
        assert!(crate::pill::skin_accent(equipped_pill_with(&c).unwrap().as_deref()).is_some());
        assert!(equip_with(&c, D, "theme", Some("pill-mint")).is_err());
        assert!(equip_with(&c, D, "theme", Some("horizon")).is_err());
        let s = equip_with(&c, D, "pill", None).unwrap();
        assert!(s.equipped.get("pill").is_none());
        assert_eq!(equipped_pill_with(&c).unwrap(), None);
    }

    #[test]
    fn profile_picture_unlock_costs_ten_thousand() {
        let c = db();
        post(&c, "dev", 9999, "").unwrap();
        assert!(buy_with(&c, D, PROFILE_PICTURE_ID).is_err());
        post(&c, "dev", 1, "").unwrap();
        assert_eq!(buy_with(&c, D, PROFILE_PICTURE_ID).unwrap().balance, 0);
    }

    #[test]
    fn unlimited_coins_keep_the_balance() {
        let c = db();
        dev::set_unlimited(&c, D, true).unwrap();
        let s = buy_with(&c, D, "horizon").unwrap();
        assert_eq!(s.balance, 0);
        assert!(s.unlimited);
        assert_eq!(ledger_sum(&c), 0);
    }

    #[test]
    fn boxes_use_keys_first_and_refund_duplicates() {
        let c = db();
        add_keys(&c, "basic", 1).unwrap();
        let a = open_box_with(&c, D, "basic", 0.0, 0).unwrap(); // common, first title
        assert!(a.used_key && a.is_new);
        assert_eq!((a.rarity.as_str(), a.title.as_str()), ("common", "Talker"));
        assert!(open_box_with(&c, D, "basic", 0.0, 0).is_err(), "no key, no coins");
        post(&c, "dev", 200, "").unwrap();
        let b = open_box_with(&c, D, "basic", 0.0, 0).unwrap();
        assert!(!b.used_key && !b.is_new);
        assert_eq!((b.refund, b.state.balance), (40, 40));
    }

    #[test]
    fn mythic_pity_guarantees_a_legendary() {
        let c = db();
        add_keys(&c, "mythic", 20).unwrap();
        for i in 0..7 {
            let o = open_box_with(&c, D, "mythic", 0.0, i).unwrap(); // x = 0 is always rare
            assert_eq!(o.rarity, "rare");
        }
        let o = open_box_with(&c, D, "mythic", 0.0, 0).unwrap();
        assert_eq!((o.rarity.as_str(), o.pity_hit), ("legendary", true));
        let m = o.state.boxes.iter().find(|b| b.id == "mythic").unwrap();
        assert_eq!((m.since_legendary, m.opened, m.keys), (0, 8, 12));
        // natural legendary at the top of the odds also resets the counter
        let o = open_box_with(&c, D, "mythic", 99.9, 0).unwrap();
        assert_eq!((o.rarity.as_str(), o.pity_hit), ("legendary", false));
    }

    #[test]
    fn odds_add_up_and_titles_are_unique() {
        for b in &BOXES {
            let sum: f64 = b.odds.iter().map(|o| o.1).sum();
            assert!((sum - 100.0).abs() < 1e-9, "{}", b.id);
        }
        let mut all: Vec<&str> = [&TITLES_COMMON[..], &TITLES_RARE[..], &TITLES_EPIC[..], &TITLES_LEGENDARY[..]].concat();
        let n = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), n);
        assert_eq!(title_rarity("Supernova"), Some(Rarity::Legendary));
        assert_eq!(title_rarity("Champion"), None);
    }

    #[test]
    fn random_unit_stays_in_range() {
        for _ in 0..1000 {
            let x = random_unit();
            assert!((0.0..1.0).contains(&x));
        }
        assert!(random_index(5) < 5);
    }

    #[test]
    fn dev_rank_up_and_reset() {
        let c = db();
        let r = dev::rank_up(&c, D).unwrap();
        assert_eq!(r.promotions.len(), 1);
        assert_eq!(r.state.rank.division, Some(1));
        dev::add_coins(&c, D, 10_000).unwrap();
        dev::grant_keys(&c, D, "mythic", 2).unwrap();
        let s = dev::reset(&c, D).unwrap();
        assert_eq!((s.balance, s.rank.tier, s.rank.rp), (0, 0, 0));
        assert!(s.boxes.iter().all(|b| b.keys == 0));
        assert!(dev::grant_keys(&c, D, "golden", 1).is_err());
    }

    #[test]
    fn week_starts_monday_midnight_utc() {
        // 2026-11-18 (Wednesday) 15:30 UTC -> Monday 2026-11-16 00:00 UTC.
        assert_eq!(week_start_ms(1_795_015_800_000), 1_794_787_200_000);
        // Monday 00:00 exactly is its own week start, one ms earlier is the week before.
        assert_eq!(week_start_ms(1_794_787_200_000), 1_794_787_200_000);
        assert_eq!(week_start_ms(1_794_787_199_999), 1_794_787_200_000 - 7 * DAY_MS);
        // Sunday 23:59:59.999 belongs to the week that began six days earlier.
        assert_eq!(week_start_ms(1_795_391_999_999), 1_794_787_200_000);
        assert_eq!(week_start_ms(0), -3 * DAY_MS, "1970-01-01 was a Thursday");
    }

    #[test]
    fn week_earned_counts_from_monday_only() {
        let c = db();
        let monday = week_start_ms(now_ms());
        let row = |at: i64, reason: &str, amount: i64| {
            c.execute(
                "INSERT INTO econ_ledger (created_at, reason, amount, balance_after, detail) VALUES (?1, ?2, ?3, 0, '')",
                params![at, reason, amount],
            )
            .unwrap();
        };
        row(monday - 1, "game", 10); // last week, Sunday 23:59:59.999 UTC
        row(monday, "game", 7);
        row(monday + 1000, "weekly-payout", 150);
        row(monday + 2000, "refund", 40);
        row(monday + 3000, "dev", 1000);
        row(monday + 4000, "buy", -200);
        assert_eq!(week_earned(&c).unwrap(), 157);
    }

    #[test]
    fn weekly_payout_is_paid_once_per_week() {
        let c = db();
        let p = claim_weekly_payout_with(&c, D, "2026-W46", Some(1)).unwrap().unwrap();
        assert_eq!((p.coins, p.rank, p.state.balance), (173, 1, 173));
        // Same week again (app start, then the Games page): nothing more.
        assert!(claim_weekly_payout_with(&c, D, "2026-W46", Some(1)).unwrap().is_none());
        assert!(claim_weekly_payout_with(&c, D, "2026-W46", Some(2)).unwrap().is_none());
        // A new week pays again, by rank.
        assert_eq!(claim_weekly_payout_with(&c, D, "2026-W47", Some(2)).unwrap().unwrap().coins, 115);
        assert_eq!(claim_weekly_payout_with(&c, D, "2026-W48", Some(3)).unwrap().unwrap().coins, 69);
        // Rank 4 or no rank: nothing.
        assert!(claim_weekly_payout_with(&c, D, "2026-W49", Some(4)).unwrap().is_none());
        assert!(claim_weekly_payout_with(&c, D, "2026-W49", None).unwrap().is_none());
        assert!(claim_weekly_payout_with(&c, D, "2026-W49", Some(0)).unwrap().is_none());
        assert!(claim_weekly_payout_with(&c, D, "bogus", Some(1)).is_err());
        assert!(claim_weekly_payout_with(&c, D, "2026-W54", Some(1)).is_err());
        let s = state_with(&c, D).unwrap();
        assert_eq!(s.balance, 357);
        assert_eq!(ledger_sum(&c), 357);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM econ_ledger WHERE reason = 'weekly-payout'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn export_holds_balance_ledger_items_rank_and_titles() {
        let c = db();
        post(&c, "dev", 500, "").unwrap();
        add_keys(&c, "basic", 1).unwrap();
        let o = open_box_with(&c, D, "basic", 0.0, 3).unwrap();
        buy_with(&c, D, "pill-mint").unwrap();
        let v = export_with(&c, D).unwrap();
        assert_eq!(v["balance"], 150);
        assert_eq!(v["ledger"].as_array().unwrap().len(), 3);
        assert_eq!(v["titles"][0], o.title.as_str());
        assert!(v["inventory"].as_array().unwrap().iter().any(|i| i["itemId"] == "pill-mint"));
        assert_eq!(v["rank"]["tierName"], "Bronze");
        let text = v.to_string();
        assert!(!text.contains("token") && !text.contains("spk_"));
    }

    #[test]
    fn ledger_matches_balance() {
        let c = db();
        award_game_with(&c, D, "tower", 40, true, false).unwrap();
        award_dictation_with(&c, D, D_PREV, 3200).unwrap();
        add_rp(&c, 400).unwrap();
        post(&c, "dev", 1000, "").unwrap();
        buy_with(&c, D, "snake-neon").unwrap();
        assert_eq!(ledger_sum(&c), state_with(&c, D).unwrap().balance);
    }
}
