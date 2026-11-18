// Public surface of the premium themes (Bloom, Genesis, Event Horizon), used by Settings > Themes and
// the shop in Games. Only light code here: the field engine and its art load lazily.
//
//   PREMIUM_THEMES            id, name, line, itemId (shop item in economy.rs)
//   startThemePreview(id)     show a theme on the whole app without saving it
//   stopThemePreview()        back to the saved theme
//   ThemeCardPreview({ id })  live canvas for a card; fills its parent, pauses off screen
import { setThemePreview } from "../preview";
import { isThemeId } from "../registry";
import { premiumById } from "./catalog";

export { PREMIUM_THEMES, premiumById, type PremiumTheme, type PremiumThemeId } from "./catalog";
export { default as ThemeCardPreview } from "./ThemeCardPreview";
export { usePreviewTheme } from "../preview";

/** Apply a theme (any registry id, premium or not) to the whole app until stopThemePreview().
 *  Nothing is saved; ownership is not checked, previews are free. */
export function startThemePreview(id: string): void {
  if (!isThemeId(id)) return;
  setThemePreview(id);
  // Warm the engine chunk so the field appears without a gap.
  if (premiumById(id)) void import("./engine").catch(() => {});
}

/** End a preview; the saved theme (settings.theme) shows again. Safe to call when none runs. */
export function stopThemePreview(): void {
  setThemePreview(null);
}
