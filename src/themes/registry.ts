// Theme catalogue. Every theme resolves to a base palette (data-theme="light|dark", which the
// tokens in styles.css key on) plus data-skin="<id>", which src/themes/themes.css keys on.
// Premium themes (shop items, see premium/catalog.ts) carry the item id that unlocks them.
// Heavy backdrops are loaded with a dynamic import so they land in their own chunk.

import { PREMIUM_THEMES, type PremiumThemeId } from "./premium/catalog";

export type ThemeBase = "light" | "dark" | "system";
export type BackdropId = "glyph" | "dot" | PremiumThemeId;

export interface ThemeDef {
  id: string;
  name: string;
  line: string;
  base: ThemeBase;
  /** Animated field inside the content panel, loaded lazily by ThemeLayer. */
  backdrop?: BackdropId;
  /** Shop item id; the theme is locked in Settings until this item is owned. */
  itemId?: string;
}

export const THEMES: ThemeDef[] = [
  { id: "system", name: "System", line: "Follows your system light or dark setting.", base: "system" },
  { id: "light", name: "Light", line: "Warm paper white.", base: "light" },
  { id: "dark", name: "Dark", line: "Warm charcoal.", base: "dark" },
  { id: "halftone", name: "Halftone", line: "Ink black with a flowing dot field, one blue accent.", base: "dark", backdrop: "dot" },
  { id: "ascii", name: "ASCII", line: "Near black with drifting character waves.", base: "dark", backdrop: "glyph" },
  { id: "oled", name: "OLED", line: "Pure black, quiet grey surfaces.", base: "dark" },
  ...PREMIUM_THEMES.map((p): ThemeDef => ({ id: p.id, name: p.name, line: p.line, base: "dark", backdrop: p.id, itemId: p.itemId })),
];

export function themeById(id: string): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id);
}

export function isThemeId(id: string | null | undefined): id is string {
  return !!id && THEMES.some((t) => t.id === id);
}

export interface BackdropModule {
  /** Start drawing into the canvas; returns a stop function that releases everything. */
  start(canvas: HTMLCanvasElement): () => void;
}

const field = () => import("./fieldBackdrop");
const premium = (id: PremiumThemeId) => () =>
  import("./premium/engine").then((m) => ({ start: (c: HTMLCanvasElement) => { const h = m.startField(c, id, "main"); return () => h.stop(); } }));
const loaders: Record<BackdropId, () => Promise<BackdropModule>> = {
  glyph: () => field().then((m) => ({ start: (c: HTMLCanvasElement) => m.start(c, "glyph") })),
  dot: () => field().then((m) => ({ start: (c: HTMLCanvasElement) => m.start(c, "dot") })),
  bloom: premium("bloom"),
  genesis: premium("genesis"),
  horizon: premium("horizon"),
};

/** Load (or reuse) the backdrop chunk of a theme. Resolves to null for themes without one. */
export function loadBackdrop(id: string): Promise<BackdropModule | null> {
  const b = themeById(id)?.backdrop;
  return b ? loaders[b]() : Promise.resolve(null);
}
