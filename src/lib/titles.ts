// The 120 collectable titles by rarity. Mirrors TITLES_* in src-tauri/src/economy.rs (single source of truth);
// the item id of a title is its name. "Champion" is the rank-only title and has no rarity.
import type { TitleRarity } from "./ipc";

const COMMON: string[] = [
  "Talker", "Note Taker", "Early Bird", "Night Owl", "Coffee Fueled", "Inbox Zero", "Quick Draft", "Daydreamer", "Mumbler", "Chatterbox",
  "Rambler", "Thinker", "Desk Pilot", "Lunch Break Hero", "Sticky Note", "Plain Speaker", "Small Talker", "Snack Break", "Keyboard Retiree", "First Draft",
  "Voice Memo", "Typo Hunter", "Comma Fan", "Backspacer", "Mic Check", "Loud Thinker", "Spell Checker", "Autocorrected", "Tab Hoarder", "Late Riser",
  "Couch Writer", "Desk Plant", "Muted Mic", "Quiet Hour", "Pixel Stacker", "Snake Rookie", "Comet Spotter", "Ctrl Z", "Word Counter", "Bullet Pointer",
  "Draft Saver", "Hold to Talk", "Coffee Refill", "Hello World", "Long Pause", "Um Collector", "Sunday Typist", "Tea Sipper", "Power Napper", "Walk and Talk",
];
const RARE: string[] = [
  "Wordsmith", "Speedtalker", "Silver Tongue", "Echo", "Voice Actor", "Podcaster", "Storyteller", "Tower Builder", "Snake Charmer", "Comet Chaser",
  "Midnight Writer", "Prompt Smith", "Polyglot", "Narrator", "Keyboard Ninja", "Fast Fingers", "Night Typist", "Focus Mode", "Deep Worker", "Sunrise Writer",
  "Wall of Text", "Essay Machine", "Tower Climber", "Snake Wrangler", "Comet Guard", "Hotkey Hero", "Clean Copy", "Streak Keeper", "Story Spinner", "Pun Master",
  "Rubber Duck", "Sudo Speaker", "Bug Squasher", "Mic Drop", "Live Wire", "Tongue Twister", "Brainstormer", "Caps Lock Rebel",
];
const EPIC: string[] = [
  "Speedrunner", "Night Shift", "Golden Voice", "Prompt Whisperer", "Mind Reader", "Thunder Mouth", "Ghostwriter", "Orbit Keeper", "Grand Narrator", "Syntax Sage",
  "Word Wizard", "Sky Architect", "Serpent King", "Comet Warden", "Voice Conductor", "Zen Typist", "Silent Storm", "Dawn Breaker", "Lord of Drafts", "Keymaster",
  "Night Sovereign", "Mind Palace",
];
const LEGENDARY: string[] = [
  "The Oracle", "Voice of Thunder", "Infinite Monologue", "Time Bender", "Event Horizon", "The Last Word", "Eternal Echo", "Star Forger", "Keeper of Words", "Supernova",
];

export const TITLES_BY_RARITY: Record<TitleRarity, string[]> = { common: COMMON, rare: RARE, epic: EPIC, legendary: LEGENDARY };
export const RARITY_ORDER: TitleRarity[] = ["legendary", "epic", "rare", "common"];
export const RARITY_NAME: Record<TitleRarity | "rank", string> = { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary", rank: "Rank" };
export const TOTAL_TITLES = COMMON.length + RARE.length + EPIC.length + LEGENDARY.length;
export const RANK_TITLE = "Champion";

const LOOKUP = new Map<string, TitleRarity>();
for (const r of RARITY_ORDER) for (const t of TITLES_BY_RARITY[r]) LOOKUP.set(t, r);

/** "rank" for Champion, null for an unknown name. */
export function titleRarity(title: string): TitleRarity | "rank" | null {
  return title === RANK_TITLE ? "rank" : LOOKUP.get(title) ?? null;
}
