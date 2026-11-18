// Guarded link to the premium themes module (src/themes/premium/index.ts, built separately).
// import.meta.glob resolves to an empty map while that module does not exist yet, so the shop
// builds and runs without it and shows static placeholder cards instead.
import type { ComponentType } from "react";

export interface PremiumThemeInfo { id: string; name: string; line: string; itemId: string }

export interface PremiumModule {
  PREMIUM_THEMES: PremiumThemeInfo[];
  startThemePreview: (id: string) => void;
  stopThemePreview: () => void;
  ThemeCardPreview: ComponentType<{ id: string }>;
}

const found = import.meta.glob<PremiumModule>("../../../themes/premium/index.{ts,tsx}");
const loader = Object.values(found)[0] as (() => Promise<PremiumModule>) | undefined;

let cached: Promise<PremiumModule | null> | null = null;

/** The premium module, or null when it is not there (or fails to load). */
export function loadPremium(): Promise<PremiumModule | null> {
  if (!cached) {
    cached = loader
      ? loader().then((m) => (m && Array.isArray(m.PREMIUM_THEMES) ? m : null)).catch(() => null)
      : Promise.resolve(null);
  }
  return cached;
}

/** Shop fallback while the module is missing. Order: the newest showpiece first. */
export const PREMIUM_FALLBACK: PremiumThemeInfo[] = [
  { id: "horizon", itemId: "horizon", name: "Event Horizon", line: "A black hole in ASCII. The disk spins up and burns brighter while you dictate." },
  { id: "genesis", itemId: "genesis", name: "Genesis", line: "The two hands from the Creation of Adam, in ASCII, with AI logos turning in 3D between them." },
  { id: "bloom", itemId: "bloom", name: "Bloom", line: "A rose grows from the ground in the corner. Once it opens, petals drift across the whole screen." },
];
