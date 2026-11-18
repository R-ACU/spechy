function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export function newPlayerId(): string {
  return "p_" + hex(crypto.getRandomValues(new Uint8Array(8)));
}

/** 256 bit random secret. Only its SHA-256 is stored; a fast hash is fine for high-entropy tokens. */
export function newToken(): string {
  return "spk_" + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Compares two secrets without leaking the position of the first difference. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
