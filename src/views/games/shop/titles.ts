// Box odds, rarity names and the title pools for the reel filler cards. The real roll happens in
// src-tauri/src/economy.rs; these lists only decorate the reel around the result. Keep the
// pools in sync with TITLES_* in economy.rs (the reel would only show stale names otherwise).
import type { BoxId, TitleRarity } from "../../../lib/ipc";

export const RARITIES: TitleRarity[] = ["common", "rare", "epic", "legendary"];

export const RARITY_NAME: Record<TitleRarity, string> = { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" };

/** Coins back for a duplicate (economy.rs `Rarity::refund`). */
export const REFUND: Record<TitleRarity, number> = { common: 40, rare: 120, epic: 300, legendary: 750 };

export interface BoxInfo { id: BoxId; tier: string; name: string; odds: [TitleRarity, number][] }

/** Shown odds; economy.rs `BOXES` is the truth. */
export const BOX_INFO: BoxInfo[] = [
  { id: "basic", tier: "Basic", name: "Temu box", odds: [["common", 75], ["rare", 21], ["epic", 3.5], ["legendary", 0.5]] },
  { id: "premium", tier: "Premium", name: "Amazon box", odds: [["common", 30], ["rare", 48], ["epic", 18], ["legendary", 4]] },
  { id: "mythic", tier: "Mythic", name: "DGX Spark box", odds: [["rare", 35], ["epic", 48], ["legendary", 17]] },
];

export const TITLES: Record<TitleRarity, string[]> = {
  common: [
    "Talker", "Note Taker", "Early Bird", "Night Owl", "Coffee Fueled", "Inbox Zero", "Quick Draft", "Daydreamer", "Mumbler", "Chatterbox",
    "Rambler", "Thinker", "Desk Pilot", "Lunch Break Hero", "Sticky Note", "Plain Speaker", "Small Talker", "Snack Break", "Keyboard Retiree", "First Draft",
    "Voice Memo", "Typo Hunter", "Comma Fan", "Backspacer", "Mic Check", "Loud Thinker", "Spell Checker", "Autocorrected", "Tab Hoarder", "Late Riser",
    "Couch Writer", "Desk Plant", "Muted Mic", "Quiet Hour", "Pixel Stacker", "Snake Rookie", "Comet Spotter", "Ctrl Z", "Word Counter", "Bullet Pointer",
    "Draft Saver", "Hold to Talk", "Coffee Refill", "Hello World", "Long Pause", "Um Collector", "Sunday Typist", "Tea Sipper", "Power Napper", "Walk and Talk",
  ],
  rare: [
    "Wordsmith", "Speedtalker", "Silver Tongue", "Echo", "Voice Actor", "Podcaster", "Storyteller", "Tower Builder", "Snake Charmer", "Comet Chaser",
    "Midnight Writer", "Prompt Smith", "Polyglot", "Narrator", "Keyboard Ninja", "Fast Fingers", "Night Typist", "Focus Mode", "Deep Worker", "Sunrise Writer",
    "Wall of Text", "Essay Machine", "Tower Climber", "Snake Wrangler", "Comet Guard", "Hotkey Hero", "Clean Copy", "Streak Keeper", "Story Spinner", "Pun Master",
    "Rubber Duck", "Sudo Speaker", "Bug Squasher", "Mic Drop", "Live Wire", "Tongue Twister", "Brainstormer", "Caps Lock Rebel",
  ],
  epic: [
    "Speedrunner", "Night Shift", "Golden Voice", "Prompt Whisperer", "Mind Reader", "Thunder Mouth", "Ghostwriter", "Orbit Keeper", "Grand Narrator", "Syntax Sage",
    "Word Wizard", "Sky Architect", "Serpent King", "Comet Warden", "Voice Conductor", "Zen Typist", "Silent Storm", "Dawn Breaker", "Lord of Drafts", "Keymaster",
    "Night Sovereign", "Mind Palace",
  ],
  legendary: [
    "The Oracle", "Voice of Thunder", "Infinite Monologue", "Time Bender", "Event Horizon", "The Last Word", "Eternal Echo", "Star Forger", "Keeper of Words", "Supernova",
  ],
};

export const pickTitle = (r: TitleRarity) => TITLES[r][Math.floor(Math.random() * TITLES[r].length)];

/** A rarity drawn with the box odds (presentation only). */
export function rollShown(odds: [TitleRarity, number][]): TitleRarity {
  let x = Math.random() * 100;
  for (const [r, p] of odds) if ((x -= p) < 0) return r;
  return odds[0][0];
}
