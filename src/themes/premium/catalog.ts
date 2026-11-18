// The three premium themes (shop items). Plain data only, so the registry, Settings and the shop can
// import it without pulling the field engine (engine.ts, its own lazy chunk) into the main bundle.
// Item ids match the catalogue in src-tauri/src/economy.rs (kind "theme", equip slot "theme").

export type PremiumThemeId = "bloom" | "genesis" | "horizon";

export interface PremiumTheme {
  id: PremiumThemeId;
  name: string;
  line: string;
  /** Shop item id in economy.rs; owning it unlocks the theme. */
  itemId: string;
}

/** Cheapest first, like the shop. */
export const PREMIUM_THEMES: PremiumTheme[] = [
  { id: "bloom", name: "Bloom", line: "A rose grows from the ground in the corner and opens petal by petal, then its petals drift across the screen.", itemId: "bloom" },
  { id: "genesis", name: "Genesis", line: "The two hands from the Creation of Adam, in ASCII. Between them Claude Code, Claude, Codex, Gemini and Grok turn in 3D.", itemId: "genesis" },
  { id: "horizon", name: "Event Horizon", line: "A black hole in ASCII. The disk spins up and burns brighter while you dictate.", itemId: "horizon" },
];

export function premiumById(id: string | null | undefined): PremiumTheme | undefined {
  return PREMIUM_THEMES.find((t) => t.id === id);
}
