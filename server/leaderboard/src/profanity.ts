// Basic profanity filter for display names. Easy to extend: add lowercase stems to BLOCKED
// (at least 4 letters after normalizing, shorter stems match far too many names).
// Names are normalized first (lowercase, accents removed, leetspeak mapped, separators dropped),
// then checked for any stem as a substring. Keep stems specific enough to avoid false hits
// on ordinary names (the "Scunthorpe problem"), e.g. no "ass" (Cassandra) or "tit" (Titan).

export const BLOCKED: string[] = [
  // English
  // (no "dick"/"cock"/"fuk"/"nazi": they hit Dickens, Hancock, Fukuda, Nazira)
  "fuck", "shit", "bitch", "cunt", "pussy", "whore", "slut", "bastard",
  "asshole", "nigger", "nigga", "faggot", "retard", "rapist", "porn", "penis", "vagina", "wanker",
  "twat", "motherf", "jizz", "dildo", "hitler",
  // German
  "scheiss", "scheis", "fotze", "hurensohn","wichser", "schlampe", "missgeburt",
  "spast", "behindert", "schwuchtel", "arschloch", "ficken", "fick", "nutte", "kanake", "neger",
  "heilhitler", "siegheil",
];

/** Names reserved so nobody can impersonate staff or the app. */
export const RESERVED: string[] = ["admin", "administrator", "moderator", "spechy", "support", "system", "official"];

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g",
  "@": "a", "$": "s", "!": "i", "|": "i", "€": "e", "ß": "ss",
};

export function normalizeForFilter(name: string): string {
  const lowered = name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of lowered) out += LEET[ch] ?? ch;
  // drop everything that is not a letter, so "f.u.c.k" and "f u c k" are caught
  out = out.replace(/[^\p{L}]/gu, "");
  // collapse runs of the same letter ("fuuuck" -> "fuck")
  return out.replace(/(\p{L})\1+/gu, "$1");
}

export function containsProfanity(name: string): boolean {
  const n = normalizeForFilter(name);
  return BLOCKED.some((stem) => n.includes(normalizeForFilter(stem)));
}

export function isReserved(name: string): boolean {
  const n = normalizeForFilter(name);
  return RESERVED.some((r) => n === normalizeForFilter(r));
}
