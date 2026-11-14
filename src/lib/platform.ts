/** True in the Linux build (WebKitGTK reports the platform in the user agent). */
export const isLinux = typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent);

/** Display name of one chord key. Chords are stored with Windows names; Linux calls the Win key Super. */
export function keyLabel(key: string): string {
  if (isLinux && key === "Win") return "Super";
  return key;
}
